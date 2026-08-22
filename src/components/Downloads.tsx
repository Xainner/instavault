import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Loader2,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import {
  clearFinishedJobs,
  downloadProfile,
  listDownloadJobs,
  onDownloadProgress,
} from "../lib/api";
import type { DownloadJob, DownloadProgress, Kind } from "../types";
import { useToast } from "./Toasts";

interface DlcState {
  jobs: DownloadJob[];
  live: Record<number, DownloadProgress>;
  active: number;
  refresh: () => Promise<void>;
  clearFinished: () => Promise<void>;
}

const DlcCtx = createContext<DlcState | null>(null);

export function useDownloads() {
  const c = useContext(DlcCtx);
  if (!c) throw new Error("useDownloads debe usarse dentro de DownloadProvider");
  return c;
}

const KIND_LABEL: Record<string, string> = {
  post: "Posts",
  story: "Stories",
  highlight: "Highlights",
};

export function kindLabel(k: string) {
  return KIND_LABEL[k] ?? k;
}

function fmtJobTime(t: number | null) {
  if (!t) return "—";
  return new Date(t * 1000).toLocaleString("es", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function DownloadProvider({
  children,
  onJobDone,
}: {
  children: React.ReactNode;
  onJobDone?: () => void;
}) {
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [live, setLive] = useState<Record<number, DownloadProgress>>({});

  const refresh = useCallback(async () => {
    try {
      setJobs(await listDownloadJobs(30));
    } catch {
      /* noop */
    }
  }, []);

  useEffect(() => {
    refresh();
    let un: (() => void) | undefined;
    onDownloadProgress((p) => {
      if (p.done >= p.total) {
        setLive((m) => {
          const n = { ...m };
          delete n[p.job_id];
          return n;
        });
        refresh();
        onJobDone?.();
      } else {
        setLive((m) => ({ ...m, [p.job_id]: p }));
      }
    }).then((u) => (un = u));
    return () => un?.();
  }, [refresh, onJobDone]);

  const clearFinished = useCallback(async () => {
    try {
      await clearFinishedJobs();
    } catch {
      /* noop */
    }
    await refresh();
  }, [refresh]);

  const active = jobs.filter((j) => j.finished_at == null).length;

  const value = useMemo(
    () => ({ jobs, live, active, refresh, clearFinished }),
    [jobs, live, active, refresh, clearFinished],
  );

  return <DlcCtx.Provider value={value}>{children}</DlcCtx.Provider>;
}

function ActiveCard({ p }: { p: DownloadProgress }) {
  const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97 }}
      className="dl-job active"
    >
      <div className="dl-job-head">
        <span className="dl-kind-badge">
          <Download size={13} />
        </span>
        <div className="dl-job-id">
          <b>{kindLabel(p.kind)}</b>
          <span>
            {p.done}/{p.total} · {pct}%
          </span>
        </div>
        <Loader2 size={15} className="spin" />
      </div>
      <div className="dl-bar">
        <div className="dl-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="dl-job-foot">
        {p.current && <span className="dl-current" title={p.current}>{p.current}</span>}
        <span className="dl-flags">
          <span className="dl-chip ok">{p.ok} ✓</span>
          {p.failed > 0 && <span className="dl-chip err">{p.failed} ✕</span>}
        </span>
      </div>
    </motion.div>
  );
}

function JobRow({
  j,
  accountId,
}: {
  j: DownloadJob;
  accountId: number;
}) {
  const { toast } = useToast();
  const [retrying, setRetrying] = useState(false);
  const done = j.finished_at != null;
  const pct = j.total > 0 ? Math.round((j.ok / j.total) * 100) : 0;

  const doRetry = async () => {
    if (retrying || !accountId) return;
    setRetrying(true);
    try {
      const s = await downloadProfile(accountId, j.profile_id, j.kind as Kind, 4, true);
      toast(
        s.failed > 0 ? "warning" : "success",
        "Reintento terminado",
        `${s.ok} descargados, ${s.failed} con errores.`,
      );
    } catch (e) {
      toast("error", "Error al reintentar", String(e));
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className={`dl-job ${done ? "done" : "active"}`}>
      <div className="dl-job-head">
        <span className={`dl-kind-badge ${j.kind}`}>{kindLabel(j.kind)[0]}</span>
        <div className="dl-job-id">
          <b>@{j.username}</b>
          <span>
            {kindLabel(j.kind)} · {fmtJobTime(j.started_at)}
          </span>
        </div>
        {done ? (
          j.failed === 0 ? (
            <span className="dl-chip ok">
              <CheckCircle2 size={12} /> Completado
            </span>
          ) : (
            <span className="dl-chip warn" title={`${j.failed} fallidos`}>
              <AlertTriangle size={12} /> {j.ok}/{j.total}
            </span>
          )
        ) : (
          <Loader2 size={15} className="spin" />
        )}
      </div>
      {done && (
        <div className="dl-job-foot">
          <span className="muted">{pct}% del lote</span>
          {j.failed > 0 && (
            <button
              className="btn ghost xs"
              onClick={doRetry}
              disabled={retrying || !accountId}
            >
              {retrying ? <Loader2 size={12} className="spin" /> : <RotateCcw size={12} />}
              Reintentar {j.failed}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function DownloadManager({
  open,
  onClose,
  accountId,
}: {
  open: boolean;
  onClose: () => void;
  accountId: number;
}) {
  const { jobs, live, clearFinished } = useDownloads();
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const liveList = Object.values(live).sort((a, b) => b.job_id - a.job_id);
  const liveIds = new Set(liveList.map((p) => p.job_id));
  const history = jobs.filter((j) => !liveIds.has(j.id));
  const finishedCount = jobs.filter((j) => j.finished_at != null).length;

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="dl-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.aside
            className="dl-panel"
            initial={{ x: 440 }}
            animate={{ x: 0 }}
            exit={{ x: 440 }}
            transition={{ type: "spring", stiffness: 340, damping: 34 }}
          >
            <div className="dl-head">
              <div className="dl-title">
                <Download size={17} />
                Descargas
                {(liveList.length > 0 || !jobs.every((j) => j.finished_at != null)) && (
                  <span className="dl-live-dot" />
                )}
              </div>
              <button className="icon-btn" onClick={onClose} title="Cerrar">
                <X size={17} />
              </button>
            </div>

            <div className="dl-body">
              {liveList.length > 0 && (
                <>
                  <div className="dl-section">En curso</div>
                  <AnimatePresence mode="popLayout">
                    {liveList.map((p) => (
                      <ActiveCard key={p.job_id} p={p} />
                    ))}
                  </AnimatePresence>
                </>
              )}

              <div className="dl-section">
                Historial {history.length > 0 && <span className="muted">({history.length})</span>}
              </div>
              {history.length === 0 && liveList.length === 0 ? (
                <div className="dl-empty">
                  <Download size={22} />
                  <p>Aún no hay descargas.</p>
                  <span className="muted">
                    Usa “Descargar” en un perfil y verás aquí el progreso en tiempo real.
                  </span>
                </div>
              ) : (
                <div className="dl-history">
                  <AnimatePresence mode="popLayout">
                    {history.map((j) => (
                      <motion.div
                        key={j.id}
                        layout
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                      >
                        <JobRow j={j} accountId={accountId} />
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              )}
            </div>

            {finishedCount > 0 && (
              <div className="dl-foot">
                <span className="muted">
                  {finishedCount} lote{finishedCount !== 1 && "s"} finalizado
                  {finishedCount !== 1 && "s"}
                </span>
                <button
                  className="btn ghost xs"
                  onClick={async () => {
                    setClearing(true);
                    await clearFinished();
                    setClearing(false);
                  }}
                  disabled={clearing}
                >
                  {clearing ? <Loader2 size={12} className="spin" /> : <Trash2 size={12} />}
                  Limpiar
                </button>
              </div>
            )}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

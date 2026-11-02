import { AnimatePresence, motion } from "motion/react";
import { CircleCheck, RotateCcw, Trash, X } from "lucide-react";
import { useEffect } from "react";
import { toast } from "sonner";
import { call, errorMessage } from "../lib/api";
import { fmtRelative, fmtSpeed } from "../lib/format";
import { useStore } from "../store";
import { DevelopImage } from "../ui/DevelopImage";
import { Spinner } from "../ui/primitives";

export function DownloadsDrawer() {
  const { downloadsOpen, setDownloadsOpen, jobs, progress, developing, refreshJobs } = useStore();
  const live = Object.values(progress);
  const running = jobs.filter((j) => j.status === "running");
  const history = jobs.filter((j) => j.status !== "running");
  const speed = live.reduce((max, p) => Math.max(max, p.bytesPerSecond), 0);

  useEffect(() => {
    if (!downloadsOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDownloadsOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [downloadsOpen, setDownloadsOpen]);

  return (
    <AnimatePresence>
      {downloadsOpen && (
        <>
          <motion.div className="overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setDownloadsOpen(false)} />
          <motion.aside
            className="drawer panel"
            initial={{ x: 460, opacity: 0.6 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 460, opacity: 0.6 }}
            transition={{ type: "spring", stiffness: 340, damping: 36 }}
          >
            <div className="flex items-start justify-between px-6 pb-4 pt-5">
              <div>
                <div className="eyebrow">Cola de laboratorio</div>
                <h2 className="display mt-1 text-[36px]">
                  Revelando<em>.</em>
                </h2>
                <p className="mt-1 text-[12.5px] text-paper-3">
                  {live.length ? `${live.length} ${live.length === 1 ? "trabajo" : "trabajos"} · ${fmtSpeed(speed)}` : "Nada en el tanque ahora mismo."}
                </p>
              </div>
              <button className="icon-btn" onClick={() => setDownloadsOpen(false)} aria-label="Cerrar">
                <X size={18} />
              </button>
            </div>

            {developing.length > 0 && (
              <div className="developing-strip px-6 pb-4">
                {developing.slice(0, 12).map((src) => (
                  <motion.div key={src} layout initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }}>
                    <DevelopImage src={src} />
                  </motion.div>
                ))}
              </div>
            )}

            <div className="divider" />

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              {running.length > 0 && <div className="eyebrow mb-2 px-2">En curso</div>}
              <div className="flex flex-col gap-2">
                {running.map((job) => {
                  const p = progress[job.id];
                  const done = p?.done ?? 0;
                  const total = p?.total ?? job.total;
                  const pct = total ? Math.round((done / total) * 100) : 0;
                  return (
                    <motion.div key={job.id} layout className="rounded-2xl bg-ink-3/70 p-4 shadow-[inset_0_0_0_1px_rgba(240,220,195,0.08)]">
                      <div className="flex items-center gap-3">
                        <span className="text-amber-2">
                          <Spinner size={15} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13.5px] text-paper">{job.label}</div>
                          <div className="mono text-[11px] text-paper-3">
                            {done}/{total} · {pct}%{p?.failed ? ` · ${p.failed} con error` : ""}
                          </div>
                        </div>
                        <button className="btn btn-sm btn-ghost" onClick={() => void call("downloads:cancel", { jobId: job.id })}>
                          Detener
                        </button>
                      </div>
                      <div className="progress mt-3">
                        <i style={{ width: `${Math.max(2, pct)}%` }} />
                      </div>
                    </motion.div>
                  );
                })}
              </div>

              {history.length > 0 && (
                <>
                  <div className="eyebrow mb-2 mt-6 flex items-center justify-between px-2">
                    <span>Historial</span>
                    <button
                      className="flex items-center gap-1 normal-case tracking-normal text-paper-3 hover:text-paper"
                      onClick={async () => {
                        await call("downloads:clearFinished");
                        await refreshJobs();
                      }}
                    >
                      <Trash size={11} /> Limpiar
                    </button>
                  </div>
                  <div className="flex flex-col">
                    {history.map((job) => (
                      <div key={job.id} className="group flex items-center gap-3 rounded-xl px-2 py-2.5 hover:bg-ink-3/50">
                        <span className={job.failed ? "text-safelight" : "text-sage"}>
                          <CircleCheck size={15} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] text-paper-2">{job.label}</div>
                          <div className="mono text-[10.5px] text-paper-4">
                            {job.ok}/{job.total} listas{job.failed ? ` · ${job.failed} fallidas` : ""} · {fmtRelative(job.finishedAt ?? job.startedAt)}
                            {job.status === "cancelled" ? " · detenido" : ""}
                          </div>
                        </div>
                        {job.failed > 0 && job.profileId && (
                          <button
                            className="btn btn-sm opacity-0 transition group-hover:opacity-100"
                            onClick={async () => {
                              try {
                                await call("downloads:start", { profileId: job.profileId!, includeFailed: true });
                              } catch (error) {
                                toast.error("No se pudo reintentar", { description: errorMessage(error) });
                              }
                            }}
                          >
                            <RotateCcw size={13} /> Reintentar
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}

              {!jobs.length && (
                <div className="px-4 py-16 text-center text-[13px] text-paper-3">
                  Las descargas aparecerán aquí mientras se revelan.
                </div>
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Download,
  FileImage,
  Film,
  FolderOpen,
  Images,
  LayoutGrid,
  Loader2,
  MoreVertical,
  RefreshCw,
  Star,
  Trash2,
  Video,
} from "lucide-react";
import type { Kind, Media, Profile } from "../types";
import {
  deleteProfile,
  downloadProfile,
  getMedia,
  syncHighlights,
  syncPosts,
  syncStories,
} from "../lib/api";
import { useToast } from "./Toasts";
import { Modal } from "./Modal";
import { ProfileAvatar, fmtDate, fmtInt } from "./ProfilesView";

const KINDS: { id: Kind; label: string; icon: React.ReactNode }[] = [
  { id: "post", label: "Posts", icon: <Images size={14} /> },
  { id: "story", label: "Stories", icon: <Film size={14} /> },
  { id: "highlight", label: "Highlights", icon: <Star size={14} /> },
];

function mediaIcon(m: Media) {
  if (m.media_type === 2) return <Video size={13} />;
  if (m.media_type === 8) return <Images size={13} />;
  return <FileImage size={13} />;
}

export function MediaDetail({
  prof,
  kind: initialKind,
  accountId,
  onBack,
  onChanged,
}: {
  prof: Profile;
  kind: Kind;
  accountId: number;
  onBack: () => void;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [kind, setKind] = useState<Kind>(initialKind);
  const [media, setMedia] = useState<Media[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"sync" | "download" | null>(null);
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [light, setLight] = useState<Media | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const load = async () => {
    setLoading(true);
    try {
      const all = await getMedia(prof.id!);
      setMedia(all.filter((m) => m.kind === kind));
      const c: Record<string, number> = {};
      for (const m of all) c[m.kind] = (c[m.kind] || 0) + 1;
      setCounts(c);
    } catch (e) {
      toast("error", "Error al cargar medios", String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  const doSync = async () => {
    setBusy("sync");
    try {
      let n = 0;
      if (kind === "post") n = await syncPosts(accountId, prof.username, 4);
      if (kind === "story") n = await syncStories(accountId, prof.username);
      if (kind === "highlight") n = await syncHighlights(accountId, prof.username);
      toast("success", "Sincronizado", `${n} medios en la base.`);
      load();
      onChanged();
    } catch (e) {
      toast("error", "Error al sincronizar", String(e));
    } finally {
      setBusy(null);
    }
  };

  const doDownload = async () => {
    setBusy("download");
    try {
      const [ok, failed] = await downloadProfile(accountId, prof.id!, kind);
      if (failed > 0)
        toast("warning", "Descarga terminada", `${ok} descargados, ${failed} con errores.`);
      else toast("success", "Descarga completa", `${ok} medios en tu biblioteca.`);
      load();
      onChanged();
    } catch (e) {
      toast("error", "Error en la descarga", String(e));
    } finally {
      setBusy(null);
    }
  };

  const doDelete = async () => {
    if (!prof.id) return;
    await deleteProfile(prof.id);
    toast("info", "Perfil eliminado");
    onChanged();
    onBack();
  };

  const toggleSel = (id: number) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const thumb = (m: Media) =>
    m.local_path ? convertFileSrc(m.local_path) : m.thumbnail_url;

  return (
    <div className="view">
      <div className="detail-head">
        <button className="btn ghost sm" onClick={onBack}>
          <ArrowLeft size={15} /> Volver
        </button>
        <div className="detail-id">
          <ProfileAvatar url={prof.profile_pic_url} name={prof.username} size={46} ring />
          <div>
            <div className="detail-name">
              {prof.full_name || prof.username}
              <span className="detail-handle">@{prof.username}</span>
            </div>
            <div className="detail-stats">
              <b>{fmtInt(prof.media_count)}</b> posts · <b>{fmtInt(prof.followers)}</b>{" "}
              seguidores
            </div>
          </div>
        </div>

        <div className="detail-menu" onClick={(e) => e.stopPropagation()}>
          <button className="icon-btn" onClick={() => setMenu((m) => !m)}>
            <MoreVertical size={17} />
          </button>
          <AnimatePresence>
            {menu && (
              <motion.div
                initial={{ opacity: 0, scale: 0.94, y: -4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.94, y: -4 }}
                className="dropdown right"
              >
                <button onClick={() => { setMenu(false); doSync(); }}>
                  <RefreshCw size={14} /> Sincronizar {KINDS.find((k) => k.id === kind)?.label}
                </button>
                <div className="dropdown-sep" />
                <button className="danger" onClick={() => { setMenu(false); setConfirm(true); }}>
                  <Trash2 size={14} /> Eliminar perfil
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <button
          className="btn primary sm"
          onClick={doDownload}
          disabled={busy !== null || media.filter((m) => m.status !== "downloaded").length === 0}
        >
          {busy === "download" ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
          Descargar pendientes
        </button>
      </div>

      <div className="kind-tabs">
        {KINDS.map((k) => (
          <button
            key={k.id}
            className={`kind-tab ${kind === k.id ? "active" : ""}`}
            onClick={() => setKind(k.id)}
          >
            {k.icon}
            {k.label}
            <span className="kind-count">{counts[k.id] || 0}</span>
          </button>
        ))}
        <button
          className="btn ghost sm"
          onClick={doSync}
          disabled={busy !== null}
          title={`Sincronizar ${KINDS.find((k) => k.id === kind)?.label}`}
        >
          {busy === "sync" ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
          Sincronizar
        </button>
      </div>

      <AnimatePresence mode="wait">
        {loading ? (
          <motion.div
            key="skeleton"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="media-grid"
          >
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="skel-cell" />
            ))}
          </motion.div>
        ) : media.length === 0 ? (
          <motion.div
            key="empty"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            className="empty"
          >
            <div className="empty-icon">
              <LayoutGrid size={30} />
            </div>
            <h3>Sin {KINDS.find((k) => k.id === kind)?.label.toLowerCase()} todavía</h3>
            <p>Usa “Sincronizar” para traer el contenido de este perfil a tu base de datos.</p>
          </motion.div>
        ) : (
          <motion.div
            key={kind}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.22 }}
            className="media-grid"
          >
            {media.map((m, i) => {
              const t = thumb(m);
              const sel = selected.has(m.id!);
              return (
                <motion.div
                  key={m.media_id}
                  initial={{ opacity: 0, scale: 0.94 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: Math.min(i * 0.02, 0.25) }}
                  className={`media-cell ${sel ? "selected" : ""} ${m.status === "failed" ? "failed" : ""}`}
                  onClick={() => (t ? setLight(m) : toggleSel(m.id!))}
                >
                  {t ? (
                    <img src={t} alt={m.caption ?? m.media_id} loading="lazy" />
                  ) : (
                    <div className="media-noimg">
                      <FileImage size={26} />
                    </div>
                  )}
                  <div className="media-veil">
                    <span className="media-kind">{mediaIcon(m)}</span>
                    <span className={`media-status ${m.status}`}>
                      {m.status === "downloaded" ? (
                        <CheckCircle2 size={13} />
                      ) : m.status === "failed" ? (
                        <AlertTriangle size={13} />
                      ) : (
                        <Download size={13} />
                      )}
                    </span>
                  </div>
                </motion.div>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>

      {selected.size > 0 && (
        <div className="selection-bar">
          <span>
            {selected.size} seleccionado{selected.size !== 1 && "s"}
          </span>
          <button className="btn ghost sm" onClick={() => setSelected(new Set())}>
            Limpiar
          </button>
        </div>
      )}

      {/* Lightbox */}
      <AnimatePresence>
        {light && (
          <motion.div
            className="lightbox"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setLight(null)}
          >
            <motion.div
              className="lightbox-inner"
              initial={{ scale: 0.92, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              transition={{ type: "spring", stiffness: 300, damping: 28 }}
              onClick={(e) => e.stopPropagation()}
            >
              {light.local_path ? (
                <img
                  src={convertFileSrc(light.local_path)}
                  alt={light.caption ?? light.media_id}
                />
              ) : (
                <img src={light.thumbnail_url ?? ""} alt={light.caption ?? light.media_id} />
              )}
              {(light.caption || light.taken_at) && (
                <div className="lightbox-meta">
                  {light.taken_at && (
                    <span>
                      <FileImage size={13} /> {fmtDate(light.taken_at)}
                    </span>
                  )}
                  {light.caption && <p>{light.caption}</p>}
                  {light.local_path && (
                    <span className="lightbox-path" title={light.local_path}>
                      <FolderOpen size={13} /> {light.local_path}
                    </span>
                  )}
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Eliminar perfil"
        icon={<Trash2 size={18} />}
        width={400}
      >
        <p className="confirm-text">
          ¿Eliminar <strong>@{prof.username}</strong> y todo su contenido de la base de datos?
        </p>
        <div className="modal-actions">
          <button className="btn ghost" onClick={() => setConfirm(false)}>Cancelar</button>
          <button className="btn danger" onClick={doDelete}>
            <Trash2 size={15} /> Eliminar
          </button>
        </div>
      </Modal>
    </div>
  );
}
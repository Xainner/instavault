import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  Download,
  FileImage,
  Film,
  FolderDown,
  FolderOpen,
  Images,
  LayoutGrid,
  Loader2,
  MoreVertical,
  RotateCcw,
  RefreshCw,
  Star,
  Trash2,
  Video,
} from "lucide-react";
import type { Kind, Media, Profile, ProfileStats } from "../types";
import {
  clearDownloads,
  exportAvatar,
  exportMedia,
  deleteProfile,
  downloadMedia,
  downloadProfile,
  getMedia,
  onDownloadProgress,
  resetDownload,
  syncHighlights,
  syncPosts,
  syncStories,
} from "../lib/api";
import { useToast } from "./Toasts";
import { Modal } from "./Modal";
import { ProfileAvatar, fmtDate, fmtInt } from "./ProfilesView";

type Tab = Kind | "album";

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "post", label: "Posts", icon: <Images size={14} /> },
  { id: "story", label: "Stories", icon: <Film size={14} /> },
  { id: "highlight", label: "Highlights", icon: <Star size={14} /> },
  { id: "album", label: "Álbum", icon: <FolderDown size={14} /> },
];

const isKind = (t: Tab): t is Kind => t !== "album";

function mediaIcon(m: Media) {
  if (m.media_type === 2) return <Video size={13} />;
  if (m.media_type === 8) return <Images size={13} />;
  return <FileImage size={13} />;
}

function CellImg({ src, alt }: { src: string | null; alt: string }) {
  const [err, setErr] = useState(false);
  // Un src nuevo (re-sync con URLs frescas) puede ser válido de nuevo.
  useEffect(() => setErr(false), [src]);
  if (!src || err)
    return (
      <div className="media-noimg">
        <FileImage size={26} />
      </div>
    );
  return <img src={src} alt={alt} loading="lazy" onError={() => setErr(true)} />;
}

export function MediaDetail({
  prof,
  kind: initialKind,
  accountId,
  stats,
  onBack,
  onChanged,
}: {
  prof: Profile;
  kind: Kind;
  accountId: number;
  stats: ProfileStats | null;
  onBack: () => void;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [kind, setKind] = useState<Tab>(initialKind);
  const [media, setMedia] = useState<Media[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"sync" | "download" | "retry" | null>(null);
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [light, setLight] = useState<Media | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [dlOne, setDlOne] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [reDl, setReDl] = useState<number | null>(null);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  const autoSynced = useRef(false);

  const load = async () => {
    setLoading(true);
    try {
      const all = await getMedia(prof.id!);
      setMedia(
        kind === "album"
          ? all.filter((m) => m.status === "downloaded")
          : all.filter((m) => m.kind === kind),
      );
      const c: Record<string, number> = {};
      for (const m of all) c[m.kind] = (c[m.kind] || 0) + 1;
      c.album = all.filter((m) => m.status === "downloaded").length;
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

  // Auto-sync al abrir un perfil vacío (p.ej. recién buscado): trae posts,
  // stories y highlights de una vez, solo metadatos (sin descargar).
  useEffect(() => {
    if (autoSynced.current || !prof.id || busy) return;
    autoSynced.current = true;
    (async () => {
      try {
        const all = await getMedia(prof.id!);
        if (all.length > 0) return;
        setBusy("sync");
        let n = 0;
        try {
          n += await syncPosts(accountId, prof.username, 4);
        } catch {
          /* un kind fallido no frena el resto */
        }
        try {
          n += await syncStories(accountId, prof.username);
        } catch {
          /* noop */
        }
        try {
          n += await syncHighlights(accountId, prof.username);
        } catch {
          /* noop */
        }
        toast(
          n > 0 ? "success" : "info",
          "Sincronización automática",
          n > 0 ? `${n} medios en la base.` : "No se encontraron medios.",
        );
        load();
        onChanged();
      } catch {
        /* noop */
      } finally {
        setBusy(null);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prof.id]);

  /// "Guardar en este equipo": diálogo de destino + copia del archivo local.
  const saveToPC = async (target: { mediaId?: number; avatarId?: number }, filename: string) => {
    if ((!target.mediaId && !target.avatarId) || saving) return;
    setSaving(true);
    try {
      const dest = await save({ defaultPath: filename });
      if (!dest) return;
      const out = target.mediaId
        ? await exportMedia(target.mediaId, dest)
        : await exportAvatar(target.avatarId!, dest);
      toast("success", "Guardado en tu equipo", out);
    } catch (e) {
      toast("error", "No se pudo guardar", String(e));
    } finally {
      setSaving(false);
    }
  };

  // Un job que termine (iniciado desde otro lado) refresca la grilla.
  // Depende de `kind`: load() filtra por la pestaña activa y el callback
  // de listen captura la `load` del render en el que se suscribió.
  useEffect(() => {
    let un: (() => void) | undefined;
    onDownloadProgress((p) => {
      if (p.profile_id === prof.id && p.done >= p.total) load();
    }).then((u) => (un = u));
    return () => un?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prof.id, kind]);

  const doSync = async () => {
    if (!isKind(kind)) return;
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

  const doDownload = async (includeFailed = false) => {
    if (!isKind(kind)) return;
    setBusy(includeFailed ? "retry" : "download");
    try {
      const s = await downloadProfile(accountId, prof.id!, kind, 4, includeFailed);
      if (s.total === 0)
        toast("info", "Nada que descargar", "Sincroniza antes para traer medios a la base.");
      else if (s.failed > 0)
        toast("warning", "Descarga terminada", `${s.ok} descargados, ${s.failed} con errores.`);
      else toast("success", "Descarga completa", `${s.ok} medios en tu biblioteca.`);
      load();
      onChanged();
    } catch (e) {
      toast("error", "Error en la descarga", String(e));
    } finally {
      setBusy(null);
    }
  };

  const doDownloadOne = async (m: Media) => {
    if (!m.id || dlOne != null) return;
    setDlOne(m.id);
    try {
      const s = await downloadMedia(accountId, m.id);
      if (s.failed > 0) toast("error", "No se pudo descargar", s.errors[0]?.error ?? "");
      else toast("success", "Descargado", "El medio ya está en tu biblioteca.");
      const st = s.failed ? "failed" : "downloaded";
      setLight((l) => (l && l.id === m.id ? { ...l, status: st } : l));
      load();
      onChanged();
    } catch (e) {
      toast("error", "Error en la descarga", String(e));
    } finally {
      setDlOne(null);
    }
  };

  const doDelete = async () => {
    if (!prof.id) return;
    await deleteProfile(prof.id);
    toast("info", "Perfil eliminado");
    onChanged();
    onBack();
  };

  // Re-descargar un medio ya descargado: borra el archivo local (que puede
  // ser de baja calidad) y lo baja de nuevo a máxima calidad / firma fresca.
  const doRedownload = async (m: Media) => {
    if (!m.id || reDl != null) return;
    setReDl(m.id);
    try {
      await resetDownload(m.id);
      const s = await downloadMedia(accountId, m.id);
      if (s.failed > 0)
        toast("error", "No se pudo re-descargar", s.errors[0]?.error ?? "");
      else toast("success", "Re-descargado", "Versión de máxima calidad.");
      const st = s.failed ? "failed" : "downloaded";
      setLight((l) => (l && l.id === m.id ? { ...l, status: st } : l));
      load();
      onChanged();
    } catch (e) {
      toast("error", "Error al re-descargar", String(e));
    } finally {
      setReDl(null);
    }
  };

  // Vaciar el álbum: borra todos los archivos descargados del perfil y los
  // deja pendientes (la metadata se conserva para re-descargar).
  const doClear = async () => {
    if (!prof.id || clearing) return;
    setClearing(true);
    try {
      const n = await clearDownloads(prof.id);
      toast("success", "Álbum vaciado", `${n} archivos eliminados de tu equipo.`);
      setClearConfirm(false);
      load();
      onChanged();
    } catch (e) {
      toast("error", "No se pudo vaciar el álbum", String(e));
    } finally {
      setClearing(false);
    }
  };

  const toggleSel = (id: number) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const toMediaSrc = (path: string) => path.includes("vault.localhost") ? path : convertFileSrc(path);
  const thumb = (m: Media) =>
    m.local_path ? toMediaSrc(m.local_path) : m.thumbnail_url;

  const kindStats = isKind(kind) ? (stats?.kinds.find((k) => k.kind === kind) ?? null) : null;
  const failedCount = media.filter((m) => m.status === "failed").length;

  return (
    <div className="view">
      <div className="detail-head">
        <button className="btn ghost sm" onClick={onBack}>
          <ArrowLeft size={15} /> Volver
        </button>
        <div className="detail-id">
          <ProfileAvatar url={prof.profile_pic_url} localPath={prof.avatar_local_path} name={prof.username} size={46} ring />
          <div>
            <div className="detail-name">
              {prof.full_name || prof.username}
              <span className="detail-handle">@{prof.username}</span>
            </div>
            <div className="detail-stats">
              <b>{fmtInt(prof.media_count)}</b> posts · <b>{fmtInt(prof.followers)}</b>{" "}
              seguidores
            </div>
            {kindStats && (
              <div className="detail-sync">
                <span>
                  <b>{kindStats.local_count}</b> en base
                </span>
                <span className="ok">
                  <Download size={11} /> {kindStats.downloaded} descargados
                </span>
                {failedCount > 0 && (
                  <span className="err">
                    <AlertTriangle size={11} /> {failedCount} fallidos
                  </span>
                )}
                {kindStats.last_sync && (
                  <span>
                    <Clock size={11} /> sync {fmtDate(kindStats.last_sync)}
                  </span>
                )}
              </div>
            )}
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
                {isKind(kind) && (
                  <button onClick={() => { setMenu(false); doSync(); }}>
                    <RefreshCw size={14} /> Sincronizar {TABS.find((k) => k.id === kind)?.label}
                  </button>
                )}
                <div className="dropdown-sep" />
                <button className="danger" onClick={() => { setMenu(false); setConfirm(true); }}>
                  <Trash2 size={14} /> Eliminar perfil
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <button
          className="btn ghost sm"
          onClick={() => saveToPC({ avatarId: prof.id ?? undefined }, `avatar_${prof.username}.jpg`)}
          disabled={!prof.avatar_local_path || saving}
          title="Guardar foto de perfil en este equipo"
        >
          {saving ? <Loader2 size={14} className="spin" /> : <FolderDown size={14} />}
          Foto de perfil
        </button>
        {kind === "album" && (counts.album ?? 0) > 0 && (
          <button
            className="btn ghost sm danger"
            onClick={() => setClearConfirm(true)}
            disabled={clearing}
            title="Borrar todos los archivos descargados de este perfil (la base de datos se conserva)"
          >
            {clearing ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}
            Vaciar álbum ({counts.album})
          </button>
        )}
        {isKind(kind) && (
          <button
            className="btn primary sm"
            onClick={() => doDownload(false)}
            disabled={busy !== null || media.filter((m) => m.status !== "downloaded").length === 0}
          >
            {busy === "download" ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
            Descargar pendientes
          </button>
        )}
        {failedCount > 0 && (
          <button
            className="btn ghost sm warn"
            onClick={() => doDownload(true)}
            disabled={busy !== null}
            title="Reintentar los medios fallidos"
          >
            {busy === "retry" ? <Loader2 size={14} className="spin" /> : <RotateCcw size={14} />}
            Reintentar {failedCount}
          </button>
        )}
      </div>

      <div className="kind-tabs">
        {TABS.map((k) => (
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
        {isKind(kind) && (
          <button
            className="btn ghost sm"
            onClick={doSync}
            disabled={busy !== null}
            title={`Sincronizar ${TABS.find((k) => k.id === kind)?.label}`}
          >
            {busy === "sync" ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
            Sincronizar
          </button>
        )}
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
            {kind === "album" ? (
              <>
                <h3>Tu álbum está vacío</h3>
                <p>
                  Los medios que descargues de este perfil aparecerán aquí para verlos
                  y copiarlos a donde quieras.
                </p>
              </>
            ) : (
              <>
                <h3>Sin {TABS.find((k) => k.id === kind)?.label.toLowerCase()} todavía</h3>
                <p>Usa “Sincronizar” para traer el contenido de este perfil a tu base de datos.</p>
              </>
            )}
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
                  {m.media_type === 2 && m.local_path ? (
                    // Video descargado: el primer frame sirve de portada local
                    // (el <img> con bytes MP4 siempre fallaría).
                    <video
                      key={m.local_path}
                      src={toMediaSrc(m.local_path)}
                      preload="metadata"
                      muted
                      className="media-video"
                    />
                  ) : (
                    <CellImg src={t} alt={m.caption ?? m.media_id} />
                  )}
                  <div className="media-veil">
                    <span className="media-kind">{mediaIcon(m)}</span>
                    <div className="media-veil-right">
                      {m.status === "failed" && (
                        <button
                          className="cell-retry"
                          title="Reintentar descarga"
                          onClick={(e) => {
                            e.stopPropagation();
                            doDownloadOne(m);
                          }}
                        >
                          {dlOne === m.id ? (
                            <Loader2 size={13} className="spin" />
                          ) : (
                            <RotateCcw size={13} />
                          )}
                        </button>
                      )}
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
{(() => {
                 const isVideo = light.media_type === 2;
                 const src = light.local_path
                   ? toMediaSrc(light.local_path)
                   : (light.best_url ?? light.thumbnail_url) ?? "";
                 return isVideo ? (
                   <video
                     key={src}
                     src={src}
                     controls
                     autoPlay
                     playsInline
                     className="lightbox-video"
                   />
                 ) : (
                   <img src={src} alt={light.caption ?? light.media_id} />
                 );
               })()}
<div className="lightbox-actions">
                  {light.status === "downloaded" ? (
                    <span className="dl-chip ok">
                      <CheckCircle2 size={13} /> Descargado
                    </span>
                  ) : (
                    <button
                      className="btn primary sm"
                      disabled={dlOne != null || !light.best_url}
                      onClick={() => doDownloadOne(light)}
                    >
                      {dlOne === light.id ? (
                        <Loader2 size={14} className="spin" />
                      ) : (
                        <Download size={14} />
                      )}
                      {light.status === "failed" ? "Reintentar" : "Descargar"}
                    </button>
                  )}
                  {light.status === "downloaded" && light.local_path && (
                    <button
                      className="btn ghost sm"
                      disabled={saving}
                      onClick={() =>
                        saveToPC(
                          { mediaId: light.id ?? undefined },
                          `${light.code || light.media_id}.${light.media_type === 2 ? "mp4" : "jpg"}`,
                        )
                      }
                      title="Copiar este archivo a una carpeta de tu equipo"
                    >
                      {saving ? (
                        <Loader2 size={14} className="spin" />
                      ) : (
                        <FolderDown size={14} />
                      )}
                      Guardar en este equipo
                    </button>
                  )}
                  {light.status === "downloaded" && (
                    <button
                      className="btn ghost sm"
                      disabled={reDl != null}
                      onClick={() => doRedownload(light)}
                      title="Borrar este archivo y descargarlo de nuevo (máxima calidad)"
                    >
                      {reDl === light.id ? (
                        <Loader2 size={14} className="spin" />
                      ) : (
                        <RotateCcw size={14} />
                      )}
                      Re-descargar
                    </button>
                  )}
                  {light.status === "failed" && light.error && (
                    <span className="lightbox-err" title={light.error}>
                      <AlertTriangle size={13} /> {light.error}
                    </span>
                  )}
                </div>
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

      <Modal
        open={clearConfirm}
        onClose={() => setClearConfirm(false)}
        title="Vaciar álbum"
        icon={<Trash2 size={18} />}
        width={400}
      >
        <p className="confirm-text">
          ¿Borrar los <strong>{counts.album ?? 0}</strong> archivos descargados de{" "}
          <strong>@{prof.username}</strong> en tu equipo? La base de datos se conserva:
          después podrás volver a descargarlos.
        </p>
        <div className="modal-actions">
          <button className="btn ghost" onClick={() => setClearConfirm(false)}>Cancelar</button>
          <button className="btn danger" onClick={doClear} disabled={clearing}>
            <Trash2 size={15} /> Vaciar álbum
          </button>
        </div>
      </Modal>
    </div>
  );
}

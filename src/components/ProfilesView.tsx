import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  BadgeCheck,
  Clock,
  Download,
  Images,
  Film,
  Loader2,
  Lock,
  MoreVertical,
  RefreshCw,
  RotateCcw,
  Search,
  Star,
  Trash2,
  UserPlus,
  Users,
  UserX,
} from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Kind, Profile, ProfileStats } from "../types";
import {
  deleteProfile,
  downloadProfile,
  fetchProfile,
  setProfileFavorite,
  syncHighlights,
  syncPosts,
  syncStories,
} from "../lib/api";
import { Modal } from "./Modal";
import { useToast } from "./Toasts";

export function fmtInt(n: number | null | undefined) {
  if (n == null) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(".0", "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(".0", "") + "K";
  return String(n);
}

export function fmtDate(t: number | null) {
  if (!t) return "—";
  return new Date(t * 1000).toLocaleDateString("es", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function ProfileAvatar({
  url,
  localPath,
  name,
  size = 44,
  ring = false,
}: {
  url: string | null;
  localPath?: string | null;
  name: string;
  size?: number;
  ring?: boolean;
}) {
  const [err, setErr] = useState(false);
  // La copia local (descargada en Rust, servida por asset-protocol) siempre
  // gana: la URL remota de la CDN expira y su IPv6 puede estar caído.
  const src = localPath ? (localPath.includes("vault.localhost") ? localPath : convertFileSrc(localPath)) : url;
  // Una URL nueva (re-fetch) puede ser válida aunque la anterior fallara.
  useEffect(() => setErr(false), [src]);
  return (
    <div
      className={`pfp ${ring ? "ring" : ""}`}
      style={{ width: size, height: size }}
      title={err ? `FALLO al cargar imagen: ${src ?? ""}` : (src ?? "sin URL en base de datos")}
    >
      {src && !err ? (
        <img
          src={src}
          alt={name}
          loading="lazy"
          onError={(e) => {
            console.error("[pfp] onError", src, (e as unknown as { statusText?: string })?.statusText);
            setErr(true);
          }}
        />
      ) : err ? (
        <span style={{ color: "#e5484d", fontWeight: 700 }}>!</span>
      ) : (
        <span>{name[0]?.toUpperCase()}</span>
      )}
    </div>
  );
}

const KIND_ICON: Record<string, React.ReactNode> = {
  post: <Images size={12} />,
  story: <Film size={12} />,
  highlight: <Star size={12} />,
};

const KIND_NAME: Record<string, string> = {
  post: "Posts",
  story: "Stories",
  highlight: "Highlights",
};

export function ProfileCard({
  p,
  accountId,
  stats,
  onOpen,
  onDeleted,
}: {
  p: Profile;
  accountId: number;
  stats: ProfileStats | null;
  onOpen: (p: Profile) => void;
  onDeleted: () => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<Kind | "download" | "retry" | null>(null);
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [fav, setFav] = useState(p.is_favorite === 1);

  const postStats = stats?.kinds.find((k) => k.kind === "post") ?? null;
  const failedPosts = postStats?.failed ?? 0;
  const syncKinds = (stats?.kinds ?? []).filter(
    (k) => k.local_count > 0 || k.failed > 0 || k.last_sync != null,
  );

  const doSync = async (kind: Kind) => {
    if (busy) return;
    setBusy(kind);
    try {
      let n = 0;
      if (kind === "post") n = await syncPosts(accountId, p.username, 4);
      if (kind === "story") n = await syncStories(accountId, p.username);
      if (kind === "highlight") n = await syncHighlights(accountId, p.username);
      toast("success", `Sincronizado`, `${n} medios en la base de datos.`);
    } catch (e) {
      toast("error", "Error al sincronizar", String(e));
    } finally {
      setBusy(null);
    }
  };

  const doDownload = async (includeFailed = false) => {
    if (busy) return;
    setBusy(includeFailed ? "retry" : "download");
    try {
      if (!p.id) throw new Error("Perfil sin guardar");
      const s = await downloadProfile(accountId, p.id, "post", 4, includeFailed);
      if (s.total === 0)
        toast("info", "Nada que descargar", "Sincroniza antes para traer los posts a la base.");
      else if (s.failed > 0)
        toast("warning", "Descarga terminada", `${s.ok} descargados, ${s.failed} con errores.`);
      else toast("success", "Descarga completa", `${s.ok} medios en tu biblioteca.`);
    } catch (e) {
      toast("error", "Error en la descarga", String(e));
    } finally {
      setBusy(null);
    }
  };

  const doFavorite = async () => {
    if (!p.id) return;
    const next = !fav;
    setFav(next);
    try {
      await setProfileFavorite(p.id, next);
    } catch (e) {
      setFav(!next);
      toast("error", "Error al guardar favorito", String(e));
    }
  };

  const doDelete = async () => {
    if (!p.id) return;
    await deleteProfile(p.id);
    setConfirm(false);
    toast("info", `@${p.username} eliminado de la base`);
    onDeleted();
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ type: "spring", stiffness: 300, damping: 26 }}
      className="card profile-card"
      onClick={() => onOpen(p)}
    >
      <div className="profile-top">
        <ProfileAvatar url={p.profile_pic_url} localPath={p.avatar_local_path} name={p.username} size={54} ring />
        <div className="profile-id">
          <div className="profile-user">
            {p.full_name || p.username}
            {p.is_verified === 1 && <BadgeCheck size={15} className="verified" />}
            {p.is_private === 1 && <Lock size={13} className="locked" />}
          </div>
          <div className="profile-handle">@{p.username}</div>
        </div>
        <button
          className={`star-btn ${fav ? "on" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            doFavorite();
          }}
          title={fav ? "Quitar de favoritos" : "Agregar a favoritos"}
        >
          <Star size={17} fill={fav ? "currentColor" : "none"} />
        </button>
        <div className="profile-menu" onClick={(e) => e.stopPropagation()}>
          <button className="icon-btn" onClick={() => setMenu((m) => !m)}>
            <MoreVertical size={16} />
          </button>
          <AnimatePresence>
            {menu && (
              <motion.div
                initial={{ opacity: 0, scale: 0.92, y: -4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.92, y: -4 }}
                className="dropdown"
              >
                <button onClick={() => { setMenu(false); doSync("post"); }}>
                  <RefreshCw size={14} /> Sincronizar posts
                </button>
                <button onClick={() => { setMenu(false); doSync("story"); }}>
                  <RefreshCw size={14} /> Sincronizar stories
                </button>
                <button onClick={() => { setMenu(false); doSync("highlight"); }}>
                  <Star size={14} /> Sincronizar highlights
                </button>
                <div className="dropdown-sep" />
                <button className="danger" onClick={() => { setMenu(false); setConfirm(true); }}>
                  <Trash2 size={14} /> Eliminar
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {p.biography && <p className="profile-bio">{p.biography}</p>}

      <div className="profile-stats">
        <div className="stat">
          <Images size={15} />
          <span><b>{fmtInt(p.media_count)}</b> posts</span>
        </div>
        <div className="stat">
          <Users size={15} />
          <span><b>{fmtInt(p.followers)}</b> seguidores</span>
        </div>
        <div className="stat">
          <UserX size={15} />
          <span><b>{fmtInt(p.following)}</b> seguidos</span>
        </div>
      </div>

      <div className="sync-block">
        {syncKinds.length === 0 ? (
          <div className="sync-empty">
            Sin sincronizar — usa “Sincronizar” para ver qué hay en Instagram.
          </div>
        ) : (
          syncKinds.map((k) => (
            <div key={k.kind} className={`sync-cell ${k.failed > 0 ? "has-fail" : ""}`}>
              <div className="sync-head">
                {KIND_ICON[k.kind] ?? <Images size={12} />}
                <span>{KIND_NAME[k.kind] ?? k.kind}</span>
              </div>
              <div className="sync-num">
                <b>{k.local_count}</b>
                <span> en base</span>
                {k.kind === "post" && p.media_count != null && (
                  <span className="muted">/{fmtInt(p.media_count)}</span>
                )}
              </div>
              <div className="sync-foot">
                <span className="sync-dl" title="Descargados">
                  <Download size={11} /> {k.downloaded}
                </span>
                {k.failed > 0 && (
                  <span className="sync-fail" title="Con error">
                    <AlertTriangle size={11} /> {k.failed}
                  </span>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="profile-actions" onClick={(e) => e.stopPropagation()}>
        <button
          className="btn ghost sm"
          disabled={busy !== null}
          onClick={() => doSync("post")}
          title="Sincronizar posts (paginación 4)"
        >
          {busy === "post" ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
          Sincronizar
        </button>
        <button
          className="btn primary sm"
          disabled={busy !== null}
          onClick={() => doDownload(false)}
          title="Descargar posts pendientes"
        >
          {busy === "download" ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
          Descargar
        </button>
        {failedPosts > 0 && (
          <button
            className="btn ghost sm warn"
            disabled={busy !== null}
            onClick={() => doDownload(true)}
            title="Reintentar los posts fallidos"
          >
            {busy === "retry" ? <Loader2 size={14} className="spin" /> : <RotateCcw size={14} />}
            Reintentar {failedPosts}
          </button>
        )}
        <span className="muted profile-fetched">
          <Clock size={12} /> {fmtDate(p.fetched_at)}
        </span>
      </div>

      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Eliminar perfil"
        icon={<Trash2 size={18} />}
        width={400}
      >
        <p className="confirm-text">
          ¿Eliminar <strong>@{p.username}</strong> y todo su contenido de la base de datos?
        </p>
        <div className="modal-actions">
          <button className="btn ghost" onClick={() => setConfirm(false)}>Cancelar</button>
          <button className="btn danger" onClick={doDelete}>
            <Trash2 size={15} /> Eliminar
          </button>
        </div>
      </Modal>
    </motion.div>
  );
}

export function ProfilesView({
  profiles,
  accountId,
  stats,
  onOpen,
  onChanged,
}: {
  profiles: Profile[];
  accountId: number;
  stats: ProfileStats[];
  onOpen: (p: Profile) => void;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [searchPhase, setSearchPhase] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [onlyFav, setOnlyFav] = useState(false);

  const doSearch = async (username: string) => {
    const u = username.trim().replace(/^@/, "");
    if (!u || !accountId) {
      toast("warning", "Sin cuenta activa", "Agrega una cuenta primero.");
      return;
    }
    setSaving(true);
    setSearchPhase("Preparando sesión");
    setElapsed(0);
    const started = Date.now();
    const timer = window.setInterval(() => {
      const seconds = Math.floor((Date.now() - started) / 1000);
      setElapsed(seconds);
      if (seconds >= 1) setSearchPhase("Consultando Instagram");
    }, 250);
    try {
      const p = await fetchProfile(accountId, u);
      setSearchPhase("Guardando perfil");
      if (p.is_private === 1)
        toast("info", `@${p.username} es privado`, "Sincroniza desde la tarjeta para acceder.");
      toast("success", `@${p.username} en tu biblioteca`);
      setQuery("");
      onChanged();
    } catch (e) {
      toast("error", "No se encontró", String(e));
    } finally {
      window.clearInterval(timer);
      setSaving(false);
      setSearchPhase("");
    }
  };

  const q = query.trim().toLowerCase();
  let filtered = q
    ? profiles.filter(
        (p) =>
          p.username.toLowerCase().includes(q) ||
          (p.full_name || "").toLowerCase().includes(q),
      )
    : profiles;
  if (onlyFav) filtered = filtered.filter((p) => p.is_favorite === 1);
  // La búsqueda remota (agregar a Instagram) solo se ofrece cuando el texto
  // no coincide con nada de la biblioteca local.
  const canRemoteSearch = q.length > 0 && filtered.length === 0;

  return (
    <div className="view">
      <div className="page-head">
        <div>
          <h1 className="page-title">Perfiles</h1>
          <p className="page-sub">
            {profiles.length} perfil{profiles.length !== 1 && "es"} guardado
            {profiles.length !== 1 && "s"} en tu biblioteca local.
          </p>
        </div>
      </div>

      <div className="search-row tools-row">
        <div className="search-box">
          <Search size={17} />
          <input
            placeholder="Buscar en la biblioteca o agregar nuevo: @username"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canRemoteSearch && accountId && !saving) {
                doSearch(query);
              }
            }}
          />
          {canRemoteSearch && accountId && (
            <button className="btn primary sm" onClick={() => doSearch(query)} disabled={saving}>
              {saving ? <Loader2 size={14} className="spin" /> : <UserPlus size={14} />}
              Buscar
            </button>
          )}
          {q && (
            <button className="icon-btn" onClick={() => setQuery("")}>
              <UserX size={14} />
            </button>
          )}
        </div>
        <button
          className={`filter-chip ${onlyFav ? "on" : ""}`}
          onClick={() => setOnlyFav((f) => !f)}
          title="Mostrar solo favoritos"
        >
          <Star size={13} fill={onlyFav ? "currentColor" : "none"} />
          Favoritos
        </button>
      </div>

      {saving && (
        <div className="search-progress" role="status" aria-live="polite">
          <Loader2 size={14} className="spin" />
          <span>{searchPhase}</span>
          <small>{elapsed}s</small>
        </div>
      )}

      {filtered.length === 0 ? (
        <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} className="empty">
          <div className="empty-icon">
            {onlyFav && !q ? <Star size={30} /> : <Search size={30} />}
          </div>
          <h3>
            {onlyFav && !q ? "Sin favoritos aún" : q ? "Sin resultados" : "Tu biblioteca está vacía"}
          </h3>
          <p>
            {onlyFav && !q
              ? "Marca perfiles con la estrella para tenerlos siempre a mano."
              : q
                ? `Nada que coincida con “${query}”.`
                : "Busca un perfil con el usuario activo y quedará guardado aquí para siempre."}
          </p>
        </motion.div>
      ) : (
        <div className="cards-grid">
                  <AnimatePresence mode="popLayout">
                    {filtered.map((p) => (
                      <ProfileCard
                        key={p.id ?? p.username}
                        p={p}
                        accountId={accountId}
                        stats={stats.find((s) => s.profile_id === p.id) ?? null}
                        onOpen={onOpen}
                        onDeleted={onChanged}
                      />
                    ))}
                  </AnimatePresence>
                </div>
              )}
            </div>
          );
        }

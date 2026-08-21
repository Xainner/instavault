import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  BadgeCheck,
  Clock,
  Download,
  Images,
  Loader2,
  Lock,
  MoreVertical,
  RefreshCw,
  Search,
  Star,
  Trash2,
  UserPlus,
  Users,
  UserX,
} from "lucide-react";
import type { Kind, Profile } from "../types";
import {
  deleteProfile,
  downloadProfile,
  fetchProfile,
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
  name,
  size = 44,
  ring = false,
}: {
  url: string | null;
  name: string;
  size?: number;
  ring?: boolean;
}) {
  return (
    <div className={`pfp ${ring ? "ring" : ""}`} style={{ width: size, height: size }}>
      {url ? (
        <img src={url} alt={name} loading="lazy" />
      ) : (
        <span>{name[0]?.toUpperCase()}</span>
      )}
    </div>
  );
}

export function ProfileCard({
  p,
  accountId,
  onOpen,
  onDeleted,
}: {
  p: Profile;
  accountId: number;
  onOpen: (p: Profile) => void;
  onDeleted: () => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<Kind | "download" | null>(null);
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState(false);

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

  const doDownload = async () => {
    if (busy) return;
    setBusy("download");
    try {
      if (!p.id) throw new Error("Perfil sin guardar");
      const [ok, failed] = await downloadProfile(accountId, p.id, "post");
      if (failed > 0)
        toast("warning", `Descarga terminada`, `${ok} descargados, ${failed} con errores.`);
      else toast("success", "Descarga completa", `${ok} medios en tu biblioteca.`);
    } catch (e) {
      toast("error", "Error en la descarga", String(e));
    } finally {
      setBusy(null);
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
        <ProfileAvatar url={p.profile_pic_url} name={p.username} size={54} ring />
        <div className="profile-id">
          <div className="profile-user">
            {p.full_name || p.username}
            {p.is_verified === 1 && <BadgeCheck size={15} className="verified" />}
            {p.is_private === 1 && <Lock size={13} className="locked" />}
          </div>
          <div className="profile-handle">@{p.username}</div>
        </div>
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
          onClick={doDownload}
          title="Descargar posts"
        >
          {busy === "download" ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
          Descargar
        </button>
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
  onOpen,
  onChanged,
}: {
  profiles: Profile[];
  accountId: number;
  onOpen: (p: Profile) => void;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);

  const doSearch = async (username: string) => {
    const u = username.trim().replace(/^@/, "");
    if (!u || !accountId) {
      toast("warning", "Sin cuenta activa", "Agrega una cuenta primero.");
      return;
    }
    setSaving(true);
    try {
      const p = await fetchProfile(accountId, u);
      if (p.is_private === 1)
        toast("info", `@${p.username} es privado`, "Sincroniza desde la tarjeta para acceder.");
      toast("success", `@${p.username} en tu biblioteca`);
      setQuery("");
      onChanged();
    } catch (e) {
      toast("error", "No se encontró", String(e));
    } finally {
      setSaving(false);
    }
  };

  const q = query.trim().toLowerCase();
  const filtered = q
    ? profiles.filter(
        (p) =>
          p.username.toLowerCase().includes(q) ||
          (p.full_name || "").toLowerCase().includes(q),
      )
    : profiles;

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

      <div className="search-row">
        <div className="search-box">
          <Search size={17} />
          <input
            placeholder="Buscar en la biblioteca o agregar nuevo: @username"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !q && doSearch(query)}
          />
          {!q && accountId && (
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
      </div>

      {filtered.length === 0 ? (
        <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} className="empty">
          <div className="empty-icon">
            <Search size={30} />
          </div>
          <h3>{q ? "Sin resultados" : "Tu biblioteca está vacía"}</h3>
          <p>
            {q
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
import { motion, useMotionValue, useSpring, useTransform } from "motion/react";
import { BadgeCheck, CloudDownload, Lock, RefreshCw, Star } from "lucide-react";
import { useState, type MouseEvent } from "react";
import { toast } from "sonner";
import type { Profile } from "@shared/types";
import { art } from "../../assets";
import { call, errorMessage } from "../../lib/api";
import { fmtBytes, fmtCompact, fmtRelative, filmNumber } from "../../lib/format";
import { useStore } from "../../store";
import { DevelopImage } from "../../ui/DevelopImage";
import { Avatar, Spinner } from "../../ui/primitives";

export function profileTotals(p: Profile) {
  const total = p.stats.reduce((s, k) => s + k.total, 0);
  const downloaded = p.stats.reduce((s, k) => s + k.downloaded, 0);
  const pending = p.stats.reduce((s, k) => s + k.pending, 0);
  const failed = p.stats.reduce((s, k) => s + k.failed, 0);
  const lastSync = p.stats.reduce<number | null>((max, k) => (k.lastSync && (!max || k.lastSync > max) ? k.lastSync : max), null);
  return { total, downloaded, pending, failed, lastSync };
}

export function FilmCard({ profile, large = false, index = 0 }: { profile: Profile; large?: boolean; index?: number }) {
  const { navigate, remote, activity } = useStore();
  const [hover, setHover] = useState(false);
  const [busy, setBusy] = useState<"sync" | "download" | null>(null);
  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const rx = useSpring(useTransform(my, [-0.5, 0.5], [5, -5]), { stiffness: 200, damping: 18 });
  const ry = useSpring(useTransform(mx, [-0.5, 0.5], [-6, 6]), { stiffness: 200, damping: 18 });
  const t = profileTotals(profile);
  const pct = t.total ? Math.round((t.downloaded / t.total) * 100) : 0;
  const cover = profile.cover.length ? profile.cover : [art.cover];
  const syncingHere = activity?.profileId === profile.id;

  const onMove = (e: MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    mx.set((e.clientX - rect.left) / rect.width - 0.5);
    my.set((e.clientY - rect.top) / rect.height - 0.5);
  };

  const sync = async (e: MouseEvent) => {
    e.stopPropagation();
    setBusy("sync");
    const result = await remote(
      (access, accountId) => call("ig:sync", { profileId: profile.id, kind: "post", access: profile.isPrivate ? "account" : access, accountId }),
      { access: profile.isPrivate ? "account" : "public" },
    );
    setBusy(null);
    if (result) {
      toast.success(`@${profile.username} sincronizado`, {
        description: `${result.newItems} nuevas · ${result.publications} publicaciones revisadas${result.stopReason ? ` · ${result.stopReason}` : ""}`,
      });
    }
  };

  const download = async (e: MouseEvent) => {
    e.stopPropagation();
    setBusy("download");
    try {
      const job = await call("downloads:start", { profileId: profile.id, includeFailed: true });
      if (!job) toast("Nada pendiente", { description: "Todo lo sincronizado ya está revelado." });
    } catch (error) {
      toast.error("No se pudo iniciar la descarga", { description: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  const favorite = async (e: MouseEvent) => {
    e.stopPropagation();
    await call("profiles:setFavorite", { profileId: profile.id, favorite: !profile.isFavorite });
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index, 10) * 0.04, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      style={{ perspective: 1000 }}
      className={large ? "w-[400px] flex-none" : ""}
    >
      <motion.div
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && navigate({ name: "profile", id: profile.id })}
        onClick={() => navigate({ name: "profile", id: profile.id })}
        onMouseMove={onMove}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => {
          setHover(false);
          mx.set(0);
          my.set(0);
        }}
        style={{ rotateX: rx, rotateY: ry }}
        className="film group cursor-pointer outline-none"
      >
        <div className="mosaic" data-count={Math.min(cover.length, 4)}>
          {cover.slice(0, 4).map((src, i) => (
            <div key={src + i} className="tile">
              <motion.div className="h-full w-full" animate={{ scale: hover ? 1.06 : 1 }} transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}>
                <DevelopImage src={src} />
              </motion.div>
            </div>
          ))}
          <div className="absolute left-3 top-3 z-10 flex gap-1.5">
            {profile.isPrivate && (
              <span className="cell-badge">
                <Lock size={11} /> privada
              </span>
            )}
            {syncingHere && (
              <span className="cell-badge text-amber-2">
                <Spinner size={11} /> {activity?.stage}
              </span>
            )}
          </div>
          <button
            className="absolute right-2.5 top-2.5 z-10 grid h-8 w-8 place-items-center rounded-full bg-black/45 backdrop-blur transition hover:bg-black/70"
            onClick={favorite}
            aria-label={profile.isFavorite ? "Quitar de favoritos" : "Añadir a favoritos"}
          >
            <Star size={15} className={profile.isFavorite ? "fill-amber text-amber" : "text-white/80"} />
          </button>
          <motion.div
            className="absolute inset-x-3 bottom-3 z-10 flex gap-2"
            initial={false}
            animate={{ opacity: hover ? 1 : 0, y: hover ? 0 : 10 }}
            transition={{ duration: 0.2 }}
          >
            <button className="btn btn-sm flex-1 bg-black/55 backdrop-blur" onClick={sync} disabled={Boolean(activity)}>
              {busy === "sync" ? <Spinner size={13} /> : <RefreshCw size={13} />} Sincronizar
            </button>
            <button className="btn btn-sm btn-primary flex-1" onClick={download} disabled={!t.pending && !t.failed}>
              {busy === "download" ? <Spinner size={13} /> : <CloudDownload size={14} />}
              {t.pending + t.failed ? `Revelar ${t.pending + t.failed}` : "Al día"}
            </button>
          </motion.div>
        </div>

        <div className="mt-4 flex items-center gap-3 px-1">
          <Avatar src={profile.avatarUrl} name={profile.username} size={large ? 46 : 40} ring={profile.isFavorite} />
          <div className="min-w-0 flex-1">
            <div className={`display truncate text-paper ${large ? "text-[25px]" : "text-[22px]"}`}>{profile.fullName ?? profile.username}</div>
            <div className="flex items-center gap-1.5 text-[12px] text-paper-3">
              <span className="mono truncate">@{profile.username}</span>
              {profile.isVerified && <BadgeCheck size={13} className="flex-none text-amber-2" />}
            </div>
          </div>
          <div className="text-right">
            <div className="numeral text-[24px] leading-none text-paper">{pct}%</div>
            <div className="eyebrow mt-1 text-[9px]">revelado</div>
          </div>
        </div>

        <div className="mt-3 px-1">
          <div className="progress">
            <i style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-2.5 flex items-center gap-2 text-[11.5px] text-paper-3">
            <span>
              {t.downloaded.toLocaleString("es")}/{t.total.toLocaleString("es")} piezas
            </span>
            <span className="text-paper-4">·</span>
            <span>{fmtBytes(profile.bytes)}</span>
            {t.failed > 0 && <span className="tag tag-red ml-auto h-[19px]">{t.failed} con error</span>}
            {!t.failed && <span className="ml-auto text-paper-4">{t.lastSync ? fmtRelative(t.lastSync) : "sin sincronizar"}</span>}
          </div>
        </div>

        <div className="film-marks">
          <span>{filmNumber(profile.id)}</span>
          <span>▸ {fmtCompact(profile.mediaCount)} posts</span>
          <span>▸ {fmtCompact(profile.followers)}</span>
        </div>
      </motion.div>
    </motion.div>
  );
}

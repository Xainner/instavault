import { AnimatePresence, motion } from "motion/react";
import {
  ArrowLeft,
  BadgeCheck,
  ChevronDown,
  CloudDownload,
  Ellipsis,
  ExternalLink,
  Globe,
  ImageDown,
  KeyRound,
  Lock,
  RefreshCw,
  RotateCcw,
  Save,
  SquareCheck,
  Star,
  Trash,
  X,
  ZoomIn,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { toast } from "sonner";
import type { Highlight, Media, MediaKind, Profile, SyncResult, SyncState } from "@shared/types";
import { instagramProfileUrl } from "@shared/urls";
import { art } from "../assets";
import { call, errorMessage } from "../lib/api";
import { fmtBytes, fmtCompact, fmtInt, fmtRelative } from "../lib/format";
import { useStore } from "../store";
import { DevelopImage } from "../ui/DevelopImage";
import { Avatar, EmptyState, Menu, MenuItem, Modal, Spinner } from "../ui/primitives";
import { profileTotals } from "./library/FilmCard";
import { MediaGrid } from "./profile/MediaGrid";
import { applyFilter, groupPublications, type Filter, type Pub, type Tab } from "./profile/model";
import { Viewer } from "./Viewer";

const TAB_LABEL: Record<Tab, string> = { post: "Publicaciones", story: "Stories", highlight: "Highlights", album: "Álbum" };

export function ProfileView({ profileId }: { profileId: number }) {
  const store = useStore();
  const { profiles, navigate, remote, activity, defaultAccount, subscribe } = store;
  const profile = profiles.find((p) => p.id === profileId) ?? null;
  const [media, setMedia] = useState<Media[]>([]);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [sync, setSync] = useState<SyncState[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("post");
  const [filter, setFilter] = useState<Filter>("all");
  const [order, setOrder] = useState<"new" | "old">("new");
  const [cellMin, setCellMin] = useState(220);
  const [activeHighlight, setActiveHighlight] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [viewer, setViewer] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteFiles, setDeleteFiles] = useState(true);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const [m, h, s] = await Promise.all([
      call("media:list", { profileId }),
      call("media:highlights", { profileId }),
      call("sync:state", { profileId }),
    ]);
    setMedia(m);
    setHighlights(h);
    setSync(s);
    setLoading(false);
  }, [profileId]);

  useEffect(() => {
    setLoading(true);
    setTab("post");
    setSelected(new Set());
    setViewer(null);
    void load();
    scrollRef.current?.scrollTo({ top: 0 });
  }, [profileId, load]);

  useEffect(() => {
    let timer: number | null = null;
    const schedule = () => {
      if (timer) return;
      timer = window.setTimeout(() => {
        timer = null;
        void load();
      }, 400);
    };
    const off = subscribe((event) => {
      if (event.type === "media:changed" && event.profileId === profileId) schedule();
      if (event.type === "library:changed" && (event.profileIds.length === 0 || event.profileIds.includes(profileId))) schedule();
      if (event.type === "job:finished" && event.job.profileId === profileId) schedule();
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [subscribe, load, profileId]);

  const byKind = useMemo(() => {
    const out: Record<MediaKind, Media[]> = { post: [], story: [], highlight: [] };
    for (const m of media) out[m.kind].push(m);
    return out;
  }, [media]);

  const pubs = useMemo(() => {
    let source: Media[] = tab === "album" ? media : byKind[tab];
    if (tab === "highlight" && activeHighlight) source = source.filter((m) => m.highlightId === activeHighlight);
    let list = applyFilter(groupPublications(source, tab), filter);
    list = [...list].sort((a, b) => (order === "new" ? (b.takenAt ?? 0) - (a.takenAt ?? 0) : (a.takenAt ?? 0) - (b.takenAt ?? 0)));
    return list;
  }, [media, byKind, tab, filter, order, activeHighlight]);

  const tabCounts = useMemo(
    () => ({
      post: groupPublications(byKind.post, "post").length,
      story: byKind.story.length,
      highlight: byKind.highlight.length,
      album: media.filter((m) => m.status === "downloaded").length,
    }),
    [byKind, media],
  );

  const kindOfTab: MediaKind | undefined = tab === "album" ? undefined : tab;
  const scope = tab === "album" ? media : byKind[tab];
  const pending = scope.filter((m) => m.status === "pending").length;
  const failed = scope.filter((m) => m.status === "failed").length;
  const postSync = sync.find((s) => s.kind === "post") ?? null;
  const canContinue = postSync ? ["more_available", "anonymous_limit", "stalled"].includes(postSync.status) : false;

  // Atajos de teclado para la selección.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (viewer !== null || (e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "Escape" && selected.size) setSelected(new Set());
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelected(new Set(pubs.map((p) => p.key)));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pubs, selected.size, viewer]);

  if (!profile) {
    return (
      <div className="view-scroll grid place-items-center">
        {loading ? <Spinner size={22} /> : <div className="text-paper-3">Este perfil ya no está en tu archivo.</div>}
      </div>
    );
  }

  const isPrivate = Boolean(profile.isPrivate);
  const totals = profileTotals(profile);

  const runSync = async (kind: MediaKind, opts: { access?: "public" | "account"; continuation?: boolean; batchSize?: number } = {}) => {
    const access = opts.access ?? (kind !== "post" || isPrivate ? "account" : "public");
    if (access === "account" && !defaultAccount) {
      toast.error("Hace falta una cuenta conectada", {
        description: kind === "post" ? "Esta cuenta es privada." : "Instagram sólo muestra stories y highlights con sesión.",
        action: { label: "Conectar", onClick: () => navigate({ name: "accounts" }) },
      });
      return;
    }
    const result: SyncResult | null = await remote(
      (a, accountId) =>
        call("ig:sync", { profileId, kind, access: a, accountId, continuation: opts.continuation ?? false, batchSize: opts.batchSize }),
      { access },
    );
    if (!result) return;
    await load();
    const label = TAB_LABEL[kind].toLowerCase();
    if (result.status === "anonymous_limit") {
      toast.warning("Instagram limitó el modo anónimo", {
        description: `${result.newItems} nuevas. Puedes continuar con tu cuenta.`,
        action: defaultAccount ? { label: "Continuar con cuenta", onClick: () => void runSync("post", { access: "account", continuation: true }) } : undefined,
      });
    } else if (result.status === "rate_limited" || result.status === "challenge_required") {
      toast.error("Instagram pidió una pausa", { description: result.stopReason ?? undefined });
    } else {
      toast.success(`${TAB_LABEL[kind]} sincronizadas`, {
        description: `${result.newItems} nuevas · ${result.publications} ${label} revisadas${result.status === "more_available" ? " · hay más disponibles" : ""}`,
      });
    }
  };

  const startDownload = async (includeFailed: boolean, mediaIds?: number[], force = false) => {
    try {
      const job = await call("downloads:start", {
        profileId: mediaIds ? undefined : profileId,
        kind: mediaIds ? undefined : kindOfTab,
        mediaIds,
        includeFailed,
        force,
      });
      if (!job) toast("Nada que revelar", { description: "Todo lo seleccionado ya está descargado." });
      else toast(`Revelando ${job.total} ${job.total === 1 ? "pieza" : "piezas"}`, { description: "Puedes seguir navegando mientras tanto." });
    } catch (error) {
      toast.error("No se pudo iniciar la descarga", { description: errorMessage(error) });
    }
  };

  const toggle = (index: number, event: MouseEvent) => {
    const pub = pubs[index];
    setSelected((prev) => {
      const next = new Set(prev);
      if (event.shiftKey && anchor !== null) {
        const [a, b] = [Math.min(anchor, index), Math.max(anchor, index)];
        for (let i = a; i <= b; i++) next.add(pubs[i].key);
      } else if (next.has(pub.key)) next.delete(pub.key);
      else next.add(pub.key);
      return next;
    });
    setAnchor(index);
  };

  const selectedItems = pubs.filter((p) => selected.has(p.key)).flatMap((p) => p.items);
  const coverImages = profile.cover.length ? profile.cover : [art.cover];
  const accessLabel = isPrivate
    ? defaultAccount
      ? `Privado · @${defaultAccount.username}`
      : "Privado · requiere cuenta"
    : postSync?.access === "account"
      ? `Público · completado con @${defaultAccount?.username ?? "cuenta"}`
      : "Público · anónimo";

  const syncPrimary =
    tab === "story"
      ? { label: "Sincronizar stories", run: () => runSync("story") }
      : tab === "highlight"
        ? { label: "Sincronizar highlights", run: () => runSync("highlight") }
        : canContinue
          ? {
              label: postSync?.status === "anonymous_limit" && defaultAccount ? "Continuar con cuenta" : "Continuar",
              run: () => runSync("post", { continuation: true, access: postSync?.status === "anonymous_limit" && defaultAccount ? "account" : undefined }),
            }
          : { label: "Sincronizar", run: () => runSync("post") };

  return (
    <div ref={scrollRef} className="view-scroll">
      {/* ------------------------------------------------------------ HERO */}
      <section className="hero">
        <div className="hero-bg" aria-hidden>
          {[...coverImages, ...coverImages].slice(0, 8).map((src, i) => (
            <img key={i} src={src} alt="" />
          ))}
        </div>
        <div className="mx-auto max-w-[1480px] px-10 pb-9 pt-6">
          <button className="btn btn-sm btn-ghost -ml-2 mb-6" onClick={() => navigate({ name: "library" })}>
            <ArrowLeft size={15} /> Archivo
          </button>
          <div className="flex items-end gap-8">
            <motion.div initial={{ scale: 0.92, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}>
              <Avatar src={profile.avatarUrl} name={profile.username} size={128} ring />
            </motion.div>
            <div className="min-w-0 flex-1 pb-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`tag ${isPrivate ? "tag-amber" : ""}`}>
                  {isPrivate ? <Lock size={11} /> : <Globe size={11} />} {accessLabel}
                </span>
                {profile.isVerified && (
                  <span className="tag tag-amber">
                    <BadgeCheck size={12} /> Verificada
                  </span>
                )}
                <span className="tag mono">{fmtRelative(totals.lastSync)}</span>
              </div>
              <motion.h1
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.05, duration: 0.5 }}
                className="display mt-3 truncate text-[68px] text-paper"
              >
                {profile.fullName ?? profile.username}
              </motion.h1>
              <div className="mono mt-1 text-[13px] text-amber-2">@{profile.username}</div>
              {profile.biography && <p className="line-clamp-2 mt-3 max-w-[70ch] text-[14px] leading-relaxed text-paper-2" data-selectable>{profile.biography}</p>}
            </div>
          </div>

          <div className="mt-8 flex flex-wrap items-end justify-between gap-6">
            <div className="flex gap-10">
              {[
                { label: "publicaciones", value: fmtCompact(profile.mediaCount) },
                { label: "seguidores", value: fmtCompact(profile.followers) },
                { label: "seguidos", value: fmtCompact(profile.following) },
                { label: "en archivo", value: `${fmtInt(totals.downloaded)}/${fmtInt(totals.total)}` },
                { label: "en disco", value: fmtBytes(profile.bytes) },
              ].map((s) => (
                <div key={s.label}>
                  <div className="numeral text-[40px] leading-none text-paper">{s.value}</div>
                  <div className="eyebrow mt-2">{s.label}</div>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <div className="split">
                <button className="btn btn-primary btn-lg" onClick={() => void syncPrimary.run()} disabled={Boolean(activity)}>
                  {activity?.profileId === profileId ? <Spinner size={15} /> : <RefreshCw size={16} />}
                  {activity?.profileId === profileId ? activity.stage : syncPrimary.label}
                </button>
                <Menu
                  width={280}
                  trigger={({ toggle }) => (
                    <button className="btn btn-primary btn-lg" onClick={toggle} disabled={Boolean(activity)} aria-label="Más opciones de sincronización">
                      <ChevronDown size={16} />
                    </button>
                  )}
                >
                  {(close) => (
                    <>
                      <MenuItem icon={<RefreshCw size={15} />} onClick={() => (close(), void runSync("post"))} hint={isPrivate ? "cuenta" : "anónimo"}>
                        Publicaciones recientes
                      </MenuItem>
                      <MenuItem icon={<KeyRound size={15} />} onClick={() => (close(), void runSync("post", { access: "account", continuation: canContinue }))} hint="cuenta">
                        Continuar con mi cuenta
                      </MenuItem>
                      <MenuItem icon={<KeyRound size={15} />} onClick={() => (close(), void runSync("post", { access: "account", batchSize: 5000 }))} hint="cuenta">
                        Traer el perfil completo
                      </MenuItem>
                      <div className="divider my-1.5" />
                      <MenuItem icon={<RefreshCw size={15} />} onClick={() => (close(), void runSync("story"))} hint="cuenta">
                        Stories activas
                      </MenuItem>
                      <MenuItem icon={<RefreshCw size={15} />} onClick={() => (close(), void runSync("highlight"))} hint="cuenta">
                        Highlights
                      </MenuItem>
                    </>
                  )}
                </Menu>
              </div>
              <button className="btn btn-lg" onClick={() => void startDownload(false)} disabled={!pending}>
                <CloudDownload size={16} /> Revelar {pending ? fmtInt(pending) : ""}
              </button>
              {failed > 0 && (
                <button className="btn btn-lg btn-danger" onClick={() => void startDownload(true)}>
                  <RotateCcw size={15} /> Reintentar {failed}
                </button>
              )}
              <Menu
                trigger={({ toggle }) => (
                  <button className="btn btn-lg px-3" onClick={toggle} aria-label="Más acciones">
                    <Ellipsis size={18} />
                  </button>
                )}
              >
                {(close) => (
                  <>
                    <MenuItem
                      icon={<Star size={15} className={profile.isFavorite ? "fill-amber text-amber" : ""} />}
                      onClick={() => (close(), void call("profiles:setFavorite", { profileId, favorite: !profile.isFavorite }))}
                    >
                      {profile.isFavorite ? "Quitar de favoritos" : "Añadir a favoritos"}
                    </MenuItem>
                    <MenuItem icon={<ImageDown size={15} />} onClick={() => (close(), void call("export:avatar", { profileId }).catch((e) => toast.error(errorMessage(e))))}>
                      Guardar foto de perfil
                    </MenuItem>
                    <MenuItem icon={<ExternalLink size={15} />} onClick={() => (close(), void call("app:openExternal", { url: instagramProfileUrl(profile.username) }))}>
                      Abrir en Instagram
                    </MenuItem>
                    <div className="divider my-1.5" />
                    <MenuItem icon={<Trash size={15} />} danger onClick={() => (close(), setConfirmDelete(true))}>
                      Eliminar del archivo
                    </MenuItem>
                  </>
                )}
              </Menu>
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------- TOOLBAR */}
      <div className="sticky-bar">
        <div className="mx-auto flex max-w-[1480px] items-center gap-7 px-10">
          {(["post", "story", "highlight", "album"] as Tab[]).map((t) => (
            <button
              key={t}
              className="tab"
              data-active={tab === t}
              onClick={() => {
                setTab(t);
                setFilter("all");
                setSelected(new Set());
                setActiveHighlight(null);
              }}
            >
              {TAB_LABEL[t]}
              <span className="mono text-[10.5px] text-paper-4">{fmtInt(tabCounts[t])}</span>
              {tab === t && <motion.span layoutId="tab-underline" className="tab-underline" transition={{ type: "spring", stiffness: 500, damping: 40 }} />}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2 py-2">
            {(
              [
                ["all", "Todo"],
                ["photo", "Fotos"],
                ["video", "Videos"],
                ...(tab === "post" ? [["carousel", "Carruseles"]] : []),
                ...(tab !== "album"
                  ? [
                      ["pending", "Pendientes"],
                      ["failed", "Con error"],
                      ["downloaded", "Reveladas"],
                    ]
                  : []),
              ] as Array<[Filter, string]>
            ).map(([value, label]) => (
              <button key={value} className="chip h-[26px] text-[12px]" data-active={filter === value} onClick={() => setFilter(value)}>
                {label}
              </button>
            ))}
            <div className="mx-2 h-5 w-px bg-line-2" />
            <button className="chip h-[26px] text-[12px]" onClick={() => setOrder(order === "new" ? "old" : "new")}>
              {order === "new" ? "Más recientes" : "Más antiguas"}
            </button>
            <label className="flex items-center gap-2 pl-2 text-paper-3" title="Tamaño de la cuadrícula">
              <ZoomIn size={14} />
              <input
                type="range"
                min={140}
                max={360}
                value={cellMin}
                onChange={(e) => setCellMin(Number(e.target.value))}
                className="range w-24"
                style={{ ["--p" as string]: `${((cellMin - 140) / 220) * 100}%` }}
              />
            </label>
          </div>
        </div>
      </div>

      {/* --------------------------------------------------------- CUERPO */}
      <div className="mx-auto max-w-[1480px] px-10 pb-32 pt-6">
        {tab === "post" && postSync?.status === "anonymous_limit" && (
          <LimitBanner
            reason={postSync.stopReason}
            accountName={defaultAccount?.username ?? null}
            onContinue={() => void runSync("post", { access: "account", continuation: true })}
            onConnect={() => navigate({ name: "accounts" })}
          />
        )}

        {tab === "highlight" && highlights.length > 0 && (
          <div className="mb-7 flex gap-5 overflow-x-auto pb-2">
            <HighlightBubble active={activeHighlight === null} title="Todos" onClick={() => setActiveHighlight(null)} count={byKind.highlight.length} />
            {highlights.map((h) => (
              <HighlightBubble
                key={h.id}
                active={activeHighlight === h.highlightId}
                title={h.title || "Sin título"}
                cover={h.coverUrl}
                count={h.itemCount}
                onClick={() => setActiveHighlight(h.highlightId)}
              />
            ))}
          </div>
        )}

        {loading ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2.5">
            {Array.from({ length: 12 }, (_, i) => (
              <div key={i} className="skeleton aspect-[4/5] rounded-[10px]" />
            ))}
          </div>
        ) : pubs.length === 0 ? (
          <TabEmpty
            tab={tab}
            filtered={filter !== "all"}
            isPrivate={isPrivate}
            hasAccount={Boolean(defaultAccount)}
            pending={pending}
            onSync={() => void syncPrimary.run()}
            onDownload={() => void startDownload(false)}
            onConnect={() => navigate({ name: "accounts" })}
            busy={Boolean(activity)}
          />
        ) : (
          <MediaGrid
            pubs={pubs}
            scrollRef={scrollRef}
            cellMin={tab === "story" || tab === "highlight" ? Math.round(cellMin * 0.74) : cellMin}
            ratio={tab === "story" || tab === "highlight" ? 16 / 9 : 5 / 4}
            selected={selected}
            onToggle={toggle}
            onOpen={(index) => setViewer(index)}
            showScrubber={tab === "post" || tab === "album"}
          />
        )}
      </div>

      {/* ---------------------------------------------------- SELECCIÓN */}
      <AnimatePresence>
        {selected.size > 0 && (
          <motion.div
            initial={{ y: 80, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 80, opacity: 0 }}
            transition={{ type: "spring", stiffness: 380, damping: 34 }}
            className="pointer-events-none fixed bottom-6 right-0 z-40 flex justify-center"
            style={{ left: "var(--rail-w)" }}
          >
            <div className="panel pointer-events-auto flex items-center gap-2 px-3 py-2.5">
            <div className="flex items-center gap-2 pl-2 pr-3">
              <SquareCheck size={16} className="text-amber-2" />
              <span className="text-[13px]">
                <span className="numeral text-[20px]">{selected.size}</span> seleccionadas
              </span>
            </div>
            <button className="btn btn-sm btn-primary" onClick={() => void startDownload(true, selectedItems.map((m) => m.id))}>
              <CloudDownload size={14} /> Revelar
            </button>
            <button
              className="btn btn-sm"
              onClick={async () => {
                try {
                  const result = await call("export:media", { mediaIds: selectedItems.map((m) => m.id) });
                  if (result.exported) toast.success(`${result.exported} piezas guardadas`, { description: result.folder ?? undefined });
                } catch (error) {
                  toast.error("No se pudo guardar", { description: errorMessage(error) });
                }
              }}
            >
              <Save size={14} /> Guardar en el equipo
            </button>
            <button className="btn btn-sm" onClick={() => void startDownload(true, selectedItems.map((m) => m.id), true)}>
              <RotateCcw size={14} /> Re-descargar
            </button>
            <button className="btn btn-sm btn-ghost text-[#ff9f90]" onClick={() => setConfirmRemove(true)}>
              <Trash size={14} /> Quitar
            </button>
            <button className="icon-btn" onClick={() => setSelected(new Set())} aria-label="Limpiar selección">
              <X size={16} />
            </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {viewer !== null && pubs[viewer] && (
        <Viewer
          profile={profile}
          pubs={pubs}
          index={viewer}
          onIndex={setViewer}
          onClose={() => setViewer(null)}
          onDownload={(ids, force) => void startDownload(true, ids, force)}
        />
      )}

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={
          <>
            ¿Eliminar a <em>@{profile.username}</em>?
          </>
        }
        description="Se quitará el perfil y todas sus piezas de tu archivo. Esto no afecta a Instagram."
      >
        <label className="flex cursor-pointer items-center gap-2.5 text-[13px] text-paper-2">
          <input type="checkbox" className="accent-[#e0a458]" checked={deleteFiles} onChange={(e) => setDeleteFiles(e.target.checked)} />
          Borrar también los archivos descargados ({fmtBytes(profile.bytes)})
        </label>
        <div className="mt-6 flex justify-end gap-2">
          <button className="btn btn-ghost" onClick={() => setConfirmDelete(false)}>
            Cancelar
          </button>
          <button
            className="btn btn-danger"
            onClick={async () => {
              try {
                await call("profiles:delete", { profileId, deleteFiles });
                setConfirmDelete(false);
                navigate({ name: "library" });
                toast.success(`@${profile.username} eliminado del archivo`);
              } catch (error) {
                toast.error("No se pudo eliminar", { description: errorMessage(error) });
              }
            }}
          >
            <Trash size={14} /> Eliminar
          </button>
        </div>
      </Modal>

      <Modal
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title={`¿Quitar ${selected.size} del archivo?`}
        description="Se quitan de la biblioteca local. Si vuelves a sincronizar, reaparecerán como pendientes."
      >
        <div className="mt-2 flex justify-end gap-2">
          <button className="btn btn-ghost" onClick={() => setConfirmRemove(false)}>
            Cancelar
          </button>
          <button
            className="btn btn-danger"
            onClick={async () => {
              try {
                await call("media:remove", { mediaIds: selectedItems.map((m) => m.id) });
                setSelected(new Set());
                setConfirmRemove(false);
                await load();
              } catch (error) {
                toast.error("No se pudo quitar", { description: errorMessage(error) });
              }
            }}
          >
            Quitar
          </button>
        </div>
      </Modal>
    </div>
  );
}

function HighlightBubble({ title, cover, count, active, onClick }: { title: string; cover?: string | null; count: number; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className="group flex w-[86px] flex-none flex-col items-center gap-2">
      <div className={`rounded-full p-[3px] transition ${active ? "bg-[conic-gradient(from_200deg,#f3c88a,#c8743a,#6b3d1a,#f3c88a)] shadow-[0_0_20px_-4px_rgba(224,164,88,0.7)]" : "bg-line-2 group-hover:bg-paper-4"}`}>
        <div className="h-[74px] w-[74px] overflow-hidden rounded-full border-[3px] border-ink-1 bg-ink-3">
          {cover ? <DevelopImage src={cover} className="h-full w-full object-cover" /> : <div className="grid h-full w-full place-items-center display text-[22px] text-paper-3">{count}</div>}
        </div>
      </div>
      <span className={`w-full truncate text-center text-[12px] ${active ? "text-paper" : "text-paper-3"}`}>{title}</span>
    </button>
  );
}

function LimitBanner({ reason, accountName, onContinue, onConnect }: { reason: string | null; accountName: string | null; onContinue: () => void; onConnect: () => void }) {
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="panel mb-7 flex items-center gap-6 overflow-hidden p-0 pr-6">
      <div className="illustration h-[108px] w-[180px] flex-none rounded-none rounded-l-[24px]">
        <img src={art.limitArt} alt="" />
      </div>
      <div className="min-w-0 flex-1 py-4">
        <div className="eyebrow text-safelight">Luz roja</div>
        <div className="display mt-1 text-[26px]">Instagram cerró el modo anónimo aquí.</div>
        <p className="mt-1 text-[13px] text-paper-2">{reason ?? "El avance quedó guardado. Puedes continuar con una cuenta que vea este perfil."}</p>
      </div>
      {accountName ? (
        <button className="btn btn-primary" onClick={onContinue}>
          <KeyRound size={15} /> Continuar con @{accountName}
        </button>
      ) : (
        <button className="btn" onClick={onConnect}>
          <KeyRound size={15} /> Conectar una cuenta
        </button>
      )}
    </motion.div>
  );
}

function TabEmpty({
  tab,
  filtered,
  isPrivate,
  hasAccount,
  pending,
  onSync,
  onDownload,
  onConnect,
  busy,
}: {
  tab: Tab;
  filtered: boolean;
  isPrivate: boolean;
  hasAccount: boolean;
  pending: number;
  onSync: () => void;
  onDownload: () => void;
  onConnect: () => void;
  busy: boolean;
}) {
  if (filtered) return <div className="py-24 text-center text-paper-3">Nada coincide con este filtro.</div>;
  const needsAccount = (tab === "story" || tab === "highlight" || isPrivate) && !hasAccount;
  if (needsAccount) {
    return (
      <EmptyState
        compact
        art={art.privateArt}
        eyebrow={isPrivate ? "Cuenta privada" : "Requiere sesión"}
        title={
          <>
            Esta puerta se abre <em>con llave</em>.
          </>
        }
        actions={
          <button className="btn btn-primary" onClick={onConnect}>
            <KeyRound size={15} /> Conectar una cuenta
          </button>
        }
      >
        {isPrivate
          ? "Para ver una cuenta privada necesitas conectar una cuenta de Instagram que la siga. La sesión vive en su propio navegador aislado."
          : "Instagram sólo muestra stories y highlights con una sesión iniciada. Conecta tu cuenta para traerlos."}
      </EmptyState>
    );
  }
  if (tab === "album") {
    return (
      <EmptyState
        compact
        art={art.emptyMedia}
        eyebrow="Álbum"
        title={
          <>
            Nada <em>revelado</em> todavía.
          </>
        }
        actions={
          pending ? (
            <button className="btn btn-primary" onClick={onDownload}>
              <CloudDownload size={15} /> Revelar {pending} pendientes
            </button>
          ) : null
        }
      >
        Aquí aparece todo lo que ya está guardado en tu equipo, en máxima calidad.
      </EmptyState>
    );
  }
  return (
    <EmptyState
      compact
      art={art.emptyMedia}
      eyebrow={TAB_LABEL[tab]}
      title={
        tab === "story" ? (
          <>
            Las stories duran <em>24 horas</em>.
          </>
        ) : (
          <>
            La bandeja está <em>vacía</em>.
          </>
        )
      }
      actions={
        <button className="btn btn-primary" onClick={onSync} disabled={busy}>
          <RefreshCw size={15} /> Sincronizar {TAB_LABEL[tab].toLowerCase()}
        </button>
      }
    >
      {tab === "story" ? "Sincroniza para guardar las que estén activas ahora mismo." : "Sincroniza para traer el contenido de este perfil a tu archivo."}
    </EmptyState>
  );
}

export type { Pub, Profile };

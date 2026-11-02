import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, BadgeCheck, LayoutGrid, Link2, List, Lock, Search, Star, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { Profile } from "@shared/types";
import { art } from "../assets";
import { call } from "../lib/api";
import { fmtBytes, fmtCompact, fmtRelative } from "../lib/format";
import { useStore } from "../store";
import { DevelopImage } from "../ui/DevelopImage";
import { Avatar, Counter, EmptyState, Segmented, Spinner } from "../ui/primitives";
import { FilmCard, profileTotals } from "./library/FilmCard";

type Filter = "all" | "public" | "private" | "pending" | "failed";
type Sort = "recent" | "name" | "size";

const looksLikeUrl = (q: string) => /instagram\.com\/|instagr\.am\//i.test(q);

function readPref<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(key) as T) || fallback;
  } catch {
    return fallback;
  }
}

export function LibraryView() {
  const { profiles, stats, navigate, remote, loaded, developing, progress, activity } = useStore();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>(() => readPref("iv.sort", "recent"));
  const [layout, setLayout] = useState<"grid" | "list">(() => readPref("iv.layout", "grid"));
  const [searching, setSearching] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const hasLive = Object.keys(progress).length > 0;

  const q = query.trim().replace(/^@/, "").toLowerCase();
  const visible = useMemo(() => {
    let list = profiles.filter((p) => !q || looksLikeUrl(query) || p.username.includes(q) || (p.fullName ?? "").toLowerCase().includes(q));
    list = list.filter((p) => {
      const t = profileTotals(p);
      if (filter === "public") return !p.isPrivate;
      if (filter === "private") return p.isPrivate;
      if (filter === "pending") return t.pending > 0;
      if (filter === "failed") return t.failed > 0;
      return true;
    });
    const sorted = [...list];
    if (sort === "name") sorted.sort((a, b) => a.username.localeCompare(b.username));
    else if (sort === "size") sorted.sort((a, b) => profileTotals(b).total - profileTotals(a).total);
    else sorted.sort((a, b) => (b.lastActivity ?? b.createdAt) - (a.lastActivity ?? a.createdAt));
    return sorted;
  }, [profiles, q, query, filter, sort]);
  const favorites = profiles.filter((p) => p.isFavorite);
  const exact = profiles.find((p) => p.username === q);
  const canLookup = q.length >= 2 && /^[a-z0-9._]+$/.test(q) && !exact && !looksLikeUrl(query);

  const submit = async () => {
    if (!query.trim()) return;
    if (looksLikeUrl(query)) return navigate({ name: "quick", url: query.trim() });
    if (exact) return navigate({ name: "profile", id: exact.id });
    if (!canLookup) return;
    setSearching(true);
    const profile = await remote((access, accountId) => call("ig:lookup", { username: q, access, accountId }));
    setSearching(false);
    if (profile) {
      toast.success(`@${profile.username} entra en tu archivo`, {
        description: profile.isPrivate ? "Es una cuenta privada: sincroniza con una cuenta que la siga." : "Perfil y primeras publicaciones guardados.",
      });
      setQuery("");
      navigate({ name: "profile", id: profile.id });
    }
  };

  const counts = useMemo(() => {
    const c = { all: profiles.length, public: 0, private: 0, pending: 0, failed: 0 };
    for (const p of profiles) {
      const t = profileTotals(p);
      if (p.isPrivate) c.private++;
      else c.public++;
      if (t.pending) c.pending++;
      if (t.failed) c.failed++;
    }
    return c;
  }, [profiles]);

  const searchField = (
    <div className="field h-[54px] rounded-[16px] px-5">
      {searching ? <Spinner size={18} /> : looksLikeUrl(query) ? <Link2 size={18} className="text-amber-2" /> : <Search size={18} className="text-paper-3" />}
      <input
        ref={input}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
          if (e.key === "Escape") setQuery("");
        }}
        placeholder="Busca @usuario o pega un enlace de Instagram…"
        className="text-[15.5px]"
        spellCheck={false}
      />
      {query && (
        <button className="icon-btn h-7 w-7" onClick={() => setQuery("")} aria-label="Limpiar">
          <X size={14} />
        </button>
      )}
      {(canLookup || looksLikeUrl(query)) && (
        <button className="btn btn-sm btn-primary" onClick={() => void submit()} disabled={searching || Boolean(activity)}>
          {looksLikeUrl(query) ? "Abrir enlace" : `Buscar @${q}`} <ArrowRight size={14} />
        </button>
      )}
    </div>
  );

  if (loaded && profiles.length === 0) {
    return (
      <div className="view-scroll">
        <div className="mx-auto max-w-[1180px] px-10 pt-10">
          <EmptyState
            art={art.emptyProfiles}
            eyebrow="Archivo vacío"
            title={
              <>
                Una hoja de contactos <em>esperando</em> su primera toma.
              </>
            }
            actions={<div className="w-full">{searchField}</div>}
          >
            Escribe el @usuario de un perfil público para guardar su perfil y sus primeras publicaciones, o pega el enlace de una
            publicación, reel, story o highlight. Todo se guarda en este equipo.
          </EmptyState>
        </div>
      </div>
    );
  }

  return (
    <div className="view-scroll">
      <div className="mx-auto max-w-[1480px] px-10 pb-24 pt-10">
        <header className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-8">
          <div>
            <div className="eyebrow">Archivo personal · {new Date().toLocaleDateString("es", { month: "long", year: "numeric" })}</div>
            <h1 className="display mt-3 text-[92px] text-paper">
              Tu <em>archivo</em>
            </h1>
          </div>
          <div className="flex items-end gap-8 pb-3">
            {[
              { label: "perfiles", value: stats?.profiles ?? 0 },
              { label: "piezas", value: stats?.media ?? 0 },
              { label: "reveladas", value: stats?.downloaded ?? 0 },
            ].map((item) => (
              <div key={item.label} className="text-right">
                <div className="text-[44px] leading-none text-paper">
                  <Counter value={item.value} />
                </div>
                <div className="eyebrow mt-2">{item.label}</div>
              </div>
            ))}
            <div className="text-right">
              <div className="numeral text-[44px] leading-none text-amber-2">{fmtBytes(stats?.bytes ?? 0)}</div>
              <div className="eyebrow mt-2">en disco</div>
            </div>
          </div>
        </header>

        <div className="mt-8">{searchField}</div>

        <AnimatePresence>
          {hasLive && developing.length > 0 && (
            <motion.section initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
              <div className="mt-7 flex items-center gap-4">
                <div className="flex items-center gap-2.5">
                  <span className="safelight-dot" />
                  <span className="eyebrow text-amber-2">Revelando ahora</span>
                </div>
                <div className="developing-strip flex-1">
                  {developing.slice(0, 24).map((src) => (
                    <motion.div key={src} layout initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }}>
                      <DevelopImage src={src} />
                    </motion.div>
                  ))}
                </div>
              </div>
            </motion.section>
          )}
        </AnimatePresence>

        {favorites.length > 0 && !q && filter === "all" && (
          <section className="mt-12">
            <div className="mb-5 flex items-baseline gap-3">
              <Star size={15} className="fill-amber text-amber" />
              <h2 className="display text-[34px]">Favoritos</h2>
              <span className="mono text-[11px] text-paper-4">{favorites.length}</span>
            </div>
            <div className="-mx-10 flex gap-6 overflow-x-auto px-10 pb-6 pt-2">
              {favorites.map((p, i) => (
                <FilmCard key={p.id} profile={p} large index={i} />
              ))}
            </div>
          </section>
        )}

        <section className="mt-10">
          <div className="mb-6 flex flex-wrap items-center gap-3">
            <h2 className="display mr-3 text-[34px]">{q ? "Resultados" : "Todos los perfiles"}</h2>
            {(
              [
                ["all", "Todos"],
                ["public", "Públicos"],
                ["private", "Privados"],
                ["pending", "Con pendientes"],
                ["failed", "Con errores"],
              ] as Array<[Filter, string]>
            ).map(([value, label]) => (
              <button key={value} className="chip" data-active={filter === value} onClick={() => setFilter(value)}>
                {label} <span className="count">{counts[value]}</span>
              </button>
            ))}
            <div className="ml-auto flex items-center gap-3">
              <Segmented
                id="sort"
                value={sort}
                onChange={(v) => {
                  setSort(v);
                  try {
                    localStorage.setItem("iv.sort", v);
                  } catch {
                    /* preferencia opcional */
                  }
                }}
                options={[
                  { value: "recent", label: "Recientes" },
                  { value: "name", label: "Nombre" },
                  { value: "size", label: "Más piezas" },
                ]}
              />
              <Segmented
                id="layout"
                value={layout}
                onChange={(v) => {
                  setLayout(v);
                  try {
                    localStorage.setItem("iv.layout", v);
                  } catch {
                    /* preferencia opcional */
                  }
                }}
                options={[
                  { value: "grid", label: <LayoutGrid size={14} /> },
                  { value: "list", label: <List size={14} /> },
                ]}
              />
            </div>
          </div>

          {visible.length === 0 ? (
            <div className="rounded-3xl py-20 text-center text-paper-3 shadow-[inset_0_0_0_1px_rgba(240,220,195,0.06)]">
              {canLookup ? (
                <>
                  <div className="display text-[30px] text-paper-2">@{q} todavía no está en tu archivo</div>
                  <button className="btn btn-primary mt-6" onClick={() => void submit()} disabled={searching}>
                    {searching ? <Spinner size={14} /> : <Search size={15} />} Buscar en Instagram
                  </button>
                </>
              ) : (
                "Ningún perfil coincide con estos filtros."
              )}
            </div>
          ) : layout === "grid" ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(310px,1fr))] gap-x-6 gap-y-8">
              {visible.map((p, i) => (
                <FilmCard key={p.id} profile={p} index={i} />
              ))}
            </div>
          ) : (
            <ProfileList profiles={visible} />
          )}
        </section>
      </div>
    </div>
  );
}

function ProfileList({ profiles }: { profiles: Profile[] }) {
  const { navigate } = useStore();
  return (
    <div className="panel overflow-hidden">
      <div className="grid grid-cols-[minmax(0,2.2fr)_1fr_1fr_1.4fr_1fr] gap-4 border-b border-line px-5 py-3">
        {["Perfil", "Seguidores", "Piezas", "Revelado", "Última sync"].map((h) => (
          <div key={h} className="eyebrow">
            {h}
          </div>
        ))}
      </div>
      {profiles.map((p) => {
        const t = profileTotals(p);
        const pct = t.total ? Math.round((t.downloaded / t.total) * 100) : 0;
        return (
          <button
            key={p.id}
            onClick={() => navigate({ name: "profile", id: p.id })}
            className="grid w-full grid-cols-[minmax(0,2.2fr)_1fr_1fr_1.4fr_1fr] items-center gap-4 border-b border-line px-5 py-3 text-left transition last:border-0 hover:bg-ink-3/60"
          >
            <div className="flex min-w-0 items-center gap-3">
              <Avatar src={p.avatarUrl} name={p.username} size={36} ring={p.isFavorite} />
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 truncate text-[14px] text-paper">
                  {p.fullName ?? p.username}
                  {p.isVerified && <BadgeCheck size={13} className="text-amber-2" />}
                  {p.isPrivate && <Lock size={12} className="text-paper-3" />}
                </div>
                <div className="mono truncate text-[11.5px] text-paper-3">@{p.username}</div>
              </div>
            </div>
            <div className="numeral text-[20px] text-paper-2">{fmtCompact(p.followers)}</div>
            <div className="mono text-[12px] text-paper-2">
              {t.total.toLocaleString("es")} <span className="text-paper-4">· {fmtBytes(p.bytes)}</span>
            </div>
            <div className="flex items-center gap-3">
              <div className="progress flex-1">
                <i style={{ width: `${pct}%` }} />
              </div>
              <span className="mono w-9 text-right text-[11.5px] text-paper-2">{pct}%</span>
            </div>
            <div className="text-[12.5px] text-paper-3">{t.lastSync ? fmtRelative(t.lastSync) : "—"}</div>
          </button>
        );
      })}
    </div>
  );
}

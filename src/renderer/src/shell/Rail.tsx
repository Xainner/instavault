import { motion } from "motion/react";
import { Archive, KeyRound, Link2, SlidersHorizontal, Star } from "lucide-react";
import type { ReactNode } from "react";
import { fmtBytes } from "../lib/format";
import { useStore, type Route } from "../store";
import { Avatar } from "../ui/primitives";

const NAV: Array<{ route: Route["name"]; label: string; icon: ReactNode; hint?: string }> = [
  { route: "library", label: "Archivo", icon: <Archive size={17} strokeWidth={1.7} /> },
  { route: "quick", label: "Descargar por enlace", icon: <Link2 size={17} strokeWidth={1.7} /> },
  { route: "accounts", label: "Cuentas", icon: <KeyRound size={17} strokeWidth={1.7} /> },
  { route: "settings", label: "Ajustes", icon: <SlidersHorizontal size={17} strokeWidth={1.7} /> },
];

export function Rail() {
  const { route, navigate, profiles, stats, accounts, info } = useStore();
  const favorites = profiles.filter((p) => p.isFavorite).slice(0, 8);
  const activeName = route.name === "profile" ? "library" : route.name;
  const validAccounts = accounts.filter((a) => a.status === "valid").length;

  return (
    <nav className="rail pt-5">
      <div className="eyebrow mb-2 px-[22px]">Laboratorio</div>
      <div className="flex flex-col gap-0.5">
        {NAV.map((item) => (
          <button
            key={item.route}
            className="nav-item"
            data-active={activeName === item.route}
            onClick={() => navigate({ name: item.route } as Route)}
          >
            {activeName === item.route && (
              <motion.span layoutId="nav-pill" className="nav-pill" transition={{ type: "spring", stiffness: 420, damping: 36 }} />
            )}
            <span className="relative z-10 text-current">{item.icon}</span>
            <span className="relative z-10 flex-1 text-left">{item.label}</span>
            {item.route === "library" && stats ? (
              <span className="mono relative z-10 text-[10.5px] text-paper-4">{stats.profiles}</span>
            ) : null}
            {item.route === "accounts" ? (
              <span className={`relative z-10 h-1.5 w-1.5 rounded-full ${validAccounts ? "bg-sage shadow-[0_0_8px_rgba(156,191,134,0.8)]" : "bg-paper-4"}`} />
            ) : null}
          </button>
        ))}
      </div>

      {favorites.length > 0 && (
        <>
          <div className="eyebrow mb-2 mt-7 flex items-center gap-2 px-[22px]">
            <Star size={10} /> Favoritos
          </div>
          <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
            {favorites.map((p) => (
              <button
                key={p.id}
                className="nav-item h-[42px]"
                data-active={route.name === "profile" && route.id === p.id}
                onClick={() => navigate({ name: "profile", id: p.id })}
              >
                {route.name === "profile" && route.id === p.id && (
                  <motion.span layoutId="nav-pill" className="nav-pill" transition={{ type: "spring", stiffness: 420, damping: 36 }} />
                )}
                <span className="relative z-10">
                  <Avatar src={p.avatarUrl} name={p.username} size={24} />
                </span>
                <span className="relative z-10 min-w-0 flex-1 truncate text-left text-[13px]">{p.fullName ?? p.username}</span>
              </button>
            ))}
          </div>
        </>
      )}

      <div className="mt-auto px-[22px] pb-5 pt-6">
        <div className="divider mb-4" />
        <div className="flex items-baseline justify-between">
          <span className="eyebrow">Almacén</span>
          <span className="mono text-[11px] text-paper-2">{fmtBytes(stats?.bytes ?? 0)}</span>
        </div>
        <div className="progress mt-2">
          <i style={{ width: `${stats && stats.media ? Math.max(3, (stats.downloaded / stats.media) * 100) : 0}%` }} />
        </div>
        <div className="mt-2 flex justify-between text-[11px] text-paper-3">
          <span>
            {stats?.downloaded.toLocaleString("es") ?? 0} / {stats?.media.toLocaleString("es") ?? 0} piezas
          </span>
          <span className="mono text-paper-4">v{info?.version ?? ""}</span>
        </div>
      </div>
    </nav>
  );
}

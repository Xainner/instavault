import { motion } from "framer-motion";
import { Download, KeyRound, LayoutGrid, ShieldCheck } from "lucide-react";
import type { AccountInfo } from "../types";
import { useDownloads } from "./Downloads";

export type View = "profiles" | "accounts";

export function Sidebar({
  view,
  setView,
  accounts,
  activeAccount,
  setAccountId,
  profileCount,
  mediaCount,
  dlOpen,
  onOpenDownloads,
  downloadedCount,
}: {
  view: View;
  setView: (v: View) => void;
  accounts: AccountInfo[];
  activeAccount: number;
  setAccountId: (id: number) => void;
  profileCount: number;
  mediaCount: number;
  dlOpen: boolean;
  onOpenDownloads: () => void;
  downloadedCount: number;
}) {
  const dl = useDownloads();
  const items: { id: View; label: string; icon: React.ReactNode; badge: number }[] = [
    { id: "profiles", label: "Perfiles", icon: <LayoutGrid size={18} />, badge: profileCount },
    { id: "accounts", label: "Cuentas", icon: <KeyRound size={18} />, badge: accounts.length },
  ];

  return (
    <aside className="sidebar">
      {/* Logo */}
      <div className="side-logo">
        <img src="/logo.png" alt="InstaVault" />
      </div>

      {/* Navegación */}
      <nav className="side-nav">
        <div className="side-label">Menú</div>
        {items.map((it) => (
          <button
            key={it.id}
            className={`nav-item ${view === it.id ? "active" : ""}`}
            onClick={() => setView(it.id)}
          >
            {view === it.id && (
              <motion.span
                layoutId="nav-pill"
                className="nav-pill"
                transition={{ type: "spring", stiffness: 400, damping: 32 }}
              />
            )}
            <span className="nav-icon">{it.icon}</span>
            {it.label}
            <span className="nav-badge">{it.badge}</span>
          </button>
        ))}

        <div className="side-label">Archivo</div>
        <button
          className={`nav-item ${dlOpen ? "active" : ""}`}
          onClick={onOpenDownloads}
        >
          {dlOpen && (
            <motion.span
              layoutId="nav-pill"
              className="nav-pill"
              transition={{ type: "spring", stiffness: 400, damping: 32 }}
            />
          )}
          <span className="nav-icon">
            <Download size={18} />
          </span>
          Descargas
          <span className={`nav-badge ${dl.active > 0 ? "live" : ""}`}>
            {dl.active > 0 ? dl.active : downloadedCount}
          </span>
        </button>
      </nav>

      {/* Cuenta activa */}
      <div className="side-account">
        <div className="side-label">Sesión activa</div>
        {accounts.length === 0 ? (
          <div className="account-empty">
            <ShieldCheck size={15} />
            Sin cuenta — agrega una
          </div>
        ) : (
          <div className="account-select-row">
            <div className={`status-dot ${accounts.find((a) => a.id === activeAccount)?.status || "unknown"}`} />
            <select
              className="account-select"
              value={activeAccount}
              onChange={(e) => setAccountId(Number(e.target.value))}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  @{a.username}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="side-foot">v0.1.0 · {mediaCount} archivos</div>
    </aside>
  );
}
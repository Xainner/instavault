import { motion } from "framer-motion";
import { KeyRound, LayoutGrid, ShieldCheck } from "lucide-react";
import type { AccountInfo } from "../types";

export type View = "profiles" | "accounts";

export function Sidebar({
  view,
  setView,
  accounts,
  activeAccount,
  setAccountId,
  profileCount,
  mediaCount,
}: {
  view: View;
  setView: (v: View) => void;
  accounts: AccountInfo[];
  activeAccount: number;
  setAccountId: (id: number) => void;
  profileCount: number;
  mediaCount: number;
}) {
  const items: { id: View; label: string; icon: React.ReactNode; badge: number }[] = [
    { id: "profiles", label: "Perfiles", icon: <LayoutGrid size={18} />, badge: profileCount },
    { id: "accounts", label: "Cuentas", icon: <KeyRound size={18} />, badge: accounts.length },
  ];

  return (
    <aside className="sidebar">
      {/* Logo */}
      <div className="side-logo">
        <div className="logo-badge">
          <img src="/icon.png" alt="" />
        </div>
        <div className="logo-text">
          <span className="logo-name">InstaVault</span>
          <span className="logo-sub">Instagram Archive</span>
        </div>
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
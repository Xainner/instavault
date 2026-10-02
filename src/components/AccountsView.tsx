import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { BadgeCheck, Check, KeyRound, Loader2, LogIn, ShieldAlert, ShieldQuestion, Trash2 } from "lucide-react";
import type { AccountInfo } from "../types";
import { connectPrivateAccount, deleteAccount, loginCancel, loginCheck } from "../lib/api";
import { Modal } from "./Modal";
import { useToast } from "./Toasts";

function statusMeta(status: string) {
  if (status === "valid") return { icon: <BadgeCheck size={15} />, label: "Conectada", cls: "ok" };
  if (status === "reconnect_required") return { icon: <ShieldAlert size={15} />, label: "Reconectar", cls: "warn" };
  return { icon: <ShieldQuestion size={15} />, label: "Sin verificar", cls: "warn" };
}

export function AccountsView({ accounts, activeAccount, setAccountId, onChanged }: {
  accounts: AccountInfo[]; activeAccount: number; setAccountId: (id: number) => void; onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<AccountInfo | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  const { toast } = useToast();
  const stopPolling = () => { if (poll.current) clearInterval(poll.current); poll.current = null; };
  useEffect(() => stopPolling, []);

  const connect = async () => {
    setError(null);
    try {
      await connectPrivateAccount();
      setWaiting(true);
      stopPolling();
      poll.current = setInterval(async () => {
        try {
          const account = await loginCheck();
          if (!account) return;
          stopPolling(); setWaiting(false); setOpen(false); setAccountId(account.id);
          toast("success", `@${account.username} conectada`, "La sesión vive sólo en el navegador dedicado.");
          onChanged();
        } catch (reason) {
          stopPolling(); setWaiting(false); setError(String(reason));
        }
      }, 2500);
    } catch (reason) { setWaiting(false); setError(String(reason)); }
  };

  const cancel = async () => { stopPolling(); await loginCancel().catch(() => undefined); setWaiting(false); };
  const remove = async () => {
    if (!confirm) return;
    await deleteAccount(confirm.id);
    if (activeAccount === confirm.id) setAccountId(accounts.find((item) => item.id !== confirm.id)?.id ?? 0);
    setConfirm(null); toast("info", "Conexión privada eliminada"); onChanged();
  };

  return (
    <div className="view">
      <div className="page-head">
        <div><h1 className="page-title">Acceso privado</h1><p className="page-sub">La biblioteca pública funciona sin sesión. El navegador dedicado sólo se abre cuando tú solicitas contenido privado.</p></div>
        <button className="btn primary" onClick={() => { setOpen(true); setError(null); }}><LogIn size={16} /> Conectar cuenta</button>
      </div>
      <div className="privacy-banner" role="note"><ShieldAlert size={18} /><div><b>Aislamiento estricto</b><span>No se leen cookies de Chrome, Edge, Brave u Opera y la app nunca cerrará tu navegador cotidiano.</span></div></div>
      <div className="cards-grid">
        <AnimatePresence mode="popLayout">
          {accounts.map((account, index) => {
            const status = statusMeta(account.status); const active = account.id === activeAccount;
            return (
              <motion.div key={account.id} layout initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ delay: Math.min(index * 0.04, 0.16) }} className={`card account-card ${active ? "active" : ""}`} onClick={() => setAccountId(account.id)}>
                <div className="account-top"><div className="account-avatar">{account.username[0]?.toUpperCase()}</div><div className="account-meta"><div className="account-user">@{account.username}</div><div className={`account-status ${status.cls}`}>{status.icon}{status.label}</div></div>{active && <span className="active-tag"><Check size={12} /> Activa</span>}</div>
                <div className="account-foot"><span className="muted">Perfil dedicado de InstaVault</span><div className="account-actions" onClick={(event) => event.stopPropagation()}>{account.status !== "valid" && <button className="btn ghost sm" onClick={() => { setOpen(true); setError(null); }}><LogIn size={14} /> Reconectar</button>}<button className="icon-btn danger" title="Eliminar conexión" onClick={() => setConfirm(account)}><Trash2 size={15} /></button></div></div>
              </motion.div>
            );
          })}
        </AnimatePresence>
        {accounts.length === 0 && <div className="empty"><div className="empty-icon"><KeyRound size={30} /></div><h3>Sin acceso privado</h3><p>Puedes buscar y guardar contenido público sin conectar ninguna cuenta.</p><button className="btn primary" onClick={() => setOpen(true)}><LogIn size={16} /> Conectar sólo para privados</button></div>}
      </div>
      <Modal open={open} onClose={() => !waiting && setOpen(false)} title="Conectar acceso privado" icon={<KeyRound size={18} />} width={520}>
        <div className="assist">
          {waiting ? <div className="assist-waiting"><Loader2 size={26} className="spin" /><p>Completa el inicio de sesión en la ventana dedicada.<br />InstaVault no extraerá sus cookies.</p></div> : <div className="assist-intro"><LogIn size={26} /><p>Se abrirá un perfil separado del navegador. Sólo se utilizará cuando confirmes una operación sobre un perfil privado.</p></div>}
          {error && <div className="form-error"><ShieldAlert size={15} /> {error}</div>}
          <div className="modal-actions"><button className="btn ghost" onClick={waiting ? cancel : () => setOpen(false)}>Cancelar</button>{!waiting && <button className="btn primary" onClick={connect}><LogIn size={16} /> Abrir navegador dedicado</button>}</div>
        </div>
      </Modal>
      <Modal open={!!confirm} onClose={() => setConfirm(null)} title="Eliminar conexión privada" icon={<Trash2 size={18} />} width={420}>
        <p className="confirm-text">Se desconectará <strong>@{confirm?.username}</strong>. Los perfiles y medios de SQLite no se eliminarán.</p><div className="modal-actions"><button className="btn ghost" onClick={() => setConfirm(null)}>Cancelar</button><button className="btn danger" onClick={remove}><Trash2 size={15} /> Eliminar</button></div>
      </Modal>
    </div>
  );
}

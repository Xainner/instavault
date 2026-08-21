import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  BadgeCheck,
  Check,
  Copy,
  Globe,
  KeyRound,
  Loader2,
  LogIn,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldQuestion,
  Trash2,
  XCircle,
} from "lucide-react";
import type { AccountInfo } from "../types";
import {
  addAccount,
  deleteAccount,
  importBrowserAccount,
  listBrowserProfiles,
  loginCancel,
  loginCheck,
  loginOpen,
  type BrowserProfile,
  validateAccount,
} from "../lib/api";
import { Modal } from "./Modal";
import { useToast } from "./Toasts";

const COOKIES_EXAMPLE =
  "sessionid=1234567%3AbBfGx; csrftoken=aBcDeF012345; ds_user_id=123456789";

function statusMeta(s: string) {
  switch (s) {
    case "valid":
      return { icon: <BadgeCheck size={15} />, label: "Válida", cls: "ok" };
    case "invalid":
      return { icon: <XCircle size={15} />, label: "Inválida", cls: "err" };
    default:
      return { icon: <ShieldQuestion size={15} />, label: "Sin verificar", cls: "warn" };
  }
}

function fmtLast(t: number | null) {
  if (!t) return "nunca";
  return new Date(t * 1000).toLocaleString("es", { dateStyle: "medium", timeStyle: "short" });
}

export function AccountsView({
  accounts,
  activeAccount,
  setAccountId,
  onChanged,
}: {
  accounts: AccountInfo[];
  activeAccount: number;
  setAccountId: (id: number) => void;
  onChanged: () => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [addTab, setAddTab] = useState<"browser" | "manual" | "assisted">("browser");
  const [confirm, setConfirm] = useState<AccountInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [verifying, setVerifying] = useState<number | null>(null);
  const { toast } = useToast();

  // Login asistido (CDP)
  const [assistState, setAssistState] = useState<"idle" | "waiting" | "capturing">("idle");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  useEffect(() => stopPolling, []);

  const startAssistedLogin = async () => {
    setErr(null);
    try {
      await loginOpen();
      setAssistState("waiting");
      stopPolling();
      pollRef.current = setInterval(async () => {
        try {
          const acc = await loginCheck();
          if (acc) {
            stopPolling();
            setAssistState("idle");
            toast("success", `@${acc.username} importada desde el navegador`);
            setAddOpen(false);
            setAccountId(acc.id);
            onChanged();
          }
        } catch (e) {
          // Error fatal (navegador cerrado, fallo de inserción): abortar.
          stopPolling();
          setAssistState("idle");
          setErr(String(e).replace(/^.*"([^"]+)".*$/, "$1"));
        }
      }, 3000);
    } catch (e) {
      setAssistState("idle");
      setErr(String(e));
    }
  };

  const cancelAssistedLogin = async () => {
    stopPolling();
    try {
      await loginCancel();
    } finally {
      setAssistState("idle");
    }
  };

  // Modal alta
  const [username, setUsername] = useState("");
  const [cookies, setCookies] = useState("");
  const [err, setErr] = useState<string | null>(null);

  // Perfiles de navegador detectados
  const [browserProfiles, setBrowserProfiles] = useState<BrowserProfile[]>([]);
  const [browserLoading, setBrowserLoading] = useState(false);

  const openAdd = () => {
    setAddOpen(true);
    setErr(null);
    setBrowserLoading(true);
    listBrowserProfiles()
      .then(setBrowserProfiles)
      .catch(() => setBrowserProfiles([]))
      .finally(() => setBrowserLoading(false));
  };

  const doImportBrowser = async (index: number) => {
    setBusy(true);
    setErr(null);
    try {
      const acc = await importBrowserAccount(index);
      toast("success", `@${acc.username} importada desde el navegador`);
      setAddOpen(false);
      setAccountId(acc.id);
      onChanged();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const doAdd = async () => {
    if (!username.trim()) return setErr("Pon el usuario de la cuenta.");
    if (!cookies.includes("sessionid="))
      return setErr("Las cookies deben incluir sessionid=...");
    setBusy(true);
    setErr(null);
    try {
      const acc = await addAccount(username.trim().replace(/^@/, ""), cookies.trim());
      toast("success", `@${acc.username} agregada`);
      setAddOpen(false);
      setUsername("");
      setCookies("");
      setAccountId(acc.id);
      onChanged();
      // validar en segundo plano
      setVerifying(acc.id);
      try {
        const v = await validateAccount(acc.id);
        if (v.status === "valid")
          toast("success", `@${v.username} verificada`, "La sesión funciona.");
        else toast("error", "Sesión inválida", "Revisa las cookies.");
      } catch {
        toast("warning", "No se pudo verificar", "Revisa tu conexión.");
      } finally {
        setVerifying(null);
        onChanged();
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const doVerify = async (id: number) => {
    setVerifying(id);
    try {
      const v = await validateAccount(id);
      if (v.status === "valid") toast("success", `@${v.username} verificada`);
      else toast("error", "Sesión inválida", "Vuelve a pegar las cookies vigentes.");
    } catch (e) {
      toast("error", "Error al verificar", String(e));
    } finally {
      setVerifying(null);
      onChanged();
    }
  };

  const doDelete = async () => {
    if (!confirm) return;
    await deleteAccount(confirm.id);
    if (activeAccount === confirm.id && accounts[0])
      setAccountId(accounts.find((a) => a.id !== confirm.id)?.id ?? 0);
    setConfirm(null);
    toast("info", "Cuenta eliminada");
    onChanged();
  };

  const copyCookies = async (a: AccountInfo) => {
    try {
      // se copia el nombre; las cookies viven cifradas en el keyring
      await navigator.clipboard.writeText(`@${a.username}`);
      toast("info", "Usuario copiado");
    } catch {
      /* noop */
    }
  };

  return (
    <div className="view">
      <div className="page-head">
        <div>
          <h1 className="page-title">Cuentas</h1>
          <p className="page-sub">
            Gestiona las sesiones de Instagram que usa InstaVault (cookies cifradas en el llavero
            del sistema).
          </p>
        </div>
        <button className="btn primary" onClick={openAdd}>
          <Plus size={16} /> Nueva cuenta
        </button>
      </div>

      <div className="cards-grid">
        <AnimatePresence mode="popLayout">
          {accounts.map((a, i) => {
            const sm = statusMeta(a.status);
            const active = a.id === activeAccount;
            return (
              <motion.div
                key={a.id}
                layout
                initial={{ opacity: 0, y: 16, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ delay: i * 0.05, type: "spring", stiffness: 300, damping: 26 }}
                className={`card account-card ${active ? "active" : ""}`}
                onClick={() => setAccountId(a.id)}
              >
                <div className="account-top">
                  <div className="account-avatar">
                    {a.username[0]?.toUpperCase()}
                  </div>
                  <div className="account-meta">
                    <div className="account-user">@{a.username}</div>
                    <div className={`account-status ${sm.cls}`}>
                      {verifying === a.id ? (
                        <Loader2 size={13} className="spin" />
                      ) : (
                        sm.icon
                      )}
                      {verifying === a.id ? "Verificando…" : sm.label}
                    </div>
                  </div>
                  {active && (
                    <motion.span layoutId="active-check" className="active-tag">
                      <Check size={12} /> Activa
                    </motion.span>
                  )}
                </div>
                <div className="account-foot">
                  <span className="muted">Última validación: {fmtLast(a.last_valid)}</span>
                  <div className="account-actions" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="icon-btn"
                      title="Verificar sesión"
                      onClick={() => doVerify(a.id)}
                      disabled={verifying !== null}
                    >
                      <RefreshCw size={15} className={verifying === a.id ? "spin" : ""} />
                    </button>
                    <button className="icon-btn" title="Copiar usuario" onClick={() => copyCookies(a)}>
                      <Copy size={15} />
                    </button>
                    <button
                      className="icon-btn danger"
                      title="Eliminar"
                      onClick={() => setConfirm(a)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>

        {accounts.length === 0 && (
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            className="empty"
          >
            <div className="empty-icon">
              <KeyRound size={30} />
            </div>
            <h3>Aún no hay cuentas</h3>
            <p>
              Agrega tu cuenta de Instagram pegando las cookies de tu sesión. Necesario para
              perfiles privados y stories.
            </p>
            <button className="btn primary" onClick={openAdd}>
              <Plus size={16} /> Agregar mi cuenta
            </button>
          </motion.div>
        )}
      </div>

      {/* Modal: nueva cuenta */}
      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Nueva cuenta"
        icon={<KeyRound size={18} />}
        width={560}
      >
        <div className="modal-tabs">
          <button
            className={`modal-tab ${addTab === "assisted" ? "on" : ""}`}
            onClick={() => setAddTab("assisted")}
          >
            <LogIn size={14} /> Login asistido
            <span className="tab-badge">recomendado</span>
          </button>
          <button
            className={`modal-tab ${addTab === "browser" ? "on" : ""}`}
            onClick={() => setAddTab("browser")}
          >
            <Globe size={14} /> Desde el navegador
          </button>
          <button
            className={`modal-tab ${addTab === "manual" ? "on" : ""}`}
            onClick={() => setAddTab("manual")}
          >
            <KeyRound size={14} /> Cookies manuales
          </button>
        </div>

        {addTab === "assisted" && (
          <div className="assist">
            {assistState === "idle" ? (
              <>
                <div className="assist-intro">
                  <LogIn size={26} />
                  <p>
                    InstaVault abre una ventana de Chrome propia donde inicias sesión en
                    Instagram. Las cookies se capturan automáticamente al terminar y el
                    navegador se cierra solo.
                  </p>
                </div>
                <button className="btn primary assist-btn" onClick={startAssistedLogin}>
                  <LogIn size={16} /> Abrir ventana de login
                </button>
              </>
            ) : (
              <>
                <div className="assist-waiting">
                  <Loader2 size={26} className="spin" />
                  <p>
                    Inicia sesión en la ventana de Chrome que se abrió.
                    <br />
                    Detectaré la sesión automáticamente…
                  </p>
                </div>
                <button className="btn ghost assist-btn" onClick={cancelAssistedLogin}>
                  Cancelar
                </button>
              </>
            )}
          </div>
        )}

        {addTab === "browser" && (
          <div className="browser-pick">
            {browserLoading ? (
              <div className="browser-empty">
                <Loader2 size={22} className="spin" /> Buscando perfiles…
              </div>
            ) : browserProfiles.length === 0 ? (
              <div className="browser-empty">
                <Globe size={22} />
                <p>
                  No se detectó ningún perfil de Chrome, Edge, Brave u Opera con cookies.
                  ¿Estás logueado en Instagram en alguno de ellos?
                </p>
              </div>
            ) : (
              browserProfiles.map((bp, i) => (
                <button
                  key={`${bp.browser}-${bp.profile}`}
                  className="browser-row"
                  onClick={() => doImportBrowser(i)}
                  disabled={busy}
                >
                  <div className="browser-row-logo">{bp.browser[0]}</div>
                  <div className="browser-row-meta">
                    <div className="browser-row-name">
                      {bp.browser} · {bp.profile}
                    </div>
                    <div className="browser-row-sub">
                      Se detectó una sesión de Instagram en este perfil
                    </div>
                  </div>
                  {busy ? (
                    <Loader2 size={16} className="spin" />
                  ) : (
                    <Plus size={16} className="browser-row-plus" />
                  )}
                </button>
              ))
            )}
            <span className="hint">
              InstaVault lee las cookies de Instagram directamente de tu navegador (Chrome,
              Edge, Brave u Opera) y crea la cuenta sin que pegues nada. Si el navegador
              está abierto, InstaVault lo cierra para poder leer las cookies y reintenta.
            </span>
          </div>
        )}

        {addTab === "manual" && (
          <div className="form">
            <label className="field">
              <span>Usuario</span>
              <input
                className="input"
                placeholder="mi_usuario"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
              />
            </label>
            <label className="field">
              <span>Cookies (header completo)</span>
              <textarea
                className="input cookies"
                placeholder={COOKIES_EXAMPLE}
                value={cookies}
                onChange={(e) => setCookies(e.target.value)}
                rows={4}
              />
              <span className="hint">
                Déjate en Instagram → DevTools → Application → Cookies, o usa la cabecera{" "}
                <code>Cookie:</code> de una petición. Debe incluir <code>sessionid</code>,{" "}
                <code>csrftoken</code> y <code>ds_user_id</code>.
              </span>
            </label>
          </div>
        )}

        {err && (
          <div className="form-error">
            <ShieldAlert size={15} /> {String(err)}
          </div>
        )}
        <div className="modal-actions">
          <button className="btn ghost" onClick={() => setAddOpen(false)}>
            Cancelar
          </button>
          {addTab === "manual" && (
            <button className="btn primary" onClick={doAdd} disabled={busy}>
              {busy ? <Loader2 size={15} className="spin" /> : <Plus size={15} />}
              {busy ? "Guardando…" : "Agregar cuenta"}
            </button>
          )}
        </div>
      </Modal>

      {/* Modal: confirmar eliminación */}
      <Modal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title="Eliminar cuenta"
        icon={<Trash2 size={18} />}
        width={400}
      >
        <p className="confirm-text">
          ¿Eliminar <strong>@{confirm?.username}</strong>? Se borrarán sus cookies cifradas. Los
          perfiles y medios descargados no se tocan.
        </p>
        <div className="modal-actions">
          <button className="btn ghost" onClick={() => setConfirm(null)}>
            Cancelar
          </button>
          <button className="btn danger" onClick={doDelete}>
            <Trash2 size={15} /> Eliminar
          </button>
        </div>
      </Modal>
    </div>
  );
}
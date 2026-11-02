import { motion } from "motion/react";
import { Check, KeyRound, LogOut, Plus, RefreshCw, ShieldCheck, Trash } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { Account } from "@shared/types";
import { art } from "../assets";
import { call, errorMessage } from "../lib/api";
import { fmtRelative } from "../lib/format";
import { useStore } from "../store";
import { Avatar, Menu, MenuItem, Modal, Spinner } from "../ui/primitives";

export function AccountsView() {
  const { accounts, settings, saveSettings, refreshAccounts } = useStore();
  const [connecting, setConnecting] = useState(false);
  const [removing, setRemoving] = useState<Account | null>(null);

  const connect = async () => {
    setConnecting(true);
    try {
      const account = await call("accounts:connect");
      if (account) toast.success(`@${account.username} conectada`, { description: "Su sesión vive en un navegador aislado sólo para ella." });
    } catch (error) {
      toast.error("No se pudo conectar", { description: errorMessage(error) });
    } finally {
      setConnecting(false);
      await refreshAccounts();
    }
  };

  return (
    <div className="view-scroll">
      <div className="mx-auto max-w-[1180px] px-10 pb-24 pt-10">
        <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] items-end gap-10">
          <div>
            <div className="eyebrow">Acceso con sesión</div>
            <h1 className="display mt-3 text-[84px]">
              Tus <em>llaves</em>.
            </h1>
            <p className="mt-4 max-w-[58ch] text-[15px] leading-relaxed text-paper-2">
              Conecta una cuenta para ver perfiles privados que sigues, stories, highlights y perfiles completos cuando Instagram limita
              el modo anónimo. Cada cuenta inicia sesión en su propia ventana de Instagram y su sesión nunca se copia fuera de ella.
            </p>
            <div className="mt-6 flex flex-wrap gap-2">
              {["Navegador aislado por cuenta", "Sin contraseñas guardadas por la app", "Sólo se usa cuando lo pides"].map((t) => (
                <span key={t} className="tag tag-sage h-[26px] px-2.5 text-[12px]">
                  <ShieldCheck size={12} /> {t}
                </span>
              ))}
            </div>
          </div>
          <div className="illustration aspect-[4/3]">
            <img src={art.login} alt="" className="object-[50%_70%]" />
          </div>
        </div>

        <div className="mt-12 grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-5">
          {accounts.map((account, i) => {
            const isDefault = settings?.defaultAccountId === account.id;
            const valid = account.status === "valid";
            return (
              <motion.div
                key={account.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05 }}
                className="panel relative overflow-hidden p-6"
              >
                <div className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-amber/10 blur-3xl" />
                <div className="flex items-center justify-between">
                  <span className="eyebrow">Credencial · {String(account.id).padStart(3, "0")}</span>
                  <span className={`flex items-center gap-1.5 text-[11.5px] ${valid ? "text-sage" : "text-amber-2"}`}>
                    <span className={`h-2 w-2 rounded-full ${valid ? "bg-sage shadow-[0_0_10px_rgba(156,191,134,0.9)]" : "bg-amber shadow-[0_0_10px_rgba(224,164,88,0.9)]"}`} />
                    {valid ? "Conectada" : "Reconectar"}
                  </span>
                </div>
                <div className="mt-6 flex items-center gap-4">
                  <Avatar src={account.avatarUrl} name={account.username} size={64} ring={isDefault} />
                  <div className="min-w-0">
                    <div className="display truncate text-[30px]">@{account.username}</div>
                    <div className="text-[12px] text-paper-3">
                      {valid ? `Verificada ${fmtRelative(account.lastValid)}` : "La sesión expiró o se cerró"}
                    </div>
                  </div>
                </div>
                <div className="mt-6 flex items-center gap-2">
                  {isDefault ? (
                    <span className="tag tag-amber h-[30px] px-3 text-[12px]">
                      <Check size={13} /> Predeterminada
                    </span>
                  ) : (
                    <button className="btn btn-sm" onClick={() => void saveSettings({ defaultAccountId: account.id })} disabled={!valid}>
                      Usar por defecto
                    </button>
                  )}
                  {!valid && (
                    <button className="btn btn-sm btn-primary" onClick={() => void connect()}>
                      <RefreshCw size={13} /> Reconectar
                    </button>
                  )}
                  <div className="ml-auto">
                    <Menu
                      trigger={({ toggle }) => (
                        <button className="btn btn-sm btn-ghost" onClick={toggle}>
                          Gestionar
                        </button>
                      )}
                    >
                      {(close) => (
                        <>
                          <MenuItem
                            icon={<LogOut size={15} />}
                            onClick={async () => {
                              close();
                              await call("accounts:disconnect", { accountId: account.id });
                              toast("Sesión cerrada", { description: `Se borraron los datos de navegación de @${account.username}.` });
                            }}
                          >
                            Cerrar sesión
                          </MenuItem>
                          <MenuItem icon={<Trash size={15} />} danger onClick={() => (close(), setRemoving(account))}>
                            Eliminar cuenta
                          </MenuItem>
                        </>
                      )}
                    </Menu>
                  </div>
                </div>
              </motion.div>
            );
          })}

          <motion.button
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            onClick={() => void connect()}
            className="group grid min-h-[220px] place-items-center rounded-[24px] border border-dashed border-line-2 p-6 text-center transition hover:border-amber/60 hover:bg-amber/5"
          >
            <div>
              <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-amber/10 text-amber-2 shadow-[inset_0_0_0_1px_rgba(224,164,88,0.25)] transition group-hover:scale-105">
                <Plus size={24} />
              </div>
              <div className="display mt-4 text-[26px]">Conectar una cuenta</div>
              <div className="mt-1 text-[13px] text-paper-3">Se abrirá la ventana oficial de inicio de sesión.</div>
            </div>
          </motion.button>
        </div>
      </div>

      <Modal
        open={connecting}
        onClose={() => void call("accounts:cancelConnect")}
        title={
          <>
            Inicia sesión en la <em>ventana de Instagram</em>
          </>
        }
        description="Completa el inicio de sesión (y la verificación en dos pasos si la tienes). Esta ventana se cerrará sola al detectar la sesión."
        dismissable={false}
      >
        <div className="flex items-center gap-3 rounded-2xl bg-ink-3/70 p-4 text-[13px] text-paper-2">
          <span className="text-amber-2">
            <Spinner size={18} />
          </span>
          Esperando la sesión… InstaVault no ve tu contraseña: sólo comprueba que la sesión existe.
        </div>
        <div className="mt-5 flex justify-end">
          <button className="btn btn-ghost" onClick={() => void call("accounts:cancelConnect")}>
            Cancelar
          </button>
        </div>
      </Modal>

      <Modal
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        title={`¿Eliminar @${removing?.username ?? ""}?`}
        description="Se cierra su sesión, se borran sus datos de navegación y desaparece de la app. Tu archivo no cambia."
      >
        <div className="mt-2 flex justify-end gap-2">
          <button className="btn btn-ghost" onClick={() => setRemoving(null)}>
            Cancelar
          </button>
          <button
            className="btn btn-danger"
            onClick={async () => {
              if (!removing) return;
              await call("accounts:delete", { accountId: removing.id });
              setRemoving(null);
            }}
          >
            <KeyRound size={14} /> Eliminar
          </button>
        </div>
      </Modal>
    </div>
  );
}

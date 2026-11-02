import { KeyRound, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { art } from "../assets";
import { useStore } from "../store";
import { Avatar, Modal } from "../ui/primitives";

/** Pregunta antes de usar la cuenta conectada cuando el modo anónimo se topa con un muro. */
export function AccessPrompt() {
  const { accessPrompt } = useStore();
  const [remember, setRemember] = useState(false);
  const account = accessPrompt?.account;
  return (
    <Modal
      open={Boolean(accessPrompt)}
      onClose={() => accessPrompt?.resolve({ use: false, remember: false })}
      title={
        <>
          Instagram cerró la <em>puerta anónima</em>
        </>
      }
      width={560}
    >
      <div className="illustration mb-5 aspect-[16/7]">
        <img src={art.limitArt} alt="" />
      </div>
      <p className="text-[14px] leading-relaxed text-paper-2">{accessPrompt?.message}</p>
      {account && (
        <div className="mt-5 flex items-center gap-3 rounded-2xl bg-ink-3/70 p-3.5 shadow-[inset_0_0_0_1px_rgba(240,220,195,0.08)]">
          <Avatar src={account.avatarUrl} name={account.username} size={38} ring />
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] text-paper">Continuar con @{account.username}</div>
            <div className="flex items-center gap-1.5 text-[12px] text-paper-3">
              <ShieldCheck size={12} /> Sólo para esta operación. La sesión no sale de su navegador aislado.
            </div>
          </div>
        </div>
      )}
      <label className="mt-4 flex cursor-pointer items-center gap-2.5 text-[13px] text-paper-2">
        <input type="checkbox" className="accent-[#e0a458]" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        Hacerlo automáticamente a partir de ahora
      </label>
      <div className="mt-6 flex justify-end gap-2">
        <button className="btn btn-ghost" onClick={() => accessPrompt?.resolve({ use: false, remember: false })}>
          Ahora no
        </button>
        <button className="btn btn-primary" onClick={() => accessPrompt?.resolve({ use: true, remember })}>
          <KeyRound size={15} /> Usar mi cuenta
        </button>
      </div>
    </Modal>
  );
}

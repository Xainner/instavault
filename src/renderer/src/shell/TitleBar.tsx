import { AnimatePresence, motion } from "motion/react";
import { Command, Download, Search, X } from "lucide-react";
import { art } from "../assets";
import { call } from "../lib/api";
import { useStore } from "../store";
import { Spinner } from "../ui/primitives";

export function TitleBar() {
  const { activity, setPaletteOpen, setDownloadsOpen, downloadsOpen, progress } = useStore();
  const active = Object.values(progress);
  const remaining = active.reduce((sum, p) => sum + (p.total - p.done), 0);
  const isMac = window.vault?.platform === "darwin";

  return (
    <header className="titlebar">
      <div className="flex items-center gap-2.5">
        <img src={art.mark} alt="" className="h-[22px] w-[22px] rounded-[6px] shadow-[0_0_18px_-4px_rgba(224,164,88,0.6)]" />
        <span className="display text-[19px] tracking-tight text-paper">
          Insta<em className="not-italic text-amber-2">Vault</em>
        </span>
      </div>

      <div className="drag h-full flex-1" />

      <button
        className="field h-[30px] w-[min(420px,36vw)] cursor-text gap-2 rounded-[10px] px-3 text-left text-[12.5px] text-paper-4"
        onClick={() => setPaletteOpen(true)}
      >
        <Search size={14} />
        <span className="flex-1 truncate">Buscar en tu archivo o pegar un enlace…</span>
        <span className="kbd flex items-center gap-0.5">
          {isMac ? <Command size={10} /> : "Ctrl"} K
        </span>
      </button>

      <div className="drag h-full flex-1" />

      <AnimatePresence>
        {activity && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            className="flex h-[30px] max-w-[320px] items-center gap-2.5 rounded-[10px] bg-amber/10 pl-3 pr-1 text-[12px] text-amber-2 shadow-[inset_0_0_0_1px_rgba(224,164,88,0.25)]"
          >
            <span className="safelight-dot" />
            <span className="truncate">
              <span className="text-paper">{activity.label}</span>
              <span className="text-amber-2/80"> · {activity.stage}</span>
            </span>
            {activity.cancellable && (
              <button className="icon-btn h-6 w-6" title="Cancelar" onClick={() => void call("ig:cancel")}>
                <X size={13} />
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <button
        className="relative btn btn-sm btn-ghost gap-2"
        data-active={downloadsOpen}
        onClick={() => setDownloadsOpen(!downloadsOpen)}
        title="Revelando: descargas"
      >
        {remaining > 0 ? <Spinner size={14} /> : <Download size={15} />}
        <span>Revelando</span>
        {remaining > 0 && (
          <span className="mono rounded-md bg-amber px-1.5 text-[10.5px] font-semibold leading-[18px] text-[#1d1309]">{remaining}</span>
        )}
      </button>
    </header>
  );
}

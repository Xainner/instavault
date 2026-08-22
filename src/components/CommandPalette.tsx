import { useEffect, useState } from "react";
import { Command } from "cmdk";
import { Download, Info, KeyRound, LayoutGrid, Search } from "lucide-react";
import type { View } from "./Sidebar";

export function CommandPalette({ navigate, openDownloads }: { navigate: (view: View) => void; openDownloads: () => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setOpen((v) => !v); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  const run = (fn: () => void) => { setOpen(false); fn(); };
  return <Command.Dialog open={open} onOpenChange={setOpen} label="Comandos de InstaVault" className="command-dialog">
    <div className="command-input"><Search size={16} /><Command.Input placeholder="Buscar un comando…" autoFocus /></div>
    <Command.List><Command.Empty>Sin comandos coincidentes.</Command.Empty><Command.Group heading="Navegación">
      <Command.Item onSelect={() => run(() => navigate("profiles"))}><LayoutGrid /> Perfiles</Command.Item>
      <Command.Item onSelect={() => run(() => navigate("accounts"))}><KeyRound /> Cuentas</Command.Item>
      <Command.Item onSelect={() => run(openDownloads)}><Download /> Descargas</Command.Item>
      <Command.Item onSelect={() => run(() => navigate("about"))}><Info /> Acerca de</Command.Item>
    </Command.Group></Command.List>
  </Command.Dialog>;
}

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { DownloadCloud, Loader2, RefreshCw } from "lucide-react";
import { Modal } from "./Modal";
import { useToast } from "./Toasts";
import { Button } from "./ui/button";

type UpdaterContextValue = {
  checking: boolean;
  progress: number | null;
  availableVersion: string | null;
  checkNow: (manual?: boolean) => Promise<void>;
};
const UpdaterContext = createContext<UpdaterContextValue | null>(null);
export const useUpdater = () => {
  const value = useContext(UpdaterContext);
  if (!value) throw new Error("useUpdater debe usarse dentro de UpdaterProvider");
  return value;
};

export function UpdaterProvider({ children }: { children: ReactNode }) {
  const { toast } = useToast();
  const [update, setUpdate] = useState<Update | null>(null);
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);

  const checkNow = useCallback(async (manual = true) => {
    if (checking || installing) return;
    setChecking(true);
    try {
      const next = await check({ timeout: 12_000 });
      if (next) { setUpdate(next); setOpen(true); }
      else if (manual) toast("success", "InstaVault está actualizado", "Ya tienes la versión más reciente.");
    } catch (error) {
      if (manual) toast("error", "No se pudo comprobar la actualización", String(error));
    } finally { setChecking(false); }
  }, [checking, installing, toast]);

  useEffect(() => {
    const timer = window.setTimeout(() => void checkNow(false), 1400);
    return () => window.clearTimeout(timer);
  }, []); // una comprobación silenciosa por inicio

  const install = async () => {
    if (!update || installing) return;
    setInstalling(true);
    let total = 0;
    let received = 0;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? 0;
        if (event.event === "Progress") received += event.data.chunkLength;
        if (event.event === "Progress" && total) setProgress(Math.min(100, Math.round(received * 100 / total)));
        if (event.event === "Finished") setProgress(100);
      });
      await relaunch();
    } catch (error) {
      toast("error", "No se pudo instalar la actualización", String(error));
      setInstalling(false);
    }
  };

  const value = useMemo(() => ({ checking, progress, availableVersion: update?.version ?? null, checkNow }), [checking, progress, update, checkNow]);
  return (
    <UpdaterContext.Provider value={value}>
      {children}
      <Modal open={open} onClose={() => !installing && setOpen(false)} title="Actualización disponible" icon={<DownloadCloud size={18} />}>
        <div className="update-dialog">
          <p>InstaVault <b>v{update?.version}</b> está listo para instalar.</p>
          {update?.body && <div className="release-notes">{update.body}</div>}
          {installing && <div className="update-progress"><span style={{ width: `${progress ?? 8}%` }} /></div>}
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={installing}>Más tarde</Button>
            <Button onClick={install} disabled={installing}>
              {installing ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
              {installing ? `Instalando ${progress ?? 0}%` : "Actualizar ahora"}
            </Button>
          </div>
        </div>
      </Modal>
    </UpdaterContext.Provider>
  );
}

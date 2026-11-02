import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC_EVENT, IPC_INVOKE, type VaultBridge } from "@shared/api";
import type { VaultEvent } from "@shared/types";

const bridge: VaultBridge = {
  invoke: (method, args) => ipcRenderer.invoke(IPC_INVOKE, method, args),
  on(listener) {
    const handler = (_event: IpcRendererEvent, payload: VaultEvent) => listener(payload);
    ipcRenderer.on(IPC_EVENT, handler);
    return () => {
      ipcRenderer.removeListener(IPC_EVENT, handler);
    };
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld("vault", bridge);

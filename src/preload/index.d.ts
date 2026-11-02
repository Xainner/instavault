import type { VaultBridge } from "../shared/api";

declare global {
  interface Window {
    vault: VaultBridge;
  }
}

export {};

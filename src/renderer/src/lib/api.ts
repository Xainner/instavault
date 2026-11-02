import type { VaultArgs, VaultMethod, VaultResult } from "@shared/api";
import type { ErrorCode, VaultErrorShape, VaultEvent } from "@shared/types";

export class VaultClientError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly canUseAccount: boolean;
  constructor(shape: VaultErrorShape) {
    super(shape.message);
    this.code = shape.code;
    this.retryable = shape.retryable;
    this.canUseAccount = shape.canUseAccount ?? false;
  }
}

/** Llama a un método IPC y desenvuelve el resultado o lanza un error tipado. */
export async function call<M extends VaultMethod>(method: M, ...args: VaultArgs<M> extends void ? [] : [VaultArgs<M>]): Promise<VaultResult<M>> {
  const envelope = await window.vault.invoke(method, args[0] as VaultArgs<M>);
  if (envelope.ok) return envelope.data as VaultResult<M>;
  throw new VaultClientError(envelope.error);
}

export function onVaultEvent(listener: (event: VaultEvent) => void): () => void {
  return window.vault.on(listener);
}

export function errorMessage(error: unknown): string {
  if (error instanceof VaultClientError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export const isCancelled = (error: unknown) => error instanceof VaultClientError && error.code === "cancelled";

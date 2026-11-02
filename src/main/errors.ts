import type { ErrorCode, VaultErrorShape } from "@shared/types";

export class VaultError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly canUseAccount: boolean;

  constructor(code: ErrorCode, message: string, opts: { retryable?: boolean; canUseAccount?: boolean } = {}) {
    super(message);
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.canUseAccount = opts.canUseAccount ?? false;
  }

  toShape(): VaultErrorShape {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.canUseAccount ? { canUseAccount: true } : {}),
    };
  }
}

export function toErrorShape(error: unknown): VaultErrorShape {
  if (error instanceof VaultError) return error.toShape();
  const message = error instanceof Error ? error.message : String(error);
  return { code: "internal", message, retryable: false };
}

export const cancelled = () => new VaultError("cancelled", "Operación cancelada.");

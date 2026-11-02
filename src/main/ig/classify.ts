import type { AccessMode } from "@shared/types";
import { VaultError } from "../errors";

export interface RawResponse {
  status: number;
  url: string;
  contentType: string;
  body: string;
}

/** Algunas respuestas llegan con prefijos anti-JSON-hijacking o en varias líneas. */
export function parseJsonLoose(body: string): unknown[] {
  const cleaned = body.replace(/^\s*for\s*\(;;\);\s*/, "").trim();
  if (!cleaned) return [];
  try {
    return [JSON.parse(cleaned)];
  } catch {
    const out: unknown[] = [];
    for (const line of cleaned.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || (t[0] !== "{" && t[0] !== "[")) continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        /* línea no JSON */
      }
    }
    return out;
  }
}

function loginError(access: AccessMode): VaultError {
  return access === "public"
    ? new VaultError("public_blocked", "Instagram exige iniciar sesión para esta consulta. No se usó ninguna cuenta.", {
        canUseAccount: true,
      })
    : new VaultError("private_login_required", "La sesión de la cuenta expiró o fue rechazada. Vuelve a conectarla.");
}

/**
 * Convierte una respuesta de la API web en JSON o en un error tipado.
 * Nunca reintenta por su cuenta: 401/403/429/checkpoint detienen la operación.
 */
export function classifyJson(response: RawResponse, access: AccessMode): Record<string, unknown> {
  const { status, contentType, body, url } = response;
  const lower = body.slice(0, 4000).toLowerCase();
  if (status === 0) throw new VaultError("network", `No se pudo contactar con Instagram (${body || "sin respuesta"}).`, { retryable: true });
  if (url.includes("/challenge/") || lower.includes("checkpoint_required") || lower.includes("challenge_required")) {
    throw new VaultError("challenge_required", "Instagram pide una verificación de seguridad. Ábrela en la ventana de la cuenta y vuelve a intentarlo más tarde.");
  }
  if (status === 429 || lower.includes("please wait a few minutes") || lower.includes("feedback_required")) {
    throw new VaultError("rate_limited", "Instagram limitó temporalmente las consultas. Espera unos minutos antes de continuar.", {
      retryable: true,
    });
  }
  if (status === 404) throw new VaultError("not_found", "Instagram no encontró ese contenido.");
  if (url.includes("/accounts/login") || lower.includes("login_required") || status === 401) throw loginError(access);
  if (status === 400 && (lower.includes("not authorized to view user") || lower.includes("private"))) {
    throw new VaultError("private_not_followed", "Esta cuenta es privada y tu cuenta conectada no la sigue.");
  }
  if (status === 403) throw loginError(access);
  if (status >= 500) throw new VaultError("network", `Instagram respondió con un error temporal (${status}).`, { retryable: true });
  const looksHtml = contentType.includes("text/html") || lower.trimStart().startsWith("<!doctype") || lower.trimStart().startsWith("<html");
  if (looksHtml) throw loginError(access);
  const parsed = parseJsonLoose(body)[0];
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new VaultError("provider_changed", "Instagram devolvió una respuesta que la app no reconoce.");
  }
  const json = parsed as Record<string, unknown>;
  if (json.status === "fail") {
    const message = String(json.message ?? "");
    if (/login/i.test(message)) throw loginError(access);
    if (/wait|feedback/i.test(message)) throw new VaultError("rate_limited", "Instagram limitó temporalmente las consultas.", { retryable: true });
    if (/not authorized|private/i.test(message)) throw new VaultError("private_not_followed", "Esta cuenta es privada y tu cuenta conectada no la sigue.");
    throw new VaultError("provider_changed", message || "Instagram rechazó la consulta.");
  }
  if (status < 200 || status >= 300) throw new VaultError("provider_changed", `Respuesta inesperada de Instagram (${status}).`);
  return json;
}

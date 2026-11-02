import type { ParsedUrl } from "@shared/types";
import { sanitizeUsername } from "./parse";

const RESERVED = new Set([
  "accounts",
  "explore",
  "reels",
  "direct",
  "about",
  "legal",
  "web",
  "developer",
  "p",
  "reel",
  "tv",
  "stories",
  "challenge",
  "emails",
]);

/**
 * Interpreta enlaces de Instagram: publicaciones, reels, IGTV, stories,
 * highlights y perfiles. Acepta también "@usuario" o un shortcode suelto.
 */
export function parseInstagramUrl(input: string): ParsedUrl | null {
  const raw = input.trim();
  if (!raw) return null;
  if (/^@[A-Za-z0-9._]{1,30}$/.test(raw)) {
    const username = sanitizeUsername(raw);
    return username ? { type: "profile", username, url: `https://www.instagram.com/${username}/` } : null;
  }
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!(host === "instagram.com" || host.endsWith(".instagram.com") || host === "instagr.am")) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (!parts.length) return null;

  // /<usuario>/p/<code>/ y /<usuario>/reel/<code>/ también existen
  const postIndex = parts.findIndex((p) => p === "p" || p === "reel" || p === "reels" || p === "tv");
  if (postIndex >= 0 && parts[postIndex + 1]) {
    const shortcode = parts[postIndex + 1];
    if (/^[A-Za-z0-9_-]{5,64}$/.test(shortcode)) {
      return { type: "post", shortcode, url: `https://www.instagram.com/p/${shortcode}/` };
    }
    return null;
  }

  if (parts[0] === "stories") {
    if (parts[1] === "highlights" && /^\d+$/.test(parts[2] ?? "")) {
      return { type: "highlight", highlightId: parts[2], url: `https://www.instagram.com/stories/highlights/${parts[2]}/` };
    }
    const username = sanitizeUsername(parts[1] ?? "");
    if (username && /^\d+$/.test(parts[2] ?? "")) {
      return { type: "story", username, storyId: parts[2], url: `https://www.instagram.com/stories/${username}/${parts[2]}/` };
    }
    if (username) return { type: "profile", username, url: `https://www.instagram.com/${username}/` };
    return null;
  }

  if (parts.length >= 1 && !RESERVED.has(parts[0])) {
    const username = sanitizeUsername(parts[0]);
    if (username) return { type: "profile", username, url: `https://www.instagram.com/${username}/` };
  }
  return null;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Convierte un shortcode público en el id numérico de la publicación. */
export function shortcodeToMediaId(shortcode: string): string | null {
  // Los shortcodes de cuentas privadas llevan un sufijo de 28 caracteres.
  const core = shortcode.length > 28 ? shortcode.slice(0, shortcode.length - 28) : shortcode;
  let id = 0n;
  for (const char of core) {
    const value = ALPHABET.indexOf(char);
    if (value < 0) return null;
    id = id * 64n + BigInt(value);
  }
  return id > 0n ? id.toString() : null;
}

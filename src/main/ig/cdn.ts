/**
 * Las URLs firmadas de la CDN de Instagram llevan `oe=<hex>`: el instante
 * (epoch en segundos, hexadecimal) a partir del cual la firma deja de valer.
 */
export function cdnExpiry(url: string | null | undefined): number | null {
  if (!url) return null;
  try {
    const oe = new URL(url).searchParams.get("oe");
    if (!oe || !/^[0-9a-f]{6,12}$/i.test(oe)) return null;
    const value = parseInt(oe, 16);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** Considera caducada una URL a la que le queden menos de `marginSeconds`. */
export function isExpired(expiresAt: number | null, nowSeconds = Math.floor(Date.now() / 1000), marginSeconds = 600): boolean {
  return expiresAt !== null && expiresAt - marginSeconds <= nowSeconds;
}

const CDN_HOSTS = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i;

/** Sólo se descargan bytes desde la CDN de Instagram/Facebook por HTTPS. */
export function isAllowedCdnUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && CDN_HOSTS.test(parsed.hostname);
  } catch {
    return false;
  }
}

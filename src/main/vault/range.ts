/**
 * Interpreta un header Range de un único rango (`bytes=a-b`, `bytes=a-`,
 * `bytes=-n`). Devuelve null si es inválido o no satisfacible.
 */
export function parseRange(header: string, total: number): { start: number; end: number } | null {
  if (total <= 0) return null;
  const spec = header.trim().replace(/^bytes=/i, "");
  if (spec === header.trim()) return null;
  const first = spec.split(",")[0].trim();
  const dash = first.indexOf("-");
  if (dash < 0) return null;
  const startText = first.slice(0, dash).trim();
  const endText = first.slice(dash + 1).trim();
  if (!startText) {
    if (!/^\d+$/.test(endText)) return null;
    const suffix = Number(endText);
    if (suffix === 0) return null;
    const length = Math.min(suffix, total);
    return { start: total - length, end: total - 1 };
  }
  if (!/^\d+$/.test(startText)) return null;
  const start = Number(startText);
  if (start >= total) return null;
  let end = total - 1;
  if (endText) {
    if (!/^\d+$/.test(endText)) return null;
    end = Math.min(Number(endText), total - 1);
  }
  return end >= start ? { start, end } : null;
}

const compact = new Intl.NumberFormat("es", { notation: "compact", maximumFractionDigits: 1 });
const plain = new Intl.NumberFormat("es");

export const fmtCompact = (n: number | null | undefined) => (n === null || n === undefined ? "—" : compact.format(n));
export const fmtInt = (n: number | null | undefined) => (n === null || n === undefined ? "—" : plain.format(n));

export function fmtBytes(bytes: number | null | undefined): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1).replace(".", ",")} ${units[unit]}`;
}

export function fmtSpeed(bps: number): string {
  return bps > 0 ? `${fmtBytes(bps)}/s` : "—";
}

const dateFmt = new Intl.DateTimeFormat("es", { day: "numeric", month: "short", year: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("es", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const monthFmt = new Intl.DateTimeFormat("es", { month: "short" });
const rtf = new Intl.RelativeTimeFormat("es", { numeric: "auto" });

export const fmtDate = (seconds: number | null | undefined) => (seconds ? dateFmt.format(seconds * 1000) : "—");
export const fmtDateTime = (seconds: number | null | undefined) => (seconds ? dateTimeFmt.format(seconds * 1000) : "—");
export const fmtMonth = (seconds: number) => monthFmt.format(seconds * 1000).replace(".", "");

export function fmtRelative(seconds: number | null | undefined): string {
  if (!seconds) return "nunca";
  const diff = seconds - Date.now() / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return "ahora mismo";
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86_400 * 30) return rtf.format(Math.round(diff / 86_400), "day");
  if (abs < 86_400 * 365) return rtf.format(Math.round(diff / (86_400 * 30)), "month");
  return rtf.format(Math.round(diff / (86_400 * 365)), "year");
}

export function fmtDuration(seconds: number | null | undefined): string {
  if (!seconds || !Number.isFinite(seconds)) return "0:00";
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function plural(n: number, one: string, many: string) {
  return `${fmtInt(n)} ${n === 1 ? one : many}`;
}

/** Número de serie estilo borde de película: IG·0042 */
export const filmNumber = (id: number) => `IG·${String(id).padStart(4, "0")}`;

/**
 * Scripts que se ejecutan dentro de la página de instagram.com (ventana oculta
 * de cada partición). Ninguno lee ni devuelve cookies: el token CSRF se usa
 * dentro de la página para firmar la petición, igual que hace la propia web.
 */

export const IG_APP_ID = "936619743392459";

export function fetchScript(path: string, accept: "json" | "text"): string {
  return `(async () => {
    const csrf = (document.cookie.match(/(?:^|; )csrftoken=([^;]+)/) || [])[1] || "";
    let claim = "0";
    try { claim = sessionStorage.getItem("www-claim-v2") || "0"; } catch {}
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(${JSON.stringify(path)}, {
        credentials: "include",
        signal: controller.signal,
        headers: ${
          accept === "json"
            ? `{ "Accept": "*/*", "X-IG-App-ID": "${IG_APP_ID}", "X-Requested-With": "XMLHttpRequest", "X-CSRFToken": csrf, "X-IG-WWW-Claim": claim }`
            : `{ "Accept": "text/html,application/xhtml+xml" }`
        }
      });
      const body = await response.text();
      return { status: response.status, url: response.url, contentType: response.headers.get("content-type") || "", body: body.length > 40000000 ? "" : body };
    } catch (error) {
      return { status: 0, url: ${JSON.stringify(path)}, contentType: "", body: String(error && error.message || error) };
    } finally {
      clearTimeout(timer);
    }
  })()`;
}

/** Resumen del DOM sin secretos (fallback de metadatos y detección de muros). */
export const SNAPSHOT_SCRIPT = `(() => ({
  url: location.href,
  title: document.title,
  text: (document.body && document.body.innerText || "").slice(0, 12000),
  description: (document.querySelector('meta[name="description"]') || {}).content || "",
  images: Array.from(document.images).slice(0, 120).map(img => ({
    src: (() => {
      const candidates = (img.srcset || "").split(",").map(item => {
        const parts = item.trim().split(/\\s+/); const width = parseInt(parts[1] || "0", 10);
        return { url: parts[0] || "", width: Number.isFinite(width) ? width : 0 };
      }).filter(item => item.url);
      candidates.sort((a, b) => b.width - a.width);
      return (candidates[0] && candidates[0].url) || img.currentSrc || img.src || "";
    })(),
    alt: img.alt || "", width: img.naturalWidth || 0, height: img.naturalHeight || 0,
    href: (img.closest("a") && img.closest("a").href) || ""
  })),
  highlights: Array.from(document.querySelectorAll('a[href*="/stories/highlights/"]')).map(a => ({
    href: a.href, title: (a.innerText || a.getAttribute("aria-label") || "").trim().slice(0, 80)
  }))
}))()`;

/** Datos que la página trae incrustados (SSR) en lugar de pedirlos por la red. */
export const SSR_SCRIPT = `(() => Array.from(document.querySelectorAll('script[type="application/json"]'))
  .map(s => s.textContent || "")
  .filter(t => t.includes("__bbox") && t.includes('"result"')))()`;

/** Desplaza la cuadrícula del perfil y devuelve los shortcodes visibles. */
export const SCROLL_SCRIPT = `(() => {
  const root = document.querySelector("main") || document;
  const anchors = Array.from(root.querySelectorAll('a[href*="/p/"],a[href*="/reel/"]'));
  const items = anchors.map(anchor => {
    const img = anchor.querySelector("img");
    const parts = new URL(anchor.href, location.href).pathname.split("/").filter(Boolean);
    const marker = parts.findIndex(part => part === "p" || part === "reel");
    const code = marker >= 0 ? (parts[marker + 1] || "") : "";
    if (!img || !code) return null;
    const candidates = (img.srcset || "").split(",").map(item => {
      const fields = item.trim().split(/\\s+/);
      return { url: fields[0] || "", width: parseInt(fields[1] || "0", 10) || 0 };
    }).filter(item => item.url).sort((a, b) => b.width - a.width);
    return {
      id: "web_" + code,
      __instavault_dom: true,
      shortcode: code,
      display_url: (candidates[0] && candidates[0].url) || img.currentSrc || img.src || "",
      dimensions: { width: img.naturalWidth || 0, height: img.naturalHeight || 0 },
      caption_text: img.alt || ""
    };
  }).filter(Boolean);
  const last = anchors[anchors.length - 1];
  if (last) last.scrollIntoView({ block: "end", behavior: "instant" });
  const scrollers = Array.from(document.querySelectorAll("main,section,div")).filter(el => {
    const style = getComputedStyle(el);
    return el.scrollHeight > el.clientHeight + 100 && /(auto|scroll)/.test(style.overflowY);
  }).sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
  const target = scrollers[0] || document.scrollingElement || document.documentElement;
  target.scrollTop += Math.max(target.clientHeight * 0.85, 720);
  window.scrollBy(0, Math.max(window.innerHeight * 0.85, 720));
  return { height: target.scrollHeight, posts: items.length, fingerprint: items.map(i => i.shortcode).join(","), items };
})()`;

/** Usuario conectado visible en la página (respaldo si la API no responde). */
export const CURRENT_USER_SCRIPT = `(() => {
  if (location.pathname.startsWith("/accounts/")) return null;
  const excluded = new Set(["accounts","explore","reels","direct","stories","about","legal","web"]);
  for (const img of Array.from(document.images)) {
    const match = (img.alt || "").match(/^(.+?)(?:'s|’s) profile picture$/i) || (img.alt || "").match(/^Foto del perfil de (.+)$/i);
    if (match && /^[A-Za-z0-9._]{1,30}$/.test(match[1])) return match[1];
  }
  for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
    const parts = new URL(anchor.href, location.href).pathname.split("/").filter(Boolean);
    if (parts.length === 1 && /^[A-Za-z0-9._]{1,30}$/.test(parts[0]) && !excluded.has(parts[0])) {
      const label = (anchor.getAttribute("aria-label") || anchor.textContent || "").toLowerCase();
      if (label.includes("profile") || label.includes("perfil")) return parts[0];
    }
  }
  return null;
})()`;

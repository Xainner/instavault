import { nativeImage, session } from "electron";
import { isAllowedCdnUrl } from "../ig/cdn";
import { cleanUserAgent } from "../ig/bridge";
import type { IngestResult, VaultStore, AssetBucket } from "../vault/store";

/**
 * Las descargas de bytes usan una partición propia que nunca inicia sesión:
 * la CDN no recibe cookies de ninguna cuenta.
 */
const CDN_PARTITION = "ig-cdn";

export class CdnError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
  /** 403/410 suelen indicar firma caducada: conviene re-resolver la URL. */
  get expired() {
    return this.status === 403 || this.status === 410;
  }
}

export async function cdnFetch(url: string, signal?: AbortSignal): Promise<Response> {
  if (!isAllowedCdnUrl(url)) throw new CdnError("URL de descarga no permitida", 0);
  const ses = session.fromPartition(CDN_PARTITION);
  const response = await ses.fetch(url, {
    signal,
    headers: { "User-Agent": cleanUserAgent(), Accept: "*/*", Referer: "https://www.instagram.com/" },
  });
  if (!response.ok || !response.body) throw new CdnError(`HTTP ${response.status}`, response.status);
  return response;
}

export async function downloadToStore(
  store: VaultStore,
  url: string,
  opts: { bucket: AssetBucket; fallbackMime: string; signal?: AbortSignal; onBytes?: (n: number) => void; maxBytes?: number },
): Promise<IngestResult> {
  const response = await cdnFetch(url, opts.signal);
  const mime = (response.headers.get("content-type") ?? opts.fallbackMime).split(";")[0].trim() || opts.fallbackMime;
  return store.ingestStream(response.body as ReadableStream<Uint8Array>, {
    bucket: opts.bucket,
    mime,
    onBytes: opts.onBytes,
    maxBytes: opts.maxBytes,
  });
}

/** Miniatura JPEG de 480 px a partir de una imagen ya guardada. */
export async function makeThumb(store: VaultStore, absPath: string): Promise<IngestResult | null> {
  const image = nativeImage.createFromPath(absPath);
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  if (width <= 520) return null;
  const resized = image.resize({ width: 480, quality: "good" });
  const size = resized.getSize();
  return store.ingestBuffer(resized.toJPEG(82), { bucket: "thumbs", mime: "image/jpeg", width: size.width, height: size.height || Math.round((height * 480) / width) });
}

export function imageSize(absPath: string): { width: number; height: number } | null {
  const image = nativeImage.createFromPath(absPath);
  return image.isEmpty() ? null : image.getSize();
}

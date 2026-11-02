import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm, stat, writeFile, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Repo, AssetRow } from "../db/repo";

export type AssetBucket = "media" | "thumbs" | "avatars";

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

export function extensionFor(mime: string): string {
  return EXT_BY_MIME[mime.toLowerCase()] ?? "bin";
}

/** Detecta el tipo real por la firma de bytes; la CDN a veces responde con mime genérico. */
export function sniffMime(head: Uint8Array, fallback: string): string {
  const b = head;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45)
    return "image/webp";
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (brand.startsWith("hei") || brand === "mif1") return "image/heic";
    if (brand === "qt  ") return "video/quicktime";
    return "video/mp4";
  }
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  return fallback;
}

export interface IngestResult extends AssetRow {
  absPath: string;
  created: boolean;
}

/**
 * Almacén direccionado por contenido: `<root>/<bucket>/<aa>/<sha256>.<ext>`.
 * Escribe a un temporal mientras calcula el hash y lo mueve de forma atómica;
 * si el contenido ya existe, sólo descarta el temporal (deduplicación).
 */
export class VaultStore {
  constructor(
    readonly root: string,
    private readonly repo: Repo,
  ) {}

  absolute(relPath: string): string {
    return join(this.root, relPath);
  }

  async ingestStream(
    source: Readable | ReadableStream<Uint8Array>,
    opts: { bucket: AssetBucket; mime: string; width?: number | null; height?: number | null; maxBytes?: number; onBytes?: (n: number) => void },
  ): Promise<IngestResult> {
    const tmpDir = join(this.root, "tmp");
    await mkdir(tmpDir, { recursive: true });
    const tmp = join(tmpDir, `${randomUUID()}.part`);
    const hash = createHash("sha256");
    let bytes = 0;
    let head = new Uint8Array(0);
    const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024 * 1024;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        bytes += chunk.length;
        if (bytes > maxBytes) return done(new Error("el archivo supera el tamaño máximo permitido"));
        if (head.length < 32) head = Buffer.concat([head, chunk.subarray(0, 32 - head.length)]);
        hash.update(chunk);
        opts.onBytes?.(chunk.length);
        done(null, chunk);
      },
    });
    const readable = source instanceof Readable ? source : Readable.fromWeb(source as import("node:stream/web").ReadableStream<Uint8Array>);
    try {
      await pipeline(readable, meter, createWriteStream(tmp));
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
    if (bytes === 0) {
      await rm(tmp, { force: true });
      throw new Error("respuesta vacía");
    }
    return this.commit(tmp, hash.digest("hex"), bytes, sniffMime(head, opts.mime), opts);
  }

  async ingestBuffer(
    data: Uint8Array,
    opts: { bucket: AssetBucket; mime: string; width?: number | null; height?: number | null },
  ): Promise<IngestResult> {
    const sha = createHash("sha256").update(data).digest("hex");
    const existing = this.repo.getAsset(sha);
    if (existing && existsSync(this.absolute(existing.relPath))) return { ...existing, absPath: this.absolute(existing.relPath), created: false };
    const tmpDir = join(this.root, "tmp");
    await mkdir(tmpDir, { recursive: true });
    const tmp = join(tmpDir, `${randomUUID()}.part`);
    await writeFile(tmp, data);
    return this.commit(tmp, sha, data.length, sniffMime(data.subarray(0, 32), opts.mime), opts);
  }

  private async commit(
    tmp: string,
    sha: string,
    bytes: number,
    mime: string,
    opts: { bucket: AssetBucket; width?: number | null; height?: number | null },
  ): Promise<IngestResult> {
    const existing = this.repo.getAsset(sha);
    if (existing && existsSync(this.absolute(existing.relPath))) {
      await rm(tmp, { force: true });
      if ((opts.width && !existing.width) || (opts.height && !existing.height)) {
        this.repo.upsertAsset({ ...existing, width: opts.width ?? existing.width, height: opts.height ?? existing.height });
      }
      return { ...existing, absPath: this.absolute(existing.relPath), created: false };
    }
    const relPath = join(opts.bucket, sha.slice(0, 2), `${sha}.${extensionFor(mime)}`);
    const absPath = this.absolute(relPath);
    await mkdir(dirname(absPath), { recursive: true });
    await rename(tmp, absPath);
    const row: AssetRow = { sha256: sha, relPath, mime, bytes, width: opts.width ?? null, height: opts.height ?? null };
    this.repo.upsertAsset(row);
    return { ...row, absPath, created: true };
  }

  /** Importa un archivo existente verificando su SHA-256. */
  async ingestFile(path: string, opts: { bucket: AssetBucket; mime: string }): Promise<IngestResult> {
    return this.ingestStream(createReadStream(path), opts);
  }

  /** Copia un asset a un destino externo y verifica la copia por SHA-256. */
  async exportTo(sha: string, destination: string): Promise<void> {
    const asset = this.repo.getAsset(sha);
    if (!asset) throw new Error("el archivo no está en el almacén");
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(this.absolute(asset.relPath), destination);
    const copied = await hashFile(destination);
    if (copied !== sha) {
      await rm(destination, { force: true });
      throw new Error("la copia exportada no superó la verificación SHA-256");
    }
  }

  async removeAsset(asset: AssetRow): Promise<number> {
    const path = this.absolute(asset.relPath);
    let size = 0;
    try {
      size = (await stat(path)).size;
    } catch {
      /* ya no existe */
    }
    await rm(path, { force: true });
    this.repo.deleteAsset(asset.sha256);
    return size;
  }

  async cleanTmp(): Promise<void> {
    await rm(join(this.root, "tmp"), { recursive: true, force: true });
  }
}

export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), new Transform({ transform(chunk, _e, done) { hash.update(chunk); done(); } }));
  return hash.digest("hex");
}

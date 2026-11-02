import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { protocol } from "electron";
import type { Repo } from "../db/repo";
import type { VaultStore } from "./store";
import { parseRange } from "./range";

export const VAULT_SCHEME = "vault";

/** Debe llamarse antes de `app.whenReady()`. */
export function registerVaultScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: VAULT_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
    },
  ]);
}

const SHA = /^[0-9a-f]{64}$/;

/**
 * vault://a/<sha256> sirve archivos del almacén con soporte de Range real:
 * sólo se lee del disco el tramo pedido (videos fluidos al saltar).
 */
export function handleVaultProtocol(repo: Repo, store: VaultStore) {
  protocol.handle(VAULT_SCHEME, async (request) => {
    const url = new URL(request.url);
    const sha = url.pathname.replace(/^\/+/, "");
    if (url.hostname !== "a" || !SHA.test(sha)) return new Response(null, { status: 404 });
    const asset = repo.getAsset(sha);
    if (!asset) return new Response(null, { status: 404 });
    const path = store.absolute(asset.relPath);
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      return new Response(null, { status: 404 });
    }
    const baseHeaders = {
      "Content-Type": asset.mime,
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=31536000, immutable",
    };
    const rangeHeader = request.headers.get("range");
    if (rangeHeader) {
      const range = parseRange(rangeHeader, size);
      if (!range) {
        return new Response(null, { status: 416, headers: { ...baseHeaders, "Content-Range": `bytes */${size}` } });
      }
      const body = Readable.toWeb(createReadStream(path, { start: range.start, end: range.end })) as ReadableStream;
      return new Response(body, {
        status: 206,
        headers: {
          ...baseHeaders,
          "Content-Length": String(range.end - range.start + 1),
          "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
        },
      });
    }
    const body = Readable.toWeb(createReadStream(path)) as ReadableStream;
    return new Response(body, { status: 200, headers: { ...baseHeaders, "Content-Length": String(size) } });
  });
}

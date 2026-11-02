import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Fronteras de privacidad verificadas sobre el código fuente: el modo
 * público nunca toca una partición de cuenta, la CDN nunca recibe cookies
 * y ninguna sesión se exporta fuera de Chromium.
 */
const root = join(__dirname, "..", "src");
const read = (path: string) => readFileSync(join(root, path), "utf8");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}
const mainFiles = walk(join(root, "main")).filter((f) => f.endsWith(".ts"));
const allMain = mainFiles.map((f) => ({ file: f, text: readFileSync(f, "utf8") }));

describe("aislamiento de sesiones", () => {
  it("el modo público usa una partición en memoria, nunca persistente", () => {
    const service = read("main/ig/service.ts");
    expect(service).toMatch(/new IgBridge\("ig-public", "public"\)/);
    expect(service).not.toMatch(/persist:ig-public/);
  });

  it("las cuentas usan particiones persistentes propias", () => {
    expect(read("main/ig/accounts.ts")).toMatch(/persist:ig-acct-\$\{randomUUID\(\)\}/);
  });

  it("la CDN se descarga desde una partición que nunca inicia sesión", () => {
    const cdn = read("main/net/cdn.ts");
    expect(cdn).toMatch(/const CDN_PARTITION = "ig-cdn"/);
    expect(cdn).not.toMatch(/persist:/);
    for (const { file, text } of allMain) {
      if (file.endsWith("cdn.ts")) continue;
      expect(text, file).not.toMatch(/fromPartition\("ig-cdn"\)/);
    }
  });

  it("sólo se descargan bytes de hosts de la CDN por https", () => {
    expect(read("main/ig/cdn.ts")).toMatch(/cdninstagram\\\.com\|fbcdn\\\.net/);
    expect(read("main/net/cdn.ts")).toMatch(/if \(!isAllowedCdnUrl\(url\)\) throw/);
  });
});

describe("las cookies no salen de Chromium", () => {
  it("ningún módulo exporta o inyecta cookies", () => {
    for (const { file, text } of allMain) {
      expect(text, file).not.toMatch(/Network\.getCookies|Network\.setCookie|cookies\.set\(|getAllCookies|keyring|keytar/);
    }
  });

  it("sólo el login comprueba la existencia de la sesión", () => {
    const users = allMain.filter(({ text }) => /cookies\.get\(/.test(text)).map(({ file }) => file.replace(/\\/g, "/").split("/src/")[1]);
    expect(users).toEqual(["main/ig/accounts.ts"]);
    const accounts = read("main/ig/accounts.ts");
    // El valor de sessionid nunca se lee, sólo su presencia.
    expect(accounts).not.toMatch(/sessionCookie\.value/);
  });

  it("los scripts inyectados no devuelven document.cookie", () => {
    const scripts = read("main/ig/scripts.ts");
    const returns = scripts.match(/return \{[^}]*\}/g) ?? [];
    for (const r of returns) expect(r).not.toMatch(/cookie|csrf/i);
  });
});

describe("la biblioteca local no genera tráfico", () => {
  it("los métodos de biblioteca no usan el servicio de Instagram", () => {
    const all = read("main/ipc.ts");
    const ipc = all.slice(all.indexOf("const handlers: Handlers"));
    for (const method of ["profiles:list", "profiles:get", "media:list", "library:stats", "sync:state"]) {
      const start = ipc.indexOf(`"${method}":`);
      const chunk = ipc.slice(start, ipc.indexOf("\n    \"", start + 1));
      expect(chunk, method).not.toMatch(/\big\./);
    }
  });

  it("el renderer no carga recursos remotos", () => {
    const html = read("renderer/index.html");
    expect(html).toMatch(/img-src 'self' vault: data: blob:/);
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3)/);
    for (const file of walk(join(root, "renderer", "src")).filter((f) => /\.(tsx?|css)$/.test(f))) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/fonts\.googleapis|cdninstagram|fbcdn/);
    }
  });

  it("el IPC rechaza remitentes que no sean la ventana principal", () => {
    expect(read("main/ipc.ts")).toMatch(/event\.sender !== win\.webContents/);
  });

  it("la ventana principal usa sandbox y aislamiento de contexto", () => {
    const index = read("main/index.ts");
    expect(index).toMatch(/sandbox: true/);
    expect(index).toMatch(/contextIsolation: true/);
    expect(index).toMatch(/nodeIntegration: false/);
  });
});

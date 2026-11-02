// Prueba visual de humo: arranca la app compilada con una biblioteca de
// demostración (sin tráfico a Instagram) y captura cada pantalla.
// Uso: xvfb-run -a node e2e/smoke.mjs   (requiere `npm run build` antes)
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { _electron: electron } = require("playwright");
const electronPath = require("electron");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = process.env.SMOKE_OUT ?? join(root, "e2e", ".artifacts");
mkdirSync(out, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function launch({ onboarding = false, bulk = 0 } = {}) {
  const userData = mkdtempSync(join(tmpdir(), "iv-smoke-"));
  const app = await electron.launch({
    executablePath: electronPath,
    args: ["--no-sandbox", root],
    env: {
      ...process.env,
      INSTAVAULT_USER_DATA: userData,
      INSTAVAULT_SEED_DIR: join(root, "e2e", "fixtures"),
      INSTAVAULT_SEED_BULK: String(bulk),
      INSTAVAULT_SEED_ONBOARDING: onboarding ? "1" : "0",
      INSTAVAULT_LEGACY_DB: join(userData, "no-legacy.db"),
    },
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.waitForLoadState("domcontentloaded");
  return { app, page, errors, userData };
}

async function size(app, page, width, height) {
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [width, height]);
  await page.waitForTimeout(400);
}

async function settle(page, ms = 1600) {
  await page.waitForTimeout(ms);
}

async function shot(page, name) {
  await page.screenshot({ path: join(out, `${name}.png`) });
}

// ------------------------------------------------------------ onboarding
{
  const { app, page, errors, userData } = await launch({ onboarding: true });
  await size(app, page, 1440, 900);
  await page.getByText("Tu cuarto").waitFor({ timeout: 20000 });
  await settle(page, 2600);
  await shot(page, "01-onboarding");
  await page.getByRole("button", { name: /Empezar/ }).click();
  await settle(page, 900);
  await shot(page, "02-onboarding-acceso");
  await page.getByRole("button", { name: /Abrir mi archivo/ }).click();
  await settle(page);
  check("onboarding se completa", await page.getByText("Tu archivo").first().isVisible());
  check("onboarding sin errores de consola", errors.length === 0, errors.join(" | "));
  await app.close();
  rmSync(userData, { recursive: true, force: true });
}

// --------------------------------------------------------- recorrido
{
  const { app, page, errors, userData } = await launch();
  await size(app, page, 1440, 900);
  await page.getByText("Tu archivo").first().waitFor({ timeout: 20000 });
  await settle(page, 2200);
  await shot(page, "03-archivo");
  check("archivo muestra los perfiles de demo", (await page.getByText("@costa.norte").count()) > 0);

  await page.locator(".view-scroll").first().evaluate((el) => el.scrollTo({ top: 640 }));
  await settle(page, 1200);
  await shot(page, "04-archivo-todos");

  await page.getByRole("button", { name: /^Recientes$/ }).count();
  await page.locator(".segmented button").filter({ has: page.locator("svg.lucide-list") }).click();
  await settle(page, 900);
  await shot(page, "05-archivo-lista");
  await page.locator(".segmented button").filter({ has: page.locator("svg.lucide-layout-grid") }).click();

  await page.locator(".view-scroll").first().evaluate((el) => el.scrollTo({ top: 0 }));
  await page.getByText("Costa Norte").first().click();
  await page.getByRole("button", { name: /Archivo/ }).first().waitFor();
  await settle(page, 2400);
  await shot(page, "06-perfil");
  check("perfil muestra la grilla", (await page.locator(".cell").count()) > 6);

  await page.locator(".view-scroll").first().evaluate((el) => el.scrollTo({ top: 520 }));
  await settle(page, 1200);
  await shot(page, "07-perfil-grilla");

  // Selección con clic derecho y barra flotante
  const cells = page.locator(".cell");
  await cells.nth(0).click({ button: "right" });
  await cells.nth(1).click({ button: "right" });
  await cells.nth(3).click({ button: "right" });
  await settle(page, 700);
  await shot(page, "08-seleccion");
  check("barra de selección visible", await page.getByText("seleccionadas").isVisible());
  await page.keyboard.press("Escape");
  await settle(page, 500);

  // Visor: imagen
  await cells.nth(1).click();
  await page.locator(".viewer").waitFor();
  await settle(page, 1800);
  await shot(page, "09-visor-imagen");
  check("visor abre", await page.locator(".viewer").isVisible());

  await page.keyboard.press("Escape");
  await settle(page, 500);

  // Carrusel: abrir y bajar a la segunda pieza
  await page.locator(".cell", { has: page.locator("svg.lucide-images") }).first().click();
  await page.locator(".viewer").waitFor();
  await page.keyboard.press("ArrowDown");
  await settle(page, 1400);
  await shot(page, "10-visor-carrusel");
  check("carrusel navega entre piezas", (await page.locator(".viewer").innerText()).includes("2/3"));
  await page.keyboard.press("Escape");
  await settle(page, 500);

  // Video
  await page.locator(".cell", { has: page.locator(".cell-badge", { hasText: "0:06" }) }).first().click();
  await settle(page, 2200);
  await shot(page, "11-visor-video");
  const hasVideo = await page.locator(".viewer video").count();
  check("visor reproduce video", hasVideo > 0);
  if (hasVideo) {
    const played = await page.locator(".viewer video").evaluate((v) => new Promise((r) => setTimeout(() => r(v.currentTime > 0 || !v.paused), 1200)));
    check("el video avanza (Range sobre vault://)", Boolean(played));
  }
  await page.keyboard.press("Escape");
  await settle(page, 500);

  // Pestañas
  await page.locator(".tab", { hasText: "Stories" }).click();
  await settle(page, 1600);
  await shot(page, "12-stories");
  await page.locator(".tab", { hasText: "Highlights" }).click();
  await settle(page, 1600);
  await shot(page, "13-highlights");

  // Perfil con límite anónimo
  await page.getByText("Ruta Andina").first().click();
  await settle(page, 2200);
  await shot(page, "14-perfil-limite");

  // Perfil privado (sin pestaña con contenido de stories)
  await page.locator(".nav-item", { hasText: "Archivo" }).first().click();
  await settle(page, 900);

  // Revelando
  await page.getByRole("button", { name: /Revelando/ }).click();
  await settle(page, 900);
  await shot(page, "15-revelando");
  await page.keyboard.press("Escape");
  await settle(page, 500);

  // Descargar por enlace
  await page.locator(".nav-item", { hasText: "Descargar por enlace" }).click();
  await settle(page, 1400);
  await shot(page, "16-enlace");
  await page.locator("input").first().fill("https://www.instagram.com/p/C9xYz12AbCd/");
  await settle(page, 300);

  // Cuentas
  await page.locator(".nav-item", { hasText: "Cuentas" }).click();
  await settle(page, 1400);
  await shot(page, "17-cuentas");

  // Ajustes
  await page.locator(".nav-item", { hasText: "Ajustes" }).click();
  await settle(page, 1400);
  await shot(page, "18-ajustes");

  // Paleta
  await page.keyboard.press("Control+K");
  await settle(page, 500);
  await page.keyboard.type("costa");
  await settle(page, 500);
  await shot(page, "19-paleta");
  await page.keyboard.press("Escape");

  // Pantalla grande
  await page.locator(".nav-item", { hasText: "Archivo" }).first().click();
  await size(app, page, 1920, 1080);
  await settle(page, 1600);
  await shot(page, "20-archivo-1920");
  await size(app, page, 1280, 800);
  await settle(page, 1200);
  await shot(page, "21-archivo-1280");

  const vaultOk = await page.evaluate(async () => {
    const img = document.querySelector(".mosaic img");
    if (!img) return false;
    const r = await fetch(img.src, { headers: { Range: "bytes=0-99" } });
    return r.status === 206 && (await r.arrayBuffer()).byteLength === 100;
  });
  check("vault:// responde a Range con 206", vaultOk);
  check("recorrido sin errores de consola", errors.length === 0, errors.join(" | "));
  await app.close();
  rmSync(userData, { recursive: true, force: true });
}

// ------------------------------------------------------------ rendimiento
{
  const { app, page, errors, userData } = await launch({ bulk: 5000 });
  await size(app, page, 1440, 900);
  await page.getByText("Tu archivo").first().waitFor({ timeout: 30000 });
  await page.getByText("Archivo masivo").first().click();
  await page.locator(".cell").first().waitFor({ timeout: 20000 });
  await settle(page, 1500);
  const stats = await page.locator(".view-scroll").first().evaluate(
    (el) =>
      new Promise((resolve) => {
        const deltas = [];
        let last = performance.now();
        let frames = 0;
        const step = () => {
          const now = performance.now();
          deltas.push(now - last);
          last = now;
          el.scrollTop += 140;
          if (++frames < 240) requestAnimationFrame(step);
          else {
            deltas.sort((a, b) => a - b);
            resolve({ p50: deltas[Math.floor(deltas.length * 0.5)], p95: deltas[Math.floor(deltas.length * 0.95)], cells: document.querySelectorAll(".cell").length });
          }
        };
        requestAnimationFrame(step);
      }),
  );
  await shot(page, "22-masivo");
  check("5.000 piezas: DOM virtualizado", stats.cells < 200, `${stats.cells} celdas montadas`);
  check("5.000 piezas: scroll fluido", stats.p95 < 50, `p50 ${stats.p50.toFixed(1)} ms · p95 ${stats.p95.toFixed(1)} ms`);
  check("masivo sin errores de consola", errors.length === 0, errors.join(" | "));
  await app.close();
  rmSync(userData, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} comprobaciones correctas. Capturas en ${out}`);
process.exit(failed.length ? 1 : 0);

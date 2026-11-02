import { ArchiveRestore, Clock, CloudDownload, FolderOpen, HardDrive, RefreshCw, Sparkles, Trash } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { LegacyImportInfo, StorageInfo } from "@shared/types";
import { call, errorMessage } from "../lib/api";
import { fmtBytes, fmtInt } from "../lib/format";
import { useStore } from "../store";
import { Segmented, Spinner, Switch } from "../ui/primitives";
import { ImportProgress } from "./Onboarding";

function Section({ eyebrow, title, children }: { eyebrow: string; title: ReactNode; children: ReactNode }) {
  return (
    <section className="grid grid-cols-[260px_minmax(0,1fr)] gap-10 border-t border-line py-10">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h2 className="display mt-2 text-[34px] leading-none">{title}</h2>
      </div>
      <div className="space-y-6">{children}</div>
    </section>
  );
}

function Row({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-8">
      <div className="min-w-0">
        <div className="text-[14px] text-paper">{title}</div>
        {hint && <div className="mt-1 max-w-[60ch] text-[12.5px] leading-relaxed text-paper-3">{hint}</div>}
      </div>
      <div className="flex-none">{children}</div>
    </div>
  );
}

export function SettingsView() {
  const { settings, saveSettings, accounts, info, update, refreshProfiles } = useStore();
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [legacy, setLegacy] = useState<LegacyImportInfo | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [importing, setImporting] = useState(false);

  const reload = () => {
    void call("storage:info").then(setStorage);
    void call("legacy:info").then(setLegacy);
  };
  useEffect(reload, []);

  if (!settings) return null;
  const valid = accounts.filter((a) => a.status === "valid");

  return (
    <div className="view-scroll">
      <div className="mx-auto max-w-[1080px] px-10 pb-24 pt-10">
        <div className="eyebrow">Preferencias</div>
        <h1 className="display mb-10 mt-3 text-[84px]">
          <em>Ajustes</em>
        </h1>

        <Section eyebrow="01 · Acceso" title="Instagram">
          <Row
            title="Cuando el modo anónimo se bloquea"
            hint="Instagram limita lo que muestra sin sesión. Decide si InstaVault debe preguntarte, usar tu cuenta predeterminada automáticamente o no ofrecerla nunca."
          >
            <Segmented
              id="fallback"
              value={settings.fallbackPolicy}
              onChange={(v) => void saveSettings({ fallbackPolicy: v })}
              options={[
                { value: "ask", label: "Preguntar" },
                { value: "auto", label: "Automático" },
                { value: "never", label: "Nunca" },
              ]}
            />
          </Row>
          <Row title="Cuenta predeterminada" hint="Se usa para perfiles privados, stories, highlights y como respaldo.">
            <select
              className="field h-9 cursor-pointer rounded-[10px] px-3 text-[13px] text-paper"
              value={settings.defaultAccountId ?? ""}
              onChange={(e) => void saveSettings({ defaultAccountId: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">Ninguna</option>
              {valid.map((a) => (
                <option key={a.id} value={a.id}>
                  @{a.username}
                </option>
              ))}
            </select>
          </Row>
          <Row title="Publicaciones por sincronización" hint="Cuántas publicaciones nuevas leer en cada pasada antes de pausar. Lotes menores son más discretos.">
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={12}
                max={240}
                step={12}
                value={settings.postsBatchSize}
                onChange={(e) => void saveSettings({ postsBatchSize: Number(e.target.value) })}
                className="range w-40"
                style={{ ["--p" as string]: `${((settings.postsBatchSize - 12) / 228) * 100}%` }}
              />
              <span className="numeral w-10 text-right text-[24px]">{settings.postsBatchSize}</span>
            </div>
          </Row>
          <Row title="Miniaturas al sincronizar" hint="Descarga vistas previas pequeñas para que el archivo se vea completo antes de revelar.">
            <Switch on={settings.thumbnailsOnSync} onChange={(v) => void saveSettings({ thumbnailsOnSync: v })} />
          </Row>
        </Section>

        <Section eyebrow="02 · Revelado" title="Descargas">
          <Row title="Descargas simultáneas" hint="Más paralelismo descarga más rápido, pero usa más ancho de banda.">
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={1}
                max={8}
                value={settings.concurrency}
                onChange={(e) => void saveSettings({ concurrency: Number(e.target.value) })}
                className="range w-40"
                style={{ ["--p" as string]: `${((settings.concurrency - 1) / 7) * 100}%` }}
              />
              <span className="numeral w-10 text-right text-[24px]">{settings.concurrency}</span>
            </div>
          </Row>
        </Section>

        <Section eyebrow="03 · Almacén" title="En tu equipo">
          <div className="panel grid grid-cols-3 gap-6 p-6">
            <div>
              <div className="numeral text-[40px] leading-none">{fmtBytes(storage?.bytes ?? 0)}</div>
              <div className="eyebrow mt-2">ocupado</div>
            </div>
            <div>
              <div className="numeral text-[40px] leading-none">{fmtInt(storage?.assets ?? 0)}</div>
              <div className="eyebrow mt-2">archivos</div>
            </div>
            <div>
              <div className={`numeral text-[40px] leading-none ${storage?.orphanBytes ? "text-amber-2" : ""}`}>{fmtBytes(storage?.orphanBytes ?? 0)}</div>
              <div className="eyebrow mt-2">recuperable</div>
            </div>
            <div className="col-span-3 flex items-center gap-2 border-t border-line pt-4">
              <HardDrive size={14} className="text-paper-3" />
              <span className="mono min-w-0 flex-1 truncate text-[11.5px] text-paper-3" data-selectable>
                {storage?.vaultDir}
              </span>
              <button className="btn btn-sm" onClick={() => void call("storage:open")}>
                <FolderOpen size={13} /> Abrir carpeta
              </button>
              <button
                className="btn btn-sm"
                disabled={!storage?.orphanBytes || cleaning}
                onClick={async () => {
                  setCleaning(true);
                  try {
                    const r = await call("storage:gc");
                    toast.success(`Se liberaron ${fmtBytes(r.bytes)}`, { description: `${r.removed} archivos sin uso eliminados.` });
                    reload();
                  } finally {
                    setCleaning(false);
                  }
                }}
              >
                {cleaning ? <Spinner size={13} /> : <Sparkles size={13} />} Liberar espacio
              </button>
            </div>
          </div>
          <p className="text-[12.5px] leading-relaxed text-paper-3">
            Los archivos se guardan con su huella SHA-256 como nombre, sin duplicados. Para llevarte una copia con nombres legibles usa
            «Guardar en el equipo» desde cualquier perfil o selección.
          </p>
        </Section>

        <Section eyebrow="04 · Migración" title="InstaVault 1.x">
          {legacy?.available ? (
            <>
              <Row
                title={legacy.done ? "Biblioteca 1.x importada" : "Se encontró una biblioteca anterior"}
                hint={`${fmtInt(legacy.profiles)} perfiles · ${fmtInt(legacy.media)} piezas · ${fmtInt(legacy.downloaded)} archivos. El original no se modifica: se trabaja sobre una copia.`}
              >
                <button
                  className={`btn ${legacy.done ? "" : "btn-primary"}`}
                  disabled={importing}
                  onClick={async () => {
                    setImporting(true);
                    try {
                      const r = await call("legacy:import");
                      toast.success("Importación completa", { description: `${r.profiles} perfiles · ${r.media} piezas · ${r.files} archivos` });
                      await refreshProfiles();
                      reload();
                    } catch (error) {
                      toast.error("La importación falló", { description: errorMessage(error) });
                    } finally {
                      setImporting(false);
                    }
                  }}
                >
                  {importing ? <Spinner size={14} /> : legacy.done ? <RefreshCw size={14} /> : <ArchiveRestore size={15} />}
                  {legacy.done ? "Importar de nuevo" : "Importar ahora"}
                </button>
              </Row>
              {importing && <ImportProgress />}
            </>
          ) : (
            <Row title="No hay biblioteca anterior" hint="Si usabas InstaVault 1.x en este equipo, su base de datos aparecerá aquí automáticamente.">
              <Clock size={18} className="text-paper-4" />
            </Row>
          )}
          {legacy?.legacyBrowserProfile && (
            <Row title="Navegador antiguo de la 1.x" hint="Contiene la sesión de Instagram que usaba la versión anterior. Ya no se necesita.">
              <button
                className="btn btn-danger btn-sm"
                onClick={async () => {
                  const removed = await call("legacy:removeBrowserProfile");
                  if (removed) toast.success("Perfil de navegador antiguo eliminado");
                  reload();
                }}
              >
                <Trash size={13} /> Eliminar
              </button>
            </Row>
          )}
        </Section>

        <Section eyebrow="05 · Interfaz" title="Movimiento">
          <Row title="Reducir animaciones" hint="Desactiva el efecto de revelado y las transiciones más llamativas.">
            <Switch on={settings.reduceMotion} onChange={(v) => void saveSettings({ reduceMotion: v })} />
          </Row>
        </Section>

        <Section eyebrow="06 · Versión" title="Acerca de">
          <Row
            title={`InstaVault ${info?.version ?? ""}`}
            hint={`Electron ${info?.electron ?? ""} · Chromium ${info?.chrome ?? ""}. Herramienta personal y educativa: respeta los términos de Instagram y los derechos de los autores.`}
          >
            <button className="btn" onClick={() => void call("update:check")} disabled={update.state === "checking" || update.state === "downloading"}>
              {update.state === "checking" ? <Spinner size={14} /> : <CloudDownload size={15} />}
              {update.state === "available"
                ? `Hay una versión ${update.version}`
                : update.state === "none"
                  ? "Estás al día"
                  : update.state === "downloading"
                    ? `Descargando ${update.percent}%`
                    : update.state === "ready"
                      ? "Lista para instalar"
                      : "Buscar actualizaciones"}
            </button>
          </Row>
          {(update.state === "available" || update.state === "ready") && (
            <div className="flex justify-end">
              <button className="btn btn-primary" onClick={() => void call("update:install")}>
                {update.state === "ready" ? "Reiniciar e instalar" : "Descargar actualización"}
              </button>
            </div>
          )}
          {update.state === "error" && <p className="text-right text-[12px] text-safelight">{update.message}</p>}
        </Section>
      </div>
    </div>
  );
}

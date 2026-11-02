import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, ArchiveRestore, Globe, KeyRound, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { LegacyImportInfo } from "@shared/types";
import { art } from "../assets";
import { call, errorMessage } from "../lib/api";
import { fmtInt } from "../lib/format";
import { useStore } from "../store";
import { DevelopImage } from "../ui/DevelopImage";
import { Segmented, Spinner } from "../ui/primitives";

/** Progreso de la importación 1.x con los fotogramas revelándose. */
export function ImportProgress() {
  const { subscribe } = useStore();
  const [state, setState] = useState({ phase: "Preparando", done: 0, total: 1 });
  const [thumbs, setThumbs] = useState<string[]>([]);
  useEffect(
    () =>
      subscribe((event) => {
        if (event.type !== "import:progress") return;
        setState({ phase: event.phase, done: event.done, total: Math.max(1, event.total) });
        if (event.thumbUrl) setThumbs((prev) => [event.thumbUrl!, ...prev.filter((t) => t !== event.thumbUrl)].slice(0, 18));
      }),
    [subscribe],
  );
  const pct = Math.round((state.done / state.total) * 100);
  return (
    <div className="panel p-5">
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] text-paper-2">{state.phase}</span>
        <span className="mono text-[11.5px] text-paper-3">
          {fmtInt(state.done)}/{fmtInt(state.total)} · {pct}%
        </span>
      </div>
      <div className="progress mt-3">
        <i style={{ width: `${pct}%` }} />
      </div>
      {thumbs.length > 0 && (
        <div className="developing-strip mt-4">
          {thumbs.map((t) => (
            <motion.div key={t} layout initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }}>
              <DevelopImage src={t} />
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Onboarding() {
  const { settings, saveSettings, navigate, refreshProfiles } = useStore();
  const [step, setStep] = useState(0);
  const [legacy, setLegacy] = useState<LegacyImportInfo | null>(null);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState(false);

  useEffect(() => {
    void call("legacy:info").then(setLegacy).catch(() => undefined);
  }, []);

  if (!settings || settings.onboardingDone) return null;
  const hasLegacy = Boolean(legacy?.available && !legacy.done);
  const steps = hasLegacy ? ["welcome", "import", "access"] : ["welcome", "access"];
  const current = steps[step];

  const finish = async (goAccounts = false) => {
    await saveSettings({ onboardingDone: true });
    if (goAccounts) navigate({ name: "accounts" });
  };

  return (
    <motion.div className="fixed inset-0 z-[80] overflow-hidden bg-ink-0" initial={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.img
        src={art.hero}
        alt=""
        className="absolute inset-0 h-full w-full object-cover"
        initial={{ scale: 1.08, opacity: 0 }}
        animate={{ scale: 1, opacity: 0.85 }}
        transition={{ duration: 2.2, ease: [0.22, 1, 0.36, 1] }}
      />
      <div className="absolute inset-0 bg-[linear-gradient(90deg,#090807_0%,rgba(9,8,7,0.92)_38%,rgba(9,8,7,0.35)_70%,rgba(9,8,7,0.15)_100%)]" />
      <div className="app-backdrop" />
      <div className="drag absolute inset-x-0 top-0 h-11" style={{ WebkitAppRegion: "drag" } as React.CSSProperties} />

      <div className="relative flex h-full max-w-[720px] flex-col justify-center px-20">
        <div className="mb-10 flex items-center gap-3">
          <img src={art.mark} alt="" className="h-10 w-10 rounded-xl shadow-[0_0_30px_-6px_rgba(224,164,88,0.8)]" />
          <span className="display text-[26px]">
            Insta<span className="text-amber-2">Vault</span>
          </span>
          <span className="eyebrow ml-2">2.0</span>
        </div>

        <AnimatePresence mode="wait">
          <motion.div
            key={current}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
          >
            {current === "welcome" && (
              <>
                <h1 className="display text-[92px] leading-[0.92]">
                  Tu cuarto <em>oscuro</em> para Instagram.
                </h1>
                <p className="mt-6 max-w-[52ch] text-[16px] leading-relaxed text-paper-2">
                  Guarda perfiles, publicaciones, reels, stories y highlights en máxima calidad, en tu equipo y bajo tu control. Nada se
                  sube a ningún servidor.
                </p>
                <button className="btn btn-primary btn-lg mt-10" onClick={() => setStep(step + 1)}>
                  Empezar <ArrowRight size={16} />
                </button>
              </>
            )}

            {current === "import" && legacy && (
              <>
                <div className="eyebrow">Paso {step + 1} de {steps.length}</div>
                <h1 className="display mt-3 text-[64px] leading-[0.95]">
                  Trae tu archivo de la <em>versión 1</em>.
                </h1>
                <p className="mt-5 max-w-[52ch] text-[15px] leading-relaxed text-paper-2">
                  Encontramos {fmtInt(legacy.profiles)} perfiles y {fmtInt(legacy.downloaded)} archivos de InstaVault 1.x. Se copian a la
                  nueva biblioteca verificando cada archivo; el original queda intacto.
                </p>
                <div className="mt-8 max-w-[560px]">
                  {importing || imported ? (
                    <ImportProgress />
                  ) : (
                    <div className="flex gap-3">
                      <button
                        className="btn btn-primary btn-lg"
                        onClick={async () => {
                          setImporting(true);
                          try {
                            const r = await call("legacy:import");
                            setImported(true);
                            await refreshProfiles();
                            toast.success("Archivo importado", { description: `${r.profiles} perfiles · ${r.files} archivos` });
                          } catch (error) {
                            toast.error("La importación falló", { description: errorMessage(error) });
                          } finally {
                            setImporting(false);
                          }
                        }}
                      >
                        <ArchiveRestore size={16} /> Importar biblioteca
                      </button>
                      <button className="btn btn-lg btn-ghost" onClick={() => setStep(step + 1)}>
                        Ahora no
                      </button>
                    </div>
                  )}
                </div>
                {(imported || importing) && (
                  <button className="btn btn-lg mt-6" disabled={importing} onClick={() => setStep(step + 1)}>
                    {importing ? <Spinner size={14} /> : <ArrowRight size={16} />} Continuar
                  </button>
                )}
              </>
            )}

            {current === "access" && (
              <>
                <div className="eyebrow">Paso {step + 1} de {steps.length}</div>
                <h1 className="display mt-3 text-[64px] leading-[0.95]">
                  Anónimo primero, <em>tu cuenta</em> sólo si hace falta.
                </h1>
                <div className="mt-8 grid max-w-[620px] grid-cols-2 gap-4">
                  <div className="panel p-5">
                    <Globe size={20} className="text-amber-2" />
                    <div className="mt-3 text-[15px] text-paper">Modo anónimo</div>
                    <p className="mt-1.5 text-[13px] leading-relaxed text-paper-3">
                      Perfiles públicos, sus primeras publicaciones y enlaces sueltos, sin iniciar sesión y en un navegador aislado.
                    </p>
                  </div>
                  <div className="panel p-5">
                    <KeyRound size={20} className="text-amber-2" />
                    <div className="mt-3 text-[15px] text-paper">Con tu cuenta</div>
                    <p className="mt-1.5 text-[13px] leading-relaxed text-paper-3">
                      Privados que sigues, stories, highlights y perfiles completos. Cada cuenta vive en su propia sesión aislada.
                    </p>
                  </div>
                </div>
                <div className="mt-6 flex items-center gap-4">
                  <span className="text-[13px] text-paper-2">Si Instagram bloquea el modo anónimo:</span>
                  <Segmented
                    id="onb-policy"
                    value={settings.fallbackPolicy}
                    onChange={(v) => void saveSettings({ fallbackPolicy: v })}
                    options={[
                      { value: "ask", label: "Preguntarme" },
                      { value: "auto", label: "Usar mi cuenta" },
                      { value: "never", label: "Nunca" },
                    ]}
                  />
                </div>
                <div className="mt-3 flex items-center gap-2 text-[12px] text-paper-3">
                  <ShieldCheck size={13} /> Puedes cambiarlo cuando quieras en Ajustes.
                </div>
                <div className="mt-10 flex gap-3">
                  <button className="btn btn-primary btn-lg" onClick={() => void finish(false)}>
                    Abrir mi archivo <ArrowRight size={16} />
                  </button>
                  <button className="btn btn-lg" onClick={() => void finish(true)}>
                    <KeyRound size={15} /> Conectar una cuenta
                  </button>
                </div>
              </>
            )}
          </motion.div>
        </AnimatePresence>

        <div className="mt-14 flex gap-2">
          {steps.map((s, i) => (
            <span key={s} className={`h-1 rounded-full transition-all ${i === step ? "w-10 bg-amber" : "w-4 bg-white/15"}`} />
          ))}
        </div>
      </div>
    </motion.div>
  );
}

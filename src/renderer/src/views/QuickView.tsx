import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Check, ClipboardPaste, FolderOpen, Globe, KeyRound, Library, Link2, Play, Trash, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { AccessMode, QuickHistoryEntry, QuickResolution } from "@shared/types";
import { art } from "../assets";
import { call, errorMessage } from "../lib/api";
import { fmtDate, fmtRelative } from "../lib/format";
import { useStore } from "../store";
import { DevelopImage } from "../ui/DevelopImage";
import { Avatar, Segmented, Spinner } from "../ui/primitives";

const TYPE_LABEL = { post: "Publicación", story: "Story", highlight: "Highlight", profile: "Perfil" } as const;

export function QuickView({ initialUrl }: { initialUrl?: string }) {
  const { remote, navigate, defaultAccount, activity } = useStore();
  const [url, setUrl] = useState(initialUrl ?? "");
  const [access, setAccess] = useState<AccessMode>("public");
  const [resolving, setResolving] = useState(false);
  const [result, setResult] = useState<QuickResolution | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState<"library" | "device" | null>(null);
  const [history, setHistory] = useState<QuickHistoryEntry[]>([]);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const lastAuto = useRef<string | null>(null);

  const loadHistory = () => void call("quick:history").then(setHistory).catch(() => undefined);
  useEffect(loadHistory, []);

  const resolve = async (value = url) => {
    const target = value.trim();
    if (!target) return;
    const parsed = await call("ig:parseUrl", { url: target });
    if (!parsed) {
      toast.error("Ese enlace no parece de Instagram", { description: "Acepta publicaciones, reels, stories y highlights." });
      return;
    }
    if (parsed.type === "profile") {
      toast("Es un perfil", { description: `Búscalo como @${parsed.username} en tu archivo.` });
      return;
    }
    setResolving(true);
    setResult(null);
    const wantsAccount = parsed.type !== "post" || access === "account";
    const resolution = await remote((a, accountId) => call("ig:resolveUrl", { url: target, access: a, accountId }), {
      access: wantsAccount ? "account" : "public",
    });
    setResolving(false);
    if (resolution) {
      setResult(resolution);
      setPicked(new Set(resolution.items.map((i) => i.key)));
    }
  };

  useEffect(() => {
    if (initialUrl && lastAuto.current !== initialUrl) {
      lastAuto.current = initialUrl;
      setUrl(initialUrl);
      void resolve(initialUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialUrl]);

  const save = async (target: "library" | "device") => {
    if (!result) return;
    setSaving(target);
    try {
      const outcome = await call("ig:saveResolved", { token: result.token, target, keys: [...picked] });
      if (target === "library" && outcome.profileId) {
        toast.success(`${outcome.saved} ${outcome.saved === 1 ? "pieza" : "piezas"} en tu archivo`, {
          description: `Revelándose en @${result.owner?.username}.`,
          action: { label: "Ver perfil", onClick: () => navigate({ name: "profile", id: outcome.profileId! }) },
        });
      } else if (outcome.saved) {
        toast.success(`${outcome.saved} ${outcome.saved === 1 ? "archivo guardado" : "archivos guardados"}`, { description: outcome.folder ?? undefined });
      }
      loadHistory();
    } catch (error) {
      toast.error("No se pudo guardar", { description: errorMessage(error) });
    } finally {
      setSaving(null);
    }
  };

  const onPaste = (text: string) => {
    if (/instagram\.com|instagr\.am/i.test(text)) {
      setUrl(text.trim());
      window.setTimeout(() => void resolve(text), 0);
    }
  };

  return (
    <div className="view-scroll">
      <div className="mx-auto max-w-[1180px] px-10 pb-24 pt-10">
        <div className="eyebrow">Descarga rápida</div>
        <h1 className="display mt-3 text-[84px]">
          Pega un <em>enlace</em>.
        </h1>
        <p className="mt-3 max-w-[62ch] text-[15px] leading-relaxed text-paper-2">
          Publicaciones, reels y carruseles se resuelven en modo anónimo, como en los sitios web. Stories y highlights necesitan tu
          cuenta conectada. Todo lo guardado entra en tu archivo o va directo a una carpeta.
        </p>

        <div
          className="dropzone mt-9 p-7"
          data-over={over}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            onPaste(e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain"));
          }}
        >
          {(["left-4 top-4 border-l-2 border-t-2 rounded-tl-lg", "right-4 top-4 border-r-2 border-t-2 rounded-tr-lg", "bottom-4 left-4 border-b-2 border-l-2 rounded-bl-lg", "bottom-4 right-4 border-b-2 border-r-2 rounded-br-lg"] as const).map((c) => (
            <span key={c} className={`frame-corner ${c}`} />
          ))}
          <div className="flex items-center gap-3">
            <div className="field h-[58px] flex-1 rounded-[16px] px-5">
              <Link2 size={19} className="text-amber-2" />
              <input
                ref={input}
                autoFocus
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onPaste={(e) => onPaste(e.clipboardData.getData("text"))}
                onKeyDown={(e) => e.key === "Enter" && void resolve()}
                placeholder="https://www.instagram.com/p/…  ·  /reel/…  ·  /stories/…"
                className="text-[16px]"
                spellCheck={false}
              />
              {url && (
                <button className="icon-btn h-7 w-7" onClick={() => (setUrl(""), setResult(null))} aria-label="Limpiar">
                  <X size={14} />
                </button>
              )}
            </div>
            <button className="btn btn-primary btn-lg h-[58px] px-6" onClick={() => void resolve()} disabled={!url.trim() || resolving || Boolean(activity)}>
              {resolving ? <Spinner size={16} /> : <ArrowRight size={17} />} Resolver
            </button>
          </div>
          <div className="mt-4 flex items-center gap-4">
            <Segmented
              id="quick-access"
              value={access}
              onChange={setAccess}
              options={[
                {
                  value: "public",
                  label: (
                    <span className="flex items-center gap-1.5">
                      <Globe size={13} /> Anónimo
                    </span>
                  ),
                },
                {
                  value: "account",
                  label: (
                    <span className="flex items-center gap-1.5">
                      <KeyRound size={13} /> {defaultAccount ? `@${defaultAccount.username}` : "Con cuenta"}
                    </span>
                  ),
                },
              ]}
            />
            <span className="flex items-center gap-2 text-[12.5px] text-paper-3">
              <ClipboardPaste size={14} /> También puedes arrastrar el enlace aquí o pegarlo con Ctrl+V.
            </span>
          </div>
        </div>

        <AnimatePresence mode="wait">
          {resolving && (
            <motion.div key="resolving" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="mt-10 grid grid-cols-4 gap-3">
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="skeleton aspect-[4/5] rounded-2xl" />
              ))}
            </motion.div>
          )}
          {result && !resolving && (
            <motion.section key={result.token} initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="panel mt-10 p-6">
              <div className="flex items-start gap-4">
                {result.owner && <Avatar src={result.owner.avatarUrl} name={result.owner.username} size={48} ring />}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="tag tag-amber">{TYPE_LABEL[result.parsed.type]}</span>
                    <span className="tag">{result.access === "public" ? "Anónimo" : "Con cuenta"}</span>
                    <span className="mono text-[11px] text-paper-4">{fmtDate(result.takenAt)}</span>
                  </div>
                  <div className="display mt-2 text-[32px]">{result.owner ? `@${result.owner.username}` : "Autor desconocido"}</div>
                  {result.caption && <p className="line-clamp-2 mt-1 max-w-[80ch] text-[13.5px] text-paper-2" data-selectable>{result.caption}</p>}
                </div>
                <div className="flex flex-col items-end gap-2">
                  <button className="btn btn-primary" onClick={() => void save("library")} disabled={!picked.size || Boolean(saving) || !result.owner}>
                    {saving === "library" ? <Spinner size={14} /> : <Library size={15} />} Guardar en el archivo
                  </button>
                  <button className="btn" onClick={() => void save("device")} disabled={!picked.size || Boolean(saving)}>
                    {saving === "device" ? <Spinner size={14} /> : <FolderOpen size={15} />} Guardar en una carpeta
                  </button>
                </div>
              </div>
              <div className="mt-6 grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3">
                {result.items.map((item) => {
                  const on = picked.has(item.key);
                  return (
                    <button
                      key={item.key}
                      className="cell aspect-[4/5]"
                      data-selected={on}
                      onClick={() =>
                        setPicked((prev) => {
                          const next = new Set(prev);
                          if (next.has(item.key)) next.delete(item.key);
                          else next.add(item.key);
                          return next;
                        })
                      }
                    >
                      {item.previewUrl ? <DevelopImage src={item.previewUrl} /> : <div className="h-full w-full bg-ink-3" />}
                      <span className="cell-check" style={{ opacity: 1 }}>
                        {on && <Check size={14} strokeWidth={3} />}
                      </span>
                      <div className="cell-badges">
                        {item.mediaType === 2 && (
                          <span className="cell-badge">
                            <Play size={10} className="fill-white" /> video
                          </span>
                        )}
                        {item.width && item.height ? (
                          <span className="cell-badge">
                            {item.width}×{item.height}
                          </span>
                        ) : null}
                      </div>
                    </button>
                  );
                })}
              </div>
            </motion.section>
          )}
        </AnimatePresence>

        {!result && !resolving && history.length === 0 && (
          <div className="mt-14 grid grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] items-center gap-10">
            <div className="illustration aspect-[16/10]">
              <img src={art.hero} alt="" />
            </div>
            <ol className="space-y-5">
              {[
                ["Copia el enlace", "Desde Instagram: ··· › Copiar enlace. Sirven publicaciones, reels, carruseles, stories y highlights."],
                ["Pégalo arriba", "Se resuelve al instante en modo anónimo. Si Instagram exige sesión, te preguntamos antes de usar tu cuenta."],
                ["Elige y guarda", "Escoge las piezas y guárdalas en tu archivo (con su autor) o directamente en una carpeta."],
              ].map(([title, body], i) => (
                <li key={title} className="flex gap-4">
                  <span className="numeral w-8 flex-none text-[34px] leading-none text-amber-2">{i + 1}</span>
                  <div>
                    <div className="text-[15px] text-paper">{title}</div>
                    <div className="mt-1 text-[13.5px] leading-relaxed text-paper-3">{body}</div>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        )}

        {history.length > 0 && (
          <section className="mt-14">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="display text-[30px]">Recientes</h2>
              <button
                className="btn btn-sm btn-ghost"
                onClick={async () => {
                  await call("quick:clearHistory");
                  loadHistory();
                }}
              >
                <Trash size={13} /> Vaciar historial
              </button>
            </div>
            <div className="panel divide-y divide-line overflow-hidden">
              {history.map((h) => (
                <button key={h.id} className="flex w-full items-center gap-4 px-4 py-3 text-left transition hover:bg-ink-3/60" onClick={() => (setUrl(h.url), void resolve(h.url))}>
                  <div className="h-12 w-10 flex-none overflow-hidden rounded-md bg-ink-4">{h.thumbUrl && <DevelopImage src={h.thumbUrl} className="h-full w-full object-cover" />}</div>
                  <div className="min-w-0 flex-1">
                    <div className="mono truncate text-[12.5px] text-paper-2">{h.url}</div>
                    <div className="text-[12px] text-paper-4">
                      {h.ownerUsername ? `@${h.ownerUsername} · ` : ""}
                      {h.itemCount} {h.itemCount === 1 ? "pieza" : "piezas"} · {h.savedToLibrary ? "en el archivo" : "en carpeta"} · {fmtRelative(h.createdAt)}
                    </div>
                  </div>
                  <ArrowRight size={15} className="text-paper-4" />
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

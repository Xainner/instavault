import { AnimatePresence, motion, useMotionValue } from "motion/react";
import {
  ChevronLeft,
  ChevronRight,
  CloudDownload,
  Copy,
  ExternalLink,
  FolderOpen,
  Info,
  Maximize2,
  Pause,
  Play,
  Projector,
  Repeat,
  RotateCcw,
  Save,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type WheelEvent } from "react";
import { toast } from "sonner";
import type { Media, Profile } from "@shared/types";
import { instagramPostUrl } from "@shared/urls";
import { call, errorMessage } from "../lib/api";
import { fmtBytes, fmtDateTime, fmtDuration } from "../lib/format";
import { DevelopImage } from "../ui/DevelopImage";
import { Avatar, Spinner } from "../ui/primitives";
import { previewOf, type Pub } from "./profile/model";

interface Props {
  profile: Profile;
  pubs: Pub[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
  onDownload: (mediaIds: number[], force: boolean) => void;
}

function copyText(text: string) {
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}

function RichCaption({ text }: { text: string }) {
  const parts = text.split(/([#@][\p{L}\p{N}_.]+)/gu);
  return (
    <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-paper-2" data-selectable>
      {parts.map((part, i) => (/^[#@]/.test(part) ? <span key={i} className="text-amber-2">{part}</span> : <Fragment key={i}>{part}</Fragment>))}
    </p>
  );
}

export function Viewer({ profile, pubs, index, onIndex, onClose, onDownload }: Props) {
  const pub = pubs[index];
  const [child, setChild] = useState(0);
  const [info, setInfo] = useState(true);
  const [slideshow, setSlideshow] = useState(false);
  const [scale, setScale] = useState(1);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const item: Media = pub.items[Math.min(child, pub.items.length - 1)];
  const preview = previewOf(item);
  const ambient = preview.video ? null : preview.src;

  useEffect(() => {
    setChild(0);
  }, [index]);
  useEffect(() => {
    setScale(1);
    x.set(0);
    y.set(0);
  }, [index, child, x, y]);

  const go = useCallback((delta: number) => onIndex(Math.max(0, Math.min(pubs.length - 1, index + delta))), [index, onIndex, pubs.length]);
  const goChild = useCallback((delta: number) => setChild((c) => Math.max(0, Math.min(pub.items.length - 1, c + delta))), [pub.items.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onClose();
      if (e.key === "ArrowRight") return go(1);
      if (e.key === "ArrowLeft") return go(-1);
      if (e.key === "ArrowDown") return goChild(1);
      if (e.key === "ArrowUp") return goChild(-1);
      const k = e.key.toLowerCase();
      if (k === "i") setInfo((v) => !v);
      if (k === "p") setSlideshow((v) => !v);
      if (k === "z") setScale((s) => (s > 1 ? 1 : 2));
      if (k === "f") void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
      if (e.key === " ") {
        e.preventDefault();
        const v = videoRef.current;
        if (v) void (v.paused ? v.play() : v.pause());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, goChild, onClose]);

  // Modo proyección: avanza por piezas y publicaciones.
  useEffect(() => {
    if (!slideshow) return;
    const timer = window.setTimeout(() => {
      if (child < pub.items.length - 1) setChild(child + 1);
      else if (index < pubs.length - 1) go(1);
      else setSlideshow(false);
    }, item.mediaType === 2 ? 9000 : 4200);
    return () => clearTimeout(timer);
  }, [slideshow, child, index, pub.items.length, pubs.length, go, item.mediaType]);

  const onWheel = (e: WheelEvent) => {
    if (item.mediaType === 2 || !item.contentUrl) return;
    setScale((s) => {
      const next = Math.max(1, Math.min(4, s * (e.deltaY < 0 ? 1.12 : 0.89)));
      if (next === 1) {
        x.set(0);
        y.set(0);
      }
      return next;
    });
  };

  const strip = useMemo(() => {
    const from = Math.max(0, index - 10);
    return pubs.slice(from, from + 21).map((p, i) => ({ pub: p, i: from + i }));
  }, [pubs, index]);

  const save = async () => {
    try {
      const result = await call("export:media", { mediaIds: [item.id] });
      if (result.exported) toast.success("Guardada en tu equipo", { description: result.folder ?? undefined });
    } catch (error) {
      toast.error("No se pudo guardar", { description: errorMessage(error) });
    }
  };

  return (
    <motion.div className="viewer" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
      {ambient && <div className="viewer-ambient" style={{ backgroundImage: `url("${ambient}")` }} />}

      {/* barra superior */}
      <div className="flex items-center gap-3 px-5" style={{ paddingRight: "calc(var(--controls-w) + 12px)" }}>
        <button className="icon-btn" onClick={onClose} aria-label="Cerrar (Esc)">
          <X size={19} />
        </button>
        <Avatar src={profile.avatarUrl} name={profile.username} size={30} />
        <div className="min-w-0">
          <div className="truncate text-[13.5px] text-paper">@{profile.username}</div>
          <div className="mono text-[10.5px] text-paper-3">{fmtDateTime(pub.takenAt)}</div>
        </div>
        <div className="mono ml-3 rounded-lg bg-white/5 px-2.5 py-1 text-[11px] text-paper-2">
          {index + 1} / {pubs.length}
          {pub.items.length > 1 ? ` · ${child + 1}/${pub.items.length}` : ""}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <ToolButton active={slideshow} onClick={() => setSlideshow((v) => !v)} title="Proyección (P)">
            <Projector size={17} />
          </ToolButton>
          <ToolButton onClick={() => void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen())} title="Pantalla completa (F)">
            <Maximize2 size={16} />
          </ToolButton>
          <ToolButton active={info} onClick={() => setInfo((v) => !v)} title="Información (I)">
            <Info size={17} />
          </ToolButton>
          {item.status === "downloaded" ? (
            <button className="btn btn-sm btn-primary ml-2" onClick={() => void save()}>
              <Save size={14} /> Guardar en el equipo
            </button>
          ) : (
            <button className="btn btn-sm btn-primary ml-2" onClick={() => onDownload(pub.items.map((m) => m.id), false)} disabled={item.status === "downloading"}>
              {item.status === "downloading" ? <Spinner size={13} /> : <CloudDownload size={14} />} Revelar ahora
            </button>
          )}
        </div>
      </div>

      {/* escenario */}
      <div className="grid min-h-0" style={{ gridTemplateColumns: info ? "1fr 360px" : "1fr" }}>
        <div className="viewer-stage px-20 py-4" onWheel={onWheel}>
          <AnimatePresence mode="wait">
            <motion.div
              key={`${pub.key}-${child}`}
              initial={{ opacity: 0, scale: 0.985 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.99 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="relative grid h-full w-full place-items-center"
            >
              {item.status === "downloaded" && item.contentUrl ? (
                item.mediaType === 2 ? (
                  <VideoPlayer key={item.id} src={item.contentUrl} poster={item.thumbUrl} videoRef={videoRef} />
                ) : (
                  <motion.img
                    src={item.contentUrl}
                    alt=""
                    draggable={false}
                    className="viewer-media"
                    style={{ x, y, scale, cursor: scale > 1 ? "grab" : "zoom-in" }}
                    drag={scale > 1}
                    dragMomentum={false}
                    onDoubleClick={() => setScale((s) => (s > 1 ? 1 : 2.2))}
                  />
                )
              ) : (
                <div className="relative">
                  {preview.src ? (
                    <img src={preview.src} alt="" className="viewer-media max-h-[70vh] opacity-60 grayscale-[0.4]" />
                  ) : (
                    <div className="grid h-[60vh] w-[48vh] place-items-center rounded-xl bg-ink-3 text-paper-4">Sin vista previa</div>
                  )}
                  <div className="absolute inset-0 grid place-items-center">
                    <div className="panel max-w-[360px] p-5 text-center">
                      <div className="eyebrow">{item.status === "failed" ? "Error al revelar" : "Aún sin revelar"}</div>
                      <p className="mt-2 text-[13px] text-paper-2">
                        {item.status === "failed" ? (item.error ?? "La descarga falló.") : "Esta es una miniatura. Revélala para guardar la versión en máxima calidad."}
                      </p>
                      <button className="btn btn-primary mt-4" onClick={() => onDownload(pub.items.map((m) => m.id), false)} disabled={item.status === "downloading"}>
                        {item.status === "downloading" ? <Spinner size={14} /> : <CloudDownload size={15} />}
                        {item.status === "failed" ? "Reintentar" : "Revelar ahora"}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </motion.div>
          </AnimatePresence>

          {index > 0 && (
            <button className="viewer-nav left-5" onClick={() => go(-1)} aria-label="Anterior">
              <ChevronLeft size={22} />
            </button>
          )}
          {index < pubs.length - 1 && (
            <button className="viewer-nav right-5" onClick={() => go(1)} aria-label="Siguiente">
              <ChevronRight size={22} />
            </button>
          )}

          {pub.items.length > 1 && (
            <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 gap-1.5 rounded-full bg-black/45 px-3 py-2 backdrop-blur">
              {pub.items.map((m, i) => (
                <button
                  key={m.id}
                  onClick={() => setChild(i)}
                  aria-label={`Pieza ${i + 1}`}
                  className={`h-1.5 rounded-full transition-all ${i === child ? "w-5 bg-amber" : "w-1.5 bg-white/40 hover:bg-white/70"}`}
                />
              ))}
            </div>
          )}
        </div>

        <AnimatePresence>
          {info && (
            <motion.aside
              initial={{ x: 40, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 40, opacity: 0 }}
              transition={{ duration: 0.22 }}
              className="m-3 ml-0 flex min-h-0 flex-col overflow-hidden rounded-[22px] bg-ink-2/80 shadow-[inset_0_0_0_1px_rgba(240,220,195,0.08)] backdrop-blur-xl"
            >
              <div className="min-h-0 flex-1 overflow-y-auto p-5">
                <div className="eyebrow">{item.kind === "post" ? (pub.items.length > 1 ? "Carrusel" : item.mediaType === 2 ? "Video" : "Foto") : item.kind === "story" ? "Story" : "Highlight"}</div>
                <div className="display mt-1 text-[30px]">{fmtDateTime(pub.takenAt)}</div>
                {item.caption ? <div className="mt-4"><RichCaption text={item.caption} /></div> : <p className="mt-4 text-[13px] italic text-paper-4">Sin descripción.</p>}

                <div className="divider my-5" />
                <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2.5 text-[12.5px]">
                  <Meta label="Dimensiones">{item.width && item.height ? `${item.width} × ${item.height}` : "—"}</Meta>
                  {item.mediaType === 2 && <Meta label="Duración">{fmtDuration(item.duration)}</Meta>}
                  {item.bitrate ? <Meta label="Bitrate">{`${Math.round(item.bitrate / 1000)} kbps`}</Meta> : null}
                  <Meta label="Tamaño">{item.bytes ? fmtBytes(item.bytes) : "—"}</Meta>
                  <Meta label="Calidad">
                    {item.qualityVerified ? <span className="tag tag-sage h-[20px]">Máxima verificada</span> : <span className="tag h-[20px]">Sin verificar</span>}
                  </Meta>
                  <Meta label="Fuente">{sourceLabel(item.source)}</Meta>
                  <Meta label="Estado">{statusLabel(item.status)}</Meta>
                  {item.sha256 && (
                    <Meta label="SHA-256">
                      <span className="mono text-[11px] text-paper-3" title={item.sha256}>
                        {item.sha256.slice(0, 12)}…{item.sha256.slice(-6)}
                      </span>
                    </Meta>
                  )}
                  {item.downloadedAt && <Meta label="Revelada">{fmtDateTime(item.downloadedAt)}</Meta>}
                </dl>
              </div>
              <div className="grid grid-cols-2 gap-2 border-t border-line p-3">
                <button className="btn btn-sm" onClick={() => onDownload([item.id], true)}>
                  <RotateCcw size={13} /> Re-descargar
                </button>
                <button className="btn btn-sm" onClick={() => void call("export:reveal", { mediaId: item.id })} disabled={item.status !== "downloaded"}>
                  <FolderOpen size={13} /> En carpeta
                </button>
                {item.publicationCode && item.kind === "post" && (
                  <>
                    <button className="btn btn-sm" onClick={() => void call("app:openExternal", { url: instagramPostUrl(item.publicationCode!) })}>
                      <ExternalLink size={13} /> Instagram
                    </button>
                    <button
                      className="btn btn-sm"
                      onClick={() => {
                        copyText(instagramPostUrl(item.publicationCode!));
                        toast("Enlace copiado");
                      }}
                    >
                      <Copy size={13} /> Copiar enlace
                    </button>
                  </>
                )}
              </div>
            </motion.aside>
          )}
        </AnimatePresence>
      </div>

      {/* filmstrip */}
      <div className="filmstrip">
        {strip.map(({ pub: p, i }) => {
          const src = previewOf(p.cover);
          return (
            <button key={p.key} data-active={i === index} onClick={() => onIndex(i)} aria-label={`Ir a ${i + 1}`}>
              {src.src && !src.video ? <DevelopImage src={src.src} /> : <div className="h-full w-full bg-ink-4" />}
            </button>
          );
        })}
      </div>
    </motion.div>
  );
}

function ToolButton({ children, onClick, active, title }: { children: ReactNode; onClick: () => void; active?: boolean; title: string }) {
  return (
    <button className="icon-btn" data-active={active} onClick={onClick} title={title} aria-label={title}>
      {children}
    </button>
  );
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-paper-4">{label}</dt>
      <dd className="text-paper-2">{children}</dd>
    </>
  );
}

const sourceLabel = (s: string | null) =>
  ({ web_api: "API web de Instagram", web_response: "Respuesta de la página", dom_fallback: "Cuadrícula (respaldo)", embed: "Embed público", legacy: "InstaVault 1.x" })[s ?? ""] ?? "—";
const statusLabel = (s: Media["status"]) => ({ downloaded: "Revelada", pending: "Pendiente", downloading: "Revelando…", failed: "Con error" })[s];

function VideoPlayer({ src, poster, videoRef }: { src: string; poster: string | null; videoRef: React.MutableRefObject<HTMLVideoElement | null> }) {
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const [loop, setLoop] = useState(true);
  const [rate, setRate] = useState(1);
  const pct = duration ? (time / duration) * 100 : 0;
  return (
    <div className="relative grid h-full w-full place-items-center">
      <video
        ref={videoRef}
        src={src}
        poster={poster ?? undefined}
        autoPlay
        loop={loop}
        muted={muted}
        playsInline
        className="viewer-media max-h-full max-w-full"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onClick={(e) => void (e.currentTarget.paused ? e.currentTarget.play() : e.currentTarget.pause())}
      />
      <div className="video-controls">
        <button className="icon-btn h-8 w-8" onClick={() => videoRef.current && void (videoRef.current.paused ? videoRef.current.play() : videoRef.current.pause())}>
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <span className="mono w-10 text-right text-[11px] text-paper-2">{fmtDuration(time)}</span>
        <input
          type="range"
          className="range"
          min={0}
          max={duration || 0}
          step={0.05}
          value={time}
          style={{ ["--p" as string]: `${pct}%` }}
          onChange={(e) => {
            if (videoRef.current) videoRef.current.currentTime = Number(e.target.value);
          }}
        />
        <span className="mono w-10 text-[11px] text-paper-3">{fmtDuration(duration)}</span>
        <button className="icon-btn h-8 w-8" data-active={loop} onClick={() => setLoop((v) => !v)} title="Bucle">
          <Repeat size={14} />
        </button>
        <button
          className="mono h-8 rounded-lg px-2 text-[11px] text-paper-2 hover:bg-white/5"
          onClick={() => {
            const next = rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1;
            setRate(next);
            if (videoRef.current) videoRef.current.playbackRate = next;
          }}
        >
          {rate}×
        </button>
        <button className="icon-btn h-8 w-8" onClick={() => setMuted((m) => !m)} title={muted ? "Activar sonido" : "Silenciar"}>
          {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
        </button>
      </div>
    </div>
  );
}

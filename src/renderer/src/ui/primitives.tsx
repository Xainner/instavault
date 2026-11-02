import { useEffect, useRef, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, animate, motion, useMotionValue, useTransform } from "motion/react";
import { X } from "lucide-react";
import { DevelopImage } from "./DevelopImage";

export function Avatar({ src, name, size = 40, ring = false }: { src: string | null; name: string; size?: number; ring?: boolean }) {
  const inner = (
    <div className="avatar" style={{ width: size, height: size }}>
      {src ? (
        <DevelopImage src={src} alt="" />
      ) : (
        <div className="grid h-full w-full place-items-center display text-paper-2" style={{ fontSize: size * 0.46 }}>
          {name.slice(0, 1).toUpperCase()}
        </div>
      )}
    </div>
  );
  return ring ? <div className="avatar-ring">{inner}</div> : inner;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  width = 520,
  dismissable = true,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  width?: number;
  dismissable?: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && dismissable && onClose()}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div className="modal-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
            </Dialog.Overlay>
            <Dialog.Content
              asChild
              forceMount
              onEscapeKeyDown={(e) => !dismissable && e.preventDefault()}
              onPointerDownOutside={(e) => !dismissable && e.preventDefault()}
            >
              <motion.div
                className="modal panel p-6"
                style={{ width: `min(${width}px, calc(100vw - 32px))` }}
                initial={{ opacity: 0, y: 14, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.98 }}
                transition={{ type: "spring", stiffness: 380, damping: 32 }}
              >
                <div className="mb-4 flex items-start gap-4">
                  <div className="min-w-0 flex-1">
                    <Dialog.Title className="display text-[30px] text-paper">{title}</Dialog.Title>
                    {description ? <Dialog.Description className="mt-2 text-[13.5px] leading-relaxed text-paper-2">{description}</Dialog.Description> : null}
                  </div>
                  {dismissable && (
                    <Dialog.Close className="icon-btn -mr-2 -mt-1" aria-label="Cerrar">
                      <X size={18} />
                    </Dialog.Close>
                  )}
                </div>
                {children}
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}

/** Menú desplegable que se cierra con clic fuera o Escape. */
export function Menu({
  trigger,
  children,
  align = "right",
  width = 240,
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative inline-flex">
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      <AnimatePresence>
        {open && (
          <motion.div
            className="menu"
            style={{ top: "calc(100% + 6px)", [align]: 0, width }}
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.14 }}
          >
            {children(() => setOpen(false))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function MenuItem({ icon, children, hint, danger, onClick }: { icon?: ReactNode; children: ReactNode; hint?: ReactNode; danger?: boolean; onClick: () => void }) {
  return (
    <button className="menu-item" data-danger={danger} onClick={onClick}>
      {icon}
      <span className="truncate">{children}</span>
      {hint ? <span className="hint">{hint}</span> : null}
    </button>
  );
}

export function Segmented<T extends string>({ value, onChange, options, id }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: ReactNode }>; id: string }) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button key={o.value} data-active={o.value === value} onClick={() => onChange(o.value)}>
          {o.value === value && <motion.span layoutId={`seg-${id}`} className="seg-pill" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return <button role="switch" aria-checked={on} aria-label={label} className="switch" data-on={on} onClick={() => onChange(!on)} />;
}

/** Número que cuenta hasta su valor (para cabeceras). */
export function Counter({ value, format = (n: number) => Math.round(n).toLocaleString("es") }: { value: number; format?: (n: number) => string }) {
  const mv = useMotionValue(0);
  const text = useTransform(mv, (v) => format(v));
  const [display, setDisplay] = useState(format(0));
  useEffect(() => {
    const controls = animate(mv, value, { duration: 1.1, ease: [0.22, 1, 0.36, 1] });
    return () => controls.stop();
  }, [mv, value]);
  useEffect(() => text.on("change", setDisplay), [text]);
  return <span className="numeral">{display}</span>;
}

export function EmptyState({
  art,
  eyebrow,
  title,
  children,
  actions,
  compact = false,
}: {
  art: string;
  eyebrow?: string;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  compact?: boolean;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      className={`mx-auto grid items-center gap-10 ${compact ? "max-w-[860px] grid-cols-[300px_1fr] py-10" : "max-w-[1040px] grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] py-14"}`}
    >
      <div className="illustration aspect-[4/3]">
        <img src={art} alt="" />
      </div>
      <div>
        {eyebrow && <div className="eyebrow mb-3">{eyebrow}</div>}
        <h2 className={`display text-paper ${compact ? "text-[34px]" : "text-[48px]"}`}>{title}</h2>
        {children && <div className="mt-4 max-w-[46ch] text-[14.5px] leading-relaxed text-paper-2">{children}</div>}
        {actions && <div className="mt-7 flex flex-wrap gap-3">{actions}</div>}
      </div>
    </motion.div>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg className="spin" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

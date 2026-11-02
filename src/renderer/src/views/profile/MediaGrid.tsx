import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, CircleAlert, Clock, Film, Images, Play } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type RefObject } from "react";
import { fmtDate, fmtDuration, fmtMonth } from "../../lib/format";
import { DevelopImage } from "../../ui/DevelopImage";
import { Spinner } from "../../ui/primitives";
import { previewOf, type Pub } from "./model";

const GAP = 10;

interface Props {
  pubs: Pub[];
  scrollRef: RefObject<HTMLDivElement | null>;
  cellMin: number;
  ratio: number;
  selected: Set<string>;
  onToggle: (index: number, event: MouseEvent) => void;
  onOpen: (index: number) => void;
  showScrubber: boolean;
}

export function MediaGrid({ pubs, scrollRef, cellMin, ratio, selected, onToggle, onOpen, showScrubber }: Props) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1000);
  const [offset, setOffset] = useState(0);

  useLayoutEffect(() => {
    const el = gridRef.current;
    const scroller = scrollRef.current;
    if (!el || !scroller) return;
    // La grilla vive dentro del contenedor con scroll: el margen se mide respecto a él.
    const measure = () => {
      setWidth(el.clientWidth);
      setOffset(Math.round(el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    for (const child of Array.from(scroller.children)) observer.observe(child);
    if (el.parentElement?.parentElement) observer.observe(el.parentElement.parentElement);
    return () => observer.disconnect();
  }, [scrollRef]);

  const columns = Math.max(2, Math.floor((width + GAP) / (cellMin + GAP)));
  const cellWidth = (width - GAP * (columns - 1)) / columns;
  const rowHeight = Math.round(cellWidth * ratio) + GAP;
  const rows = Math.ceil(pubs.length / columns);

  const virtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 4,
    scrollMargin: offset,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [rowHeight, virtualizer]);

  // Escalador temporal: primer índice de cada mes.
  const marks = useMemo(() => {
    if (!showScrubber) return [];
    const out: Array<{ label: string; index: number; year: boolean }> = [];
    let lastMonth = "";
    let lastYear = "";
    pubs.forEach((p, index) => {
      if (!p.takenAt) return;
      const d = new Date(p.takenAt * 1000);
      const year = String(d.getFullYear());
      const month = `${year}-${d.getMonth()}`;
      if (year !== lastYear) {
        out.push({ label: year, index, year: true });
        lastYear = year;
        lastMonth = month;
      } else if (month !== lastMonth) {
        out.push({ label: fmtMonth(p.takenAt), index, year: false });
        lastMonth = month;
      }
    });
    return out.length > 36 ? out.filter((m) => m.year) : out;
  }, [pubs, showScrubber]);

  const items = virtualizer.getVirtualItems();
  const firstVisible = (items[0]?.index ?? 0) * columns;
  const activeMark = marks.reduce((acc, m, i) => (m.index <= firstVisible + columns ? i : acc), 0);

  return (
    <div className="relative">
      <div ref={gridRef} className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {items.map((row) => (
          <div
            key={row.key}
            className="absolute left-0 right-0 grid"
            style={{
              transform: `translateY(${row.start - virtualizer.options.scrollMargin}px)`,
              gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
              gap: GAP,
              height: rowHeight - GAP,
            }}
          >
            {Array.from({ length: columns }, (_, col) => {
              const index = row.index * columns + col;
              const pub = pubs[index];
              if (!pub) return <div key={col} />;
              return (
                <Cell
                  key={pub.key}
                  pub={pub}
                  selected={selected.has(pub.key)}
                  onToggle={(e) => onToggle(index, e)}
                  onOpen={() => onOpen(index)}
                  selectMode={selected.size > 0}
                />
              );
            })}
          </div>
        ))}
      </div>
      {marks.length > 3 && (virtualizer.scrollOffset ?? 0) > offset - 160 && (
        <div className="scrubber" style={{ position: "fixed", top: "calc(var(--titlebar-h) + 120px)", bottom: 36, right: 14 }}>
          {marks.map((m, i) => (
            <button
              key={`${m.label}-${m.index}`}
              data-year={m.year}
              data-active={i === activeMark}
              onClick={() => virtualizer.scrollToIndex(Math.floor(m.index / columns), { align: "start" })}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const Cell = memo(function Cell({
  pub,
  selected,
  selectMode,
  onToggle,
  onOpen,
}: {
  pub: Pub;
  selected: boolean;
  selectMode: boolean;
  onToggle: (e: MouseEvent) => void;
  onOpen: () => void;
}) {
  const preview = previewOf(pub.cover);
  const video = pub.items.some((m) => m.mediaType === 2);
  const duration = pub.items.find((m) => m.duration)?.duration ?? null;
  return (
    <div
      className={`cell ${selectMode ? "select-mode" : ""}`}
      data-selected={selected}
      data-status={pub.status}
      onClick={(e) => (selectMode || e.shiftKey || e.ctrlKey || e.metaKey ? onToggle(e) : onOpen())}
      onContextMenu={(e) => {
        e.preventDefault();
        onToggle(e);
      }}
    >
      {preview.src ? (
        preview.video ? (
          <video src={preview.src} muted preload="metadata" playsInline />
        ) : (
          <DevelopImage src={preview.src} />
        )
      ) : (
        <div className="grid h-full w-full place-items-center bg-[repeating-linear-gradient(135deg,#14110f_0_8px,#181412_8px_16px)] text-paper-4">
          <Film size={22} />
        </div>
      )}

      <button
        className="cell-check"
        onClick={(e) => {
          e.stopPropagation();
          onToggle(e);
        }}
        aria-label={selected ? "Quitar de la selección" : "Seleccionar"}
      >
        {selected && <Check size={14} strokeWidth={3} />}
      </button>

      <div className="cell-badges">
        {pub.isCarousel && (
          <span className="cell-badge">
            <Images size={11} /> {pub.items.length}
          </span>
        )}
        {video && (
          <span className="cell-badge">
            <Play size={10} className="fill-white" /> {duration ? fmtDuration(duration) : ""}
          </span>
        )}
      </div>

      {pub.status !== "downloaded" && (
        <div className="cell-state">
          <span className="cell-ring" title={pub.status === "failed" ? (pub.cover.error ?? "Falló la descarga") : "Pendiente de revelar"}>
            {pub.status === "downloading" ? (
              <Spinner size={15} />
            ) : pub.status === "failed" ? (
              <CircleAlert size={16} className="text-[#ff9f90]" />
            ) : (
              <Clock size={15} className="text-paper-2" />
            )}
          </span>
        </div>
      )}

      <div className="cell-meta">
        <div className="mono text-[10.5px] text-amber-2">{fmtDate(pub.takenAt)}</div>
        {pub.cover.caption && <div className="line-clamp-2 mt-0.5 leading-snug">{pub.cover.caption}</div>}
      </div>
    </div>
  );
});

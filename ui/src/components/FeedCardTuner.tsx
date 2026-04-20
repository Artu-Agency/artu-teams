import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, GripVertical, Palette, RotateCcw, X } from "lucide-react";
import { cn } from "../lib/utils";

/** Temporary dev panel for tuning feed-card styling (FeedCard.tsx).
 *  Writes overrides into a <style> tag targeting [data-fc="..."] so
 *  defaults from Tailwind classes stay intact when a setting is at its
 *  baseline. Settings persist to localStorage; an Export button emits a
 *  JSON config that can be handed back for a permanent implementation. */

type TunerSettings = {
  cardPaddingY: number;
  cardPaddingX: number;
  cardGapY: number;
  cardRadius: number;
  cardBorderWidth: number;
  cardFontSize: number;
  actorWeight: number;
  actorColor: string;
  verbColor: string;
  identifierColor: string;
  titleColor: string;
  timestampColor: string;
  actorColorHover: string;
  verbColorHover: string;
  identifierColorHover: string;
  titleColorHover: string;
  timestampColorHover: string;
  iconSize: number;
};

const DEFAULTS: TunerSettings = {
  cardPaddingY: 8,
  cardPaddingX: 12,
  cardGapY: 4,
  cardRadius: 8,
  cardBorderWidth: 1,
  cardFontSize: 12,
  actorWeight: 500,
  actorColor: "",
  verbColor: "",
  identifierColor: "",
  titleColor: "",
  timestampColor: "",
  actorColorHover: "",
  verbColorHover: "",
  identifierColorHover: "",
  titleColorHover: "",
  timestampColorHover: "",
  iconSize: 16,
};

const STORAGE_KEY = "paperclip.feedCardTuner";
const STYLE_ID = "feed-card-tuner-style";

/** Preset snapshots. "Current" matches what's baked into FeedCard.tsx /
 *  ActivityFeed.tsx today — useful as a one-click return after exploring. */
const PRESETS: Array<{ name: string; settings: TunerSettings }> = [
  { name: "Original", settings: DEFAULTS },
  {
    name: "Current",
    settings: {
      ...DEFAULTS,
      cardPaddingY: 18,
      cardPaddingX: 18,
      cardGapY: 8,
      actorColor: "#959596",
      verbColor: "#959596",
      identifierColor: "#959596",
      titleColor: "#959596",
      actorColorHover: "#ffffff",
      identifierColorHover: "#ffffff",
      titleColorHover: "#ffffff",
    },
  },
  {
    name: "Compact",
    settings: {
      ...DEFAULTS,
      cardPaddingY: 6,
      cardPaddingX: 10,
      cardGapY: 2,
      cardRadius: 6,
      cardFontSize: 11,
      iconSize: 14,
    },
  },
  {
    name: "Roomy",
    settings: {
      ...DEFAULTS,
      cardPaddingY: 14,
      cardPaddingX: 16,
      cardGapY: 10,
      cardRadius: 12,
      cardFontSize: 13,
      iconSize: 18,
    },
  },
];

function loadSettings(): TunerSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return DEFAULTS;
  }
}

function buildCss(s: TunerSettings): string {
  const lines: string[] = [];
  // Card dimensions — always emit so live feedback is immediate even when
  // values equal the Tailwind defaults.
  lines.push(`[data-fc="card"] {`);
  lines.push(`  padding-top: ${s.cardPaddingY}px !important;`);
  lines.push(`  padding-bottom: ${s.cardPaddingY}px !important;`);
  lines.push(`  padding-left: ${s.cardPaddingX}px !important;`);
  lines.push(`  padding-right: ${s.cardPaddingX}px !important;`);
  lines.push(`  margin-top: ${s.cardGapY}px !important;`);
  lines.push(`  margin-bottom: ${s.cardGapY}px !important;`);
  lines.push(`  border-radius: ${s.cardRadius}px !important;`);
  lines.push(`  border-width: ${s.cardBorderWidth}px !important;`);
  lines.push(`  font-size: ${s.cardFontSize}px !important;`);
  lines.push(`}`);

  // Icon sizing (EntityIcon + ActorGlyph use h-4 w-4 and h-3.5 w-3.5)
  lines.push(`[data-fc="card"] > svg,`);
  lines.push(`[data-fc="card"] > span:not([class*="flex"]) > svg {`);
  lines.push(`  width: ${s.iconSize}px !important;`);
  lines.push(`  height: ${s.iconSize}px !important;`);
  lines.push(`}`);

  // Actor color + weight — weight always emitted, color only if set.
  lines.push(`[data-fc="actor"] { font-weight: ${s.actorWeight} !important; }`);
  if (s.actorColor) lines.push(`[data-fc="actor"] { color: ${s.actorColor} !important; }`);
  if (s.verbColor) lines.push(`[data-fc="verb"] { color: ${s.verbColor} !important; }`);
  if (s.identifierColor) lines.push(`[data-fc="id"] { color: ${s.identifierColor} !important; }`);
  if (s.titleColor) lines.push(`[data-fc="title"] { color: ${s.titleColor} !important; }`);
  if (s.timestampColor) lines.push(`[data-fc="time"] { color: ${s.timestampColor} !important; }`);

  // Hover state — only applies when the card itself is hovered.
  if (s.actorColorHover) lines.push(`[data-fc="card"]:hover [data-fc="actor"] { color: ${s.actorColorHover} !important; }`);
  if (s.verbColorHover) lines.push(`[data-fc="card"]:hover [data-fc="verb"] { color: ${s.verbColorHover} !important; }`);
  if (s.identifierColorHover) lines.push(`[data-fc="card"]:hover [data-fc="id"] { color: ${s.identifierColorHover} !important; }`);
  if (s.titleColorHover) lines.push(`[data-fc="card"]:hover [data-fc="title"] { color: ${s.titleColorHover} !important; }`);
  if (s.timestampColorHover) lines.push(`[data-fc="card"]:hover [data-fc="time"] { color: ${s.timestampColorHover} !important; }`);

  return lines.join("\n");
}

function applyCss(css: string) {
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = css;
}

const PANEL_WIDTH = 320;
const POSITION_STORAGE_KEY = "paperclip.feedCardTuner.position";

type Position = { x: number; y: number };

function loadPosition(): Position | null {
  try {
    const raw = localStorage.getItem(POSITION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.x !== "number" || typeof parsed?.y !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function FeedCardTuner() {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<TunerSettings>(() => loadSettings());
  const [exportOpen, setExportOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [position, setPosition] = useState<Position | null>(() => loadPosition());
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!position) return;
    try {
      localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(position));
    } catch {
      // ignore
    }
  }, [position]);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;

    const onMove = (ev: MouseEvent) => {
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      const maxX = Math.max(0, window.innerWidth - width);
      const maxY = Math.max(0, window.innerHeight - height);
      const x = Math.min(maxX, Math.max(0, ev.clientX - offsetX));
      const y = Math.min(maxY, Math.max(0, ev.clientY - offsetY));
      setPosition({ x, y });
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "grabbing";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  useEffect(() => {
    applyCss(buildCss(settings));
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // ignore quota errors
    }
  }, [settings]);

  const exportJson = useMemo(
    () =>
      JSON.stringify(
        {
          settings,
          css: buildCss(settings),
          note:
            "Generated by FeedCardTuner. Apply values to FeedCard.tsx / ActivityFeed.tsx to make permanent.",
        },
        null,
        2,
      ),
    [settings],
  );

  const update = <K extends keyof TunerSettings>(k: K, v: TunerSettings[K]) =>
    setSettings((s) => ({ ...s, [k]: v }));

  const handleCopy = () => {
    navigator.clipboard.writeText(exportJson).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-[60] grid h-10 w-10 place-items-center rounded-full bg-foreground text-background shadow-lg transition-opacity hover:opacity-90"
        aria-label="Open feed card tuner"
      >
        <Palette className="h-4 w-4" />
      </button>
    );
  }

  const panelStyle: React.CSSProperties = position
    ? { left: position.x, top: position.y, width: PANEL_WIDTH }
    : { right: 16, bottom: 16, width: PANEL_WIDTH };

  return (
    <div
      ref={panelRef}
      style={panelStyle}
      className="fixed z-[60] flex flex-col rounded-lg border border-border bg-card text-foreground shadow-xl"
    >
      <div
        onMouseDown={handleDragStart}
        className="flex shrink-0 cursor-grab items-center justify-between border-b border-border px-3 py-2 active:cursor-grabbing"
      >
        <span className="flex items-center gap-1.5 text-xs font-semibold">
          <GripVertical className="h-3 w-3 text-muted-foreground" />
          Feed card tuner
        </span>
        <div className="flex items-center gap-1" onMouseDown={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={() => setSettings(DEFAULTS)}
            className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Reset"
            title="Reset"
          >
            <RotateCcw className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>

      <div className="max-h-[60vh] space-y-3 overflow-y-auto px-3 py-2 text-xs">
        <Section title="Presets">
          <div className="flex flex-wrap gap-1">
            {PRESETS.map((p) => (
              <button
                key={p.name}
                type="button"
                onClick={() => setSettings(p.settings)}
                className="rounded border border-border bg-background px-2 py-1 text-[10px] text-foreground transition-colors hover:bg-accent"
              >
                {p.name}
              </button>
            ))}
          </div>
        </Section>

        <Section title="Spacing">
          <SliderRow label="Padding Y" value={settings.cardPaddingY} min={0} max={24} onChange={(v) => update("cardPaddingY", v)} />
          <SliderRow label="Padding X" value={settings.cardPaddingX} min={0} max={24} onChange={(v) => update("cardPaddingX", v)} />
          <SliderRow label="Gap (each side)" value={settings.cardGapY} min={0} max={16} onChange={(v) => update("cardGapY", v)} />
          <SliderRow label="Border radius" value={settings.cardRadius} min={0} max={20} onChange={(v) => update("cardRadius", v)} />
          <SliderRow label="Border width" value={settings.cardBorderWidth} min={0} max={3} onChange={(v) => update("cardBorderWidth", v)} />
        </Section>

        <Section title="Typography">
          <SliderRow label="Text size" value={settings.cardFontSize} min={10} max={16} onChange={(v) => update("cardFontSize", v)} />
          <SliderRow label="Icon size" value={settings.iconSize} min={10} max={24} onChange={(v) => update("iconSize", v)} />
          <SliderRow label="Actor weight" value={settings.actorWeight} min={300} max={800} step={100} onChange={(v) => update("actorWeight", v)} />
        </Section>

        <Section title="Colors — default">
          <p className="text-[10px] text-muted-foreground">Leave blank to use theme default.</p>
          <ColorRow label="Actor" value={settings.actorColor} onChange={(v) => update("actorColor", v)} />
          <ColorRow label="Verb" value={settings.verbColor} onChange={(v) => update("verbColor", v)} />
          <ColorRow label="Identifier" value={settings.identifierColor} onChange={(v) => update("identifierColor", v)} />
          <ColorRow label="Title" value={settings.titleColor} onChange={(v) => update("titleColor", v)} />
          <ColorRow label="Timestamp" value={settings.timestampColor} onChange={(v) => update("timestampColor", v)} />
        </Section>

        <Section title="Colors — hover">
          <p className="text-[10px] text-muted-foreground">Blank = inherit the default color above.</p>
          <ColorRow label="Actor" value={settings.actorColorHover} onChange={(v) => update("actorColorHover", v)} />
          <ColorRow label="Verb" value={settings.verbColorHover} onChange={(v) => update("verbColorHover", v)} />
          <ColorRow label="Identifier" value={settings.identifierColorHover} onChange={(v) => update("identifierColorHover", v)} />
          <ColorRow label="Title" value={settings.titleColorHover} onChange={(v) => update("titleColorHover", v)} />
          <ColorRow label="Timestamp" value={settings.timestampColorHover} onChange={(v) => update("timestampColorHover", v)} />
        </Section>
      </div>

      <div className="shrink-0 border-t border-border px-3 py-2">
        <button
          type="button"
          onClick={() => setExportOpen((v) => !v)}
          className="w-full rounded bg-accent px-2 py-1 text-xs text-foreground hover:bg-accent/70"
        >
          {exportOpen ? "Hide export" : "Export config"}
        </button>
        {exportOpen && (
          <div className="mt-2 space-y-1">
            <textarea
              readOnly
              value={exportJson}
              className="h-40 w-full resize-none rounded border border-border bg-background px-1.5 py-1 font-mono text-[10px] leading-tight"
            />
            <button
              type="button"
              onClick={handleCopy}
              className="flex w-full items-center justify-center gap-1 rounded bg-foreground px-2 py-1 text-xs text-background transition-opacity hover:opacity-90"
            >
              <Copy className="h-3 w-3" />
              {copied ? "Copied!" : "Copy to clipboard"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      {children}
    </div>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono text-[10px] text-foreground">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        className="w-full accent-foreground"
      />
    </div>
  );
}

function ColorRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const isHex = /^#[0-9a-f]{6}$/i.test(value);
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1">
        <input
          type="text"
          placeholder="inherit"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-24 rounded border border-border bg-background px-1 py-0.5 font-mono text-[10px] outline-none focus:border-muted-foreground"
        />
        <input
          type="color"
          value={isHex ? value : "#ffffff"}
          onChange={(e) => onChange(e.target.value)}
          className={cn(
            "h-6 w-6 shrink-0 cursor-pointer rounded border border-border bg-background",
            !isHex && "opacity-50",
          )}
          title="Pick color"
        />
      </div>
    </div>
  );
}

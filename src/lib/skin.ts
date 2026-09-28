// Visual skin: the default "classic" look or one of the alternatives —
// "terminal" (phosphor green on black, monospace, square boxes, optional CRT
// overlay), "paper" (a light financial-newspaper look: salmon paper, ink,
// serif headings) and "retro" (Windows 95: grey bevelled boxes on a teal
// desktop, navy title bars). Device-local, NOT synced — each device keeps its
// own look.
//
// CSS: every skin's rules live under html[data-skin="…"] (index.css), so the
// classic stylesheet is untouched. index.html sets the attribute before
// first paint so there is no flash of the wrong skin.
// JS colours (charts, calendar categories) go through `skinned()`: the classic
// variant holds the exact original values.

import { create } from "zustand";

export type Skin = "classic" | "terminal" | "paper" | "retro";

const SKINS: readonly Skin[] = ["classic", "terminal", "paper", "retro"];

const SKIN_KEY = "pf-skin";
const CRT_KEY = "pf-crt";

/** Browser-chrome colour per skin (the <meta name="theme-color">). */
const THEME_COLOR: Record<Skin, string> = {
  classic: "#0b1020",
  terminal: "#050805",
  paper: "#fff1e5",
  retro: "#008080",
};

function loadSkin(): Skin {
  try {
    const v = localStorage.getItem(SKIN_KEY);
    return SKINS.includes(v as Skin) ? (v as Skin) : "classic";
  } catch {
    return "classic";
  }
}

function loadCrt(): boolean {
  try {
    return localStorage.getItem(CRT_KEY) !== "0";
  } catch {
    return true;
  }
}

function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

/** Mirror the skin onto <html> (the index.html boot script does the same). */
function applyToDocument(skin: Skin, crt: boolean) {
  const root = document.documentElement;
  root.dataset.skin = skin;
  if (crt) root.dataset.crt = "";
  else delete root.dataset.crt;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", THEME_COLOR[skin]);
}

// Read synchronously at import so module-level colour tables resolve right on
// the very first render.
let current: Skin = loadSkin();

export function currentSkin(): Skin {
  return current;
}

interface SkinState {
  skin: Skin;
  /** Scanlines + vignette overlay (terminal skin only). */
  crt: boolean;
  setSkin: (skin: Skin) => void;
  setCrt: (on: boolean) => void;
}

export const useSkin = create<SkinState>((set, get) => ({
  skin: current,
  crt: loadCrt(),
  setSkin: (skin) => {
    current = skin;
    save(SKIN_KEY, skin);
    applyToDocument(skin, get().crt);
    set({ skin });
  },
  setCrt: (crt) => {
    save(CRT_KEY, crt ? "1" : "0");
    applyToDocument(get().skin, crt);
    set({ crt });
  },
}));

/**
 * A colour table with one variant per skin; reads resolve against the current
 * skin. Call sites keep using it like a plain object/array (hex strings, so
 * `${color}80`-style alpha suffixes keep working). Pages remount on a skin
 * switch (App keys them by skin), so nothing holds a stale value.
 */
export function skinned<T extends object>(variants: Record<Skin, T>): T {
  return new Proxy(variants.classic, {
    get: (_target, prop) => Reflect.get(variants[current], prop),
    has: (_target, prop) => Reflect.has(variants[current], prop),
    ownKeys: () => Reflect.ownKeys(variants[current]),
    getOwnPropertyDescriptor: (_target, prop) =>
      Reflect.getOwnPropertyDescriptor(variants[current], prop),
  });
}

/** Skins that drop the smooth sliding/springing motion (fades only). */
export function isSnappy(skin: Skin): boolean {
  return skin === "terminal" || skin === "retro";
}

// Terminal palette: ANSI-ish brights on black, green-first.
const T = {
  green: "#33ff66",
  greenDim: "#1f9e45",
  greenPale: "#a8ffbf",
  cyan: "#33e0ff",
  yellow: "#ffd633",
  amber: "#ffb000",
  red: "#ff4d4d",
  magenta: "#ff5cf0",
  blue: "#5c8cff",
  orange: "#ff8c1a",
  grid: "#143a1f",
  axis: "#3fae5c",
  cursor: "#1f6e35",
  surface: "#0a100a",
};

// Paper palette: newsprint inks on salmon — dark enough to read on light.
const P = {
  ink: "#1f1a17",
  blue: "#0f5499",
  claret: "#990f3d",
  teal: "#0d7680",
  ochre: "#b86e00",
  plum: "#593380",
  moss: "#4f7a28",
  sky: "#5b8fc7",
  slate: "#66605a",
  green: "#0a7d53",
  red: "#b3261e",
  grid: "#e8d5c2",
  axis: "#7a6a5c",
  cursor: "#d9c2ab",
  surface: "#fff8f1",
};

// Retro palette: the 16-colour Windows palette (dark halves read on grey).
const R = {
  navy: "#000080",
  blue: "#0000ff",
  teal: "#008080",
  green: "#008000",
  olive: "#808000",
  maroon: "#800000",
  red: "#c00000",
  purple: "#800080",
  fuchsia: "#d000d0",
  grey: "#808080",
  lightBlue: "#1084d0",
  grid: "#a8a8a8",
  axis: "#202020",
  cursor: "#808080",
  surface: "#c0c0c0",
};

/** Fixed chart colours (grid, axes, main series, tooltip box). */
export const CHART = skinned({
  classic: {
    grid: "#232b45",
    axis: "#8b93a7",
    cursor: "#3a4468",
    text: "#e8ecf8",
    surface: "#141a2e",
    brand: "#6366f1",
    /** Backtest / secondary dashed line. */
    alt: "#a5b4fc",
    highlight: "#fbbf24",
    positive: "#34d399",
    negative: "#fb7185",
  },
  terminal: {
    grid: T.grid,
    axis: T.axis,
    cursor: T.cursor,
    text: T.greenPale,
    surface: T.surface,
    brand: T.green,
    alt: T.cyan,
    highlight: T.amber,
    positive: T.green,
    negative: T.red,
  },
  paper: {
    grid: P.grid,
    axis: P.axis,
    cursor: P.cursor,
    text: P.ink,
    surface: P.surface,
    brand: P.blue,
    alt: P.sky,
    highlight: P.ochre,
    positive: P.green,
    negative: P.red,
  },
  retro: {
    grid: R.grid,
    axis: R.axis,
    cursor: R.cursor,
    text: "#000000",
    surface: R.surface,
    brand: R.navy,
    alt: R.lightBlue,
    highlight: R.olive,
    positive: R.green,
    negative: R.red,
  },
});

/** Categorical series colours (cycled) — e.g. allocation slices. */
export const SERIES_COLORS = skinned({
  classic: ["#6366f1", "#8b5cf6", "#22d3ee", "#34d399", "#fbbf24", "#fb7185"],
  terminal: [T.green, T.cyan, T.yellow, T.magenta, T.blue, T.orange],
  paper: [P.blue, P.claret, P.teal, P.ochre, P.plum, P.moss],
  retro: [R.navy, R.red, R.teal, R.olive, R.purple, R.green],
});

/** Per-skin counterparts used by the other colour tables. */
export const TERM = T;
export const PAPER = P;
export const RETRO = R;

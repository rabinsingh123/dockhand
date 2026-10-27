// Key names from the model -> Playwright key chords. Meta documents only ["Enter"]; normalize defensively.

const NAMED: Record<string, string> = {
  ctrl: "Control",
  control: "Control",
  cmd: "ControlOrMeta",
  command: "ControlOrMeta",
  meta: "ControlOrMeta",
  super: "ControlOrMeta",
  win: "ControlOrMeta",
  windows: "ControlOrMeta",
  os: "ControlOrMeta",
  controlormeta: "ControlOrMeta",
  alt: "Alt",
  option: "Alt",
  opt: "Alt",
  shift: "Shift",
  enter: "Enter",
  return: "Enter",
  esc: "Escape",
  escape: "Escape",
  tab: "Tab",
  backspace: "Backspace",
  bksp: "Backspace",
  delete: "Delete",
  del: "Delete",
  space: "Space",
  spacebar: "Space",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  pgup: "PageUp",
  pageup: "PageUp",
  page_up: "PageUp",
  pgdn: "PageDown",
  pagedown: "PageDown",
  page_down: "PageDown",
  home: "Home",
  end: "End",
  insert: "Insert",
  ins: "Insert",
};

const MODIFIERS = new Set(["Control", "ControlOrMeta", "Alt", "Shift", "Meta"]);

function normalizeKey(raw: string): string {
  if (raw === " ") return "Space";
  const k = raw.trim();
  const named = NAMED[k.toLowerCase()];
  if (named) return named;
  const f = /^f([1-9]|1[0-2])$/i.exec(k);
  if (f) return `F${f[1]}`;
  return k;
}

export interface KeyPlan {
  /** Chords to press in order, e.g. ["Control+a"] or ["Tab", "Tab"]. */
  chords: string[];
  /** Some chord presses Enter (implicit form submit). */
  enter: boolean;
  /** Some chord presses Space (activates a focused button). */
  space: boolean;
}

/**
 * Several keys in one array form one chord (["ctrl", "a"] -> "Control+a"); a single "ctrl+a" string is split on
 * "+". Several non-modifier keys are pressed one after another, each with the modifiers held.
 */
export function planKeys(keys: readonly string[]): KeyPlan {
  const parts = keys.flatMap((k) => (k.length > 1 && k.includes("+") ? k.split("+").filter(Boolean) : [k]));
  const mapped = parts.map(normalizeKey).filter(Boolean);
  const mods = mapped.filter((k) => MODIFIERS.has(k));
  const shift = mods.includes("Shift");
  const rest = mapped
    .filter((k) => !MODIFIERS.has(k))
    .map((k) => (k.length === 1 && mods.length > 0 && !shift ? k.toLowerCase() : k));
  const chords = rest.length <= 1 ? [[...mods, ...rest].join("+")] : rest.map((k) => [...mods, k].join("+"));
  return {
    chords: chords.filter(Boolean),
    enter: rest.includes("Enter"),
    space: rest.includes("Space"),
  };
}

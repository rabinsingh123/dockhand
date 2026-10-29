// Strings a model extracted from what a buyer or partner sent (a PDF, a photo, a voice note, a teach video) end
// up in other model prompts and in the rep's cards. Each one is cut to one line of bounded data first, so a
// document cannot add lines that read as instructions ("[2] Text from the rep: ...") or flood a prompt.

/** Control characters (newlines and tabs included), line and paragraph separators, bidi overrides, BOM. */
const UNSAFE = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]+/gu;

/** Caps, in characters. */
export const MAX = {
  name: 120, // company, person, city, buyer, button names
  email: 254,
  phone: 40,
  url: 500,
  sentence: 500, // summaries, success descriptions, teach steps
  text: 1000, // notes, extracted field values, a teach goal
  transcript: 4000,
} as const;

/** One line, unsafe characters replaced by a space, whitespace collapsed, at most `max` characters. */
export function promptText(value: string, max: number): string {
  const line = value.replace(UNSAFE, " ").replace(/\s+/g, " ").trim();
  const chars = [...line];
  return chars.length <= max ? line : chars.slice(0, max).join("").trimEnd();
}

/** promptText, or null when nothing is left. */
export function promptTextOrNull(value: string | null | undefined, max: number): string | null {
  if (typeof value !== "string") return null;
  const out = promptText(value, max);
  return out === "" ? null : out;
}

/** A value quoted as data inside a sentence of instructions: "Acme \"Group\"" (JSON string syntax). */
export function quoted(value: string, max: number = MAX.name): string {
  return JSON.stringify(promptText(value, max));
}

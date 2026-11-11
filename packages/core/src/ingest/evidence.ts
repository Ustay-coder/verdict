import type { Evidence, Input } from "../schema/subject.js";

/** Counts trimmed characters, words and lines; empty text yields zero counts. */
export function stats(text: string) {
  const trimmed = text.trim();
  return {
    chars: trimmed.length,
    words: trimmed ? trimmed.split(/\s+/).length : 0,
    lines: trimmed ? trimmed.split(/\r?\n/).length : 0,
  };
}

export function make(input: Input, index: number, text: string, extra: Partial<Evidence> = {}, maxChars = 200_000): Evidence {
  let truncated = false;
  if (text.length > maxChars) { text = text.slice(0, maxChars); truncated = true; }
  return {
    inputIndex: index,
    kind: input.type,
    label: input.label ?? extra.label ?? `${input.type} #${index + 1}`,
    tags: input.tags ?? [],
    text,
    truncated,
    stats: stats(text),
    ...extra,
  };
}

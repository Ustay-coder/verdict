/**
 * Ties a judge's quote to the place it occurs in the document as it was extracted. A quote that does not occur there
 * is returned without a location: it is shown as said by the judge, never as a passage of the document.
 */
import type { Evidence } from "../schema/subject.js";
import type { ObservedQuote, QuoteLocation } from "./types.js";

/** Text with every run of whitespace as one space, and for each kept character its offset in the original. */
function squeeze(text: string): { text: string; offsets: number[] } {
  let out = "";
  const offsets: number[] = [];
  let gap = true;
  for (let i = 0; i < text.length; i++) {
    const space = /\s/.test(text[i]!);
    if (space && gap) continue;
    out += space ? " " : text[i];
    offsets.push(i);
    gap = space;
  }
  return { text: out, offsets };
}

/** Where `quote` occurs in the evidence, ignoring differences in whitespace only; undefined when it does not. */
export function locateQuote(evidence: Evidence[], quote: string): QuoteLocation | undefined {
  const needle = squeeze(quote).text.trim();
  if (!needle) return undefined;
  for (const item of evidence) {
    const hay = squeeze(item.text);
    const at = hay.text.indexOf(needle);
    if (at < 0) continue;
    const start = hay.offsets[at]!, end = hay.offsets[at + needle.length - 1]! + 1;
    return { inputIndex: item.inputIndex, label: item.label, line: item.text.slice(0, start).split("\n").length, start, end };
  }
  return undefined;
}

export function observeQuotes(evidence: Evidence[], quotes: string[]): ObservedQuote[] {
  return quotes.filter((q) => q.trim()).map((text) => { const location = locateQuote(evidence, text); return location ? { text, location } : { text }; });
}

/**
 * Attaches whole documents (PDFs) to evidence for judges that read the file itself.
 * Like images, the bytes live in a WeakMap keyed by the evidence object and never on the evidence, so a stored
 * evaluation carries only the metadata (size, pages). The evidence text stays what it was: the PDF's text layer,
 * which is what every judge that cannot take the file is given.
 */
import type { Evidence } from "../schema/subject.js";
import { toBase64 } from "./images.js";
import type { PdfPageRenderer } from "./pdf-pages.js";

const files = new WeakMap<Evidence, string[]>();
const bytes = new WeakMap<Evidence, Uint8Array[]>();
const drawn = new WeakMap<Evidence, Map<number, Promise<string[] | null>>>();

/** Data URIs of the documents attached to an evidence block; empty when there are none. */
export function evidenceDocuments(e: Evidence): string[] { return files.get(e) ?? []; }

/** Attaches a PDF to an evidence block: metadata on the evidence, bytes in memory only. */
export function attachPdf(e: Evidence, data: Uint8Array, pages?: number): Evidence {
  files.set(e, [...evidenceDocuments(e), `data:application/pdf;base64,${toBase64(data)}`]);
  bytes.set(e, [...(bytes.get(e) ?? []), data]);
  e.documents = [...(e.documents ?? []), { mimeType: "application/pdf", bytes: data.length, ...(pages ? { pages } : {}) }];
  return e;
}

/**
 * What stands in the evidence for a PDF with no text layer, so a judge that cannot take the file is told what it is
 * missing instead of being handed nothing.
 */
export function scannedPdfNote(label: string, pages?: number): string {
  return `[document: ${label}${pages ? `, ${pages} page${pages === 1 ? "" : "s"}` : ""}; it has no text layer (a scan?), so there is no text to show. A judge that reads PDFs is sent the file itself, and one that takes pictures is sent pictures of its pages]`;
}

/** One line that stands for the documents of an evidence block where the file itself is sent. */
export function describeDocuments(e: Evidence): string {
  const parts = (e.documents ?? []).map((d) => `${d.pages ? `${d.pages} page${d.pages === 1 ? "" : "s"}, ` : ""}${Math.max(1, Math.round(d.bytes / 1024))} KB PDF`);
  return `[document: ${e.label}, ${parts.join("; ")}; the file itself is attached]`;
}

/** How many pages the PDFs attached to an evidence block have in all; 0 when it has none or their length is unknown. */
export function evidencePdfPageCount(e: Evidence): number {
  return (e.documents ?? []).reduce((sum, d) => sum + (d.pages ?? 0), 0);
}

/**
 * Pictures of the first `limit` pages of an evidence block's PDFs, as data URIs, in reading order. Drawn once for a
 * given limit and kept with the evidence, so several judges of one evaluation share the work. Null when no renderer
 * is available.
 */
export function evidencePdfPages(e: Evidence, render: PdfPageRenderer, limit: number): Promise<string[] | null> {
  const cache = drawn.get(e) ?? new Map<number, Promise<string[] | null>>();
  drawn.set(e, cache);
  const known = cache.get(limit);
  if (known) return known;
  const work = (async () => {
    const uris: string[] = [];
    for (const [i, pdf] of (bytes.get(e) ?? []).entries()) {
      const wanted = Math.min(e.documents?.[i]?.pages ?? 0, limit - uris.length);
      if (wanted <= 0) continue;
      const pages = await render(pdf, Array.from({ length: wanted }, (_, n) => n + 1));
      if (!pages) return null;
      for (const page of pages) uris.push(`data:${page.mimeType};base64,${toBase64(page.data)}`);
    }
    return uris;
  })();
  cache.set(limit, work);
  return work;
}

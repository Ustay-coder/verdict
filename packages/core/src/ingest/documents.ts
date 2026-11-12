/**
 * Attaches whole documents (PDFs) to evidence for judges that read the file itself.
 * Like images, the bytes live in a WeakMap keyed by the evidence object and never on the evidence, so a stored
 * evaluation carries only the metadata (size, pages). The evidence text stays what it was: the PDF's text layer,
 * which is what every judge that cannot take the file is given.
 */
import type { Evidence } from "../schema/subject.js";
import { toBase64 } from "./images.js";

const files = new WeakMap<Evidence, string[]>();

/** Data URIs of the documents attached to an evidence block; empty when there are none. */
export function evidenceDocuments(e: Evidence): string[] { return files.get(e) ?? []; }

/** Attaches a PDF to an evidence block: metadata on the evidence, bytes in memory only. */
export function attachPdf(e: Evidence, data: Uint8Array, pages?: number): Evidence {
  files.set(e, [...evidenceDocuments(e), `data:application/pdf;base64,${toBase64(data)}`]);
  e.documents = [...(e.documents ?? []), { mimeType: "application/pdf", bytes: data.length, ...(pages ? { pages } : {}) }];
  return e;
}

/**
 * What stands in the evidence for a PDF with no text layer, so a judge that cannot take the file is told what it is
 * missing instead of being handed nothing.
 */
export function scannedPdfNote(label: string, pages?: number): string {
  return `[document: ${label}${pages ? `, ${pages} page${pages === 1 ? "" : "s"}` : ""}; it has no text layer (a scan?), so there is no text to show. Judges that read PDFs are sent the file itself]`;
}

/** One line that stands for the documents of an evidence block where the file itself is sent. */
export function describeDocuments(e: Evidence): string {
  const parts = (e.documents ?? []).map((d) => `${d.pages ? `${d.pages} page${d.pages === 1 ? "" : "s"}, ` : ""}${Math.max(1, Math.round(d.bytes / 1024))} KB PDF`);
  return `[document: ${e.label}, ${parts.join("; ")}; the file itself is attached]`;
}

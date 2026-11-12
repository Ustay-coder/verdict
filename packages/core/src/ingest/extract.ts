import { htmlToText } from "html-to-text";

/**
 * Always hand parsers a private copy: Node's Buffer is a Uint8Array subclass the PDF parser rejects, and pdf.js
 * transfers (detaches) the buffer it receives, which would corrupt bytes the caller still holds.
 */
export function asUint8Array(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

/** Parser failures reject; malformed JSON stays readable as text with an explicit warning. */
const MIN_PDF_TEXT_CHARS = 20;

export async function extractFromBuffer(buf: Uint8Array, filename = "", mimeType = ""): Promise<{ text: string; json?: unknown; warnings?: string[]; pdfPages?: number }> {
  const { extname } = await import("node:path");
  const ext = extname(filename).toLowerCase();
  const mt = mimeType.toLowerCase();
  if (mt.includes("pdf") || ext === ".pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    // why: pdf.js detaches the buffer it is given, and the caller may still attach these bytes for judges that read the file.
    const pdf = await getDocumentProxy(asUint8Array(buf));
    const { text, totalPages } = await extractText(pdf, { mergePages: true });
    // why: pages with almost no extracted text are likely scans; keep the content and flag the need for OCR.
    const warnings = text.trim().length < MIN_PDF_TEXT_CHARS && totalPages > 0 ? ["PDF contains little extractable text (scanned? consider OCR)"] : undefined;
    return { text: typeof text === "string" ? text : (text as string[]).join("\n"), warnings, pdfPages: totalPages };
  }
  const str = new TextDecoder().decode(buf);
  if (mt.includes("json") || ext === ".json") {
    try {
      const json: unknown = JSON.parse(str);
      return { text: JSON.stringify(json, null, 2), json };
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return { text: str, warnings: ["invalid JSON; treated as text"] };
    }
  }
  if (mt.includes("html") || ext === ".html" || ext === ".htm") return { text: htmlToPlain(str) };
  // why: unrecognized textual formats remain useful evidence; do not discard them for lacking a parser.
  return { text: str };
}

/** Returns visible HTML text; conversion errors propagate to ingestion. */
export function htmlToPlain(html: string): string {
  return htmlToText(html, {
    wordwrap: false,
    // why: navigation and styling are page chrome rather than evidence; links contribute their visible text only.
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
      { selector: "nav", format: "skip" },
      { selector: "footer", format: "skip" },
    ],
  }).replace(/\n{3,}/g, "\n\n");
}

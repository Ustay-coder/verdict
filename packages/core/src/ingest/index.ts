import { htmlToText } from "html-to-text";
import type { Evidence, ImageMeta, Input, ScreenshotOptions, Subject } from "../schema/subject.js";

export interface IngestOptions {
  /** Max characters per evidence block (judges see at most this much). */
  maxChars?: number;
  fetch?: typeof fetch;
  /** Allow reading local file paths (disable on multi-tenant servers). */
  allowLocalFiles?: boolean;
  /** Timeout for network inputs (ms). */
  timeoutMs?: number;
  /** Pluggable YouTube transcript provider (e.g. a paid API). */
  youtubeTranscript?: (videoId: string, lang?: string) => Promise<{ text: string; title?: string } | null>;
  /**
   * Screenshot renderer for `url` inputs with `screenshot` set (e.g. `playwrightScreenshot()` in Node).
   * Without one, such inputs still ingest their text and carry a warning.
   */
  screenshot?: ScreenshotRenderer;
}

export type ScreenshotRenderer = (url: string, opts: Required<Omit<ScreenshotOptions, "fullPage">> & { fullPage: boolean }) => Promise<{ data: Uint8Array; mimeType?: string } | null>;

export type Ingestor = (input: Input, index: number, opts: Required<Pick<IngestOptions, "maxChars" | "fetch" | "allowLocalFiles" | "timeoutMs">> & IngestOptions) => Promise<Evidence>;

const registry = new Map<Input["type"], Ingestor>();

/** Replace or add an ingestor for an input type (e.g. route `url` through a headless browser). */
export function registerIngestor(type: Input["type"], fn: Ingestor) { registry.set(type, fn); }

export function stats(text: string) {
  const trimmed = text.trim();
  return {
    chars: trimmed.length,
    words: trimmed ? trimmed.split(/\s+/).length : 0,
    lines: trimmed ? trimmed.split(/\r?\n/).length : 0,
  };
}

function make(input: Input, index: number, text: string, extra: Partial<Evidence> = {}, maxChars = 200_000): Evidence {
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

/* ---------- images ---------- */
// Image bytes stay out of the Evidence object so stored evaluations never carry them; judges read them from here.
const media = new WeakMap<Evidence, string[]>();

/** Data URIs of the images attached to an evidence block (empty when none). */
export function evidenceImages(e: Evidence): string[] { return media.get(e) ?? []; }

/** Attach images to an evidence block: metadata on the evidence, bytes in memory only. */
export function attachImages(e: Evidence, images: Array<{ data: Uint8Array; mimeType?: string }>): Evidence {
  const uris: string[] = [];
  const meta: ImageMeta[] = [];
  for (const img of images) {
    const info = imageInfo(img.data, img.mimeType);
    if (!info) throw new Error("unsupported image: expected PNG, JPEG or WebP");
    uris.push(`data:${info.mimeType};base64,${toBase64(img.data)}`);
    meta.push(info);
  }
  media.set(e, [...evidenceImages(e), ...uris]);
  e.images = [...(e.images ?? []), ...meta];
  return e;
}

/** Sniff PNG / JPEG / WebP and read the pixel size from the header. */
export function imageInfo(buf: Uint8Array, declared?: string): ImageMeta | undefined {
  const b = buf, at = (i: number) => b[i] ?? 0;
  const be16 = (i: number) => (at(i) << 8) | at(i + 1), be32 = (i: number) => ((at(i) << 24) >>> 0) + (at(i + 1) << 16) + (at(i + 2) << 8) + at(i + 3);
  const le16 = (i: number) => at(i) | (at(i + 1) << 8), le24 = (i: number) => at(i) | (at(i + 1) << 8) | (at(i + 2) << 16);
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return { mimeType: "image/png", bytes: b.length, width: be32(16), height: be32(20) };
  if (at(0) === 0xff && at(1) === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (at(i) !== 0xff) { i++; continue; }
      const marker = at(i + 1), len = be16(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { mimeType: "image/jpeg", bytes: b.length, height: be16(i + 5), width: be16(i + 7) };
      i += 2 + len;
    }
    return { mimeType: "image/jpeg", bytes: b.length };
  }
  if (String.fromCharCode(at(0), at(1), at(2), at(3)) === "RIFF" && String.fromCharCode(at(8), at(9), at(10), at(11)) === "WEBP") {
    const chunk = String.fromCharCode(at(12), at(13), at(14), at(15));
    if (chunk === "VP8X") return { mimeType: "image/webp", bytes: b.length, width: le24(24) + 1, height: le24(27) + 1 };
    if (chunk === "VP8 ") return { mimeType: "image/webp", bytes: b.length, width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
    if (chunk === "VP8L") { const bits = (at(21) | (at(22) << 8) | (at(23) << 16) | (at(24) << 24)) >>> 0; return { mimeType: "image/webp", bytes: b.length, width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }; }
    return { mimeType: "image/webp", bytes: b.length };
  }
  void declared;
  return undefined;
}

function toBase64(u8: Uint8Array): string {
  const B = (globalThis as { Buffer?: { from(u: Uint8Array): { toString(enc: string): string } } }).Buffer;
  if (B) return B.from(u8).toString("base64");
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(b64: string): Uint8Array {
  const B = (globalThis as { Buffer?: { from(s: string, enc: string): Uint8Array } }).Buffer;
  if (B) return new Uint8Array(B.from(b64, "base64"));
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
const describeImage = (m: ImageMeta) => `${m.width && m.height ? `${m.width}×${m.height} ` : ""}${m.mimeType.slice(6).toUpperCase()}`;

/**
 * Node-only screenshot renderer backed by Playwright, loaded lazily (never on Workers).
 * Returns undefined when Playwright isn't installed, so callers can fall back to text-only ingestion.
 */
export async function playwrightScreenshot(): Promise<ScreenshotRenderer | undefined> {
  let pw: { chromium: { launch(o?: unknown): Promise<{ newPage(o: unknown): Promise<PwPage>; close(): Promise<void> }> } };
  try {
    const { createRequire } = await import("node:module");
    pw = createRequire(import.meta.url)("playwright");
  } catch { return undefined; }
  return async (url, o) => {
    const browser = await pw.chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: o.width, height: o.height }, deviceScaleFactor: 1 });
      await page.goto(url, { waitUntil: "networkidle", timeout: 20_000 });
      const data = await page.screenshot({ type: "png", fullPage: o.fullPage });
      return { data: new Uint8Array(data), mimeType: "image/png" };
    } finally { await browser.close(); }
  };
}
/** A renderer that loads Playwright on first use; resolves to null (→ evidence warning) when it isn't installed. */
export function lazyPlaywrightScreenshot(): ScreenshotRenderer {
  let renderer: Promise<ScreenshotRenderer | undefined> | undefined;
  return async (url, o) => {
    const r = await (renderer ??= playwrightScreenshot());
    return r ? r(url, o) : null;
  };
}
type PwPage = { goto(u: string, o: unknown): Promise<unknown>; screenshot(o: unknown): Promise<Uint8Array> };

registerIngestor("image", async (input, i, o) => {
  if (input.type !== "image") throw new Error("bad input");
  let buf: Uint8Array;
  let name = input.filename ?? "";
  if (input.base64) buf = fromBase64(input.base64.replace(/^data:[^;]+;base64,/, ""));
  else if (input.path) {
    if (!o.allowLocalFiles) throw new Error("local file paths are disabled; send base64 content instead");
    const { readFile } = await import("node:fs/promises");
    const { basename } = await import("node:path");
    buf = new Uint8Array(await readFile(input.path));
    name ||= basename(input.path);
  } else throw new Error("image input needs `path` or `base64`");
  const info = imageInfo(buf, input.mimeType);
  if (!info) throw new Error(`unsupported image${name ? ` ${name}` : ""}: expected PNG, JPEG or WebP`);
  const label = input.label ?? (name || `image #${i + 1}`);
  const e = make(input, i, `[image: ${label}, ${describeImage(info)}; attached for vision-capable judges]`, { label, source: name || undefined }, o.maxChars);
  return attachImages(e, [{ data: buf, mimeType: info.mimeType }]);
});

/* ---------- text / json ---------- */
registerIngestor("text", async (input, i, o) => {
  if (input.type !== "text") throw new Error("bad input");
  return make(input, i, input.text, {}, o.maxChars);
});

registerIngestor("json", async (input, i, o) => {
  if (input.type !== "json") throw new Error("bad input");
  return make(input, i, JSON.stringify(input.data, null, 2), { json: input.data }, o.maxChars);
});

/* ---------- file ---------- */
export async function extractFromBuffer(buf: Uint8Array, filename = "", mimeType = ""): Promise<{ text: string; json?: unknown; warnings?: string[] }> {
  const { extname } = await import("node:path");
  const ext = extname(filename).toLowerCase();
  const mt = mimeType.toLowerCase();
  if (mt.includes("pdf") || ext === ".pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(buf);
    const { text, totalPages } = await extractText(pdf, { mergePages: true });
    const warnings = text.trim().length < 20 && totalPages > 0 ? ["PDF contains little extractable text (scanned? consider OCR)"] : undefined;
    return { text: typeof text === "string" ? text : (text as string[]).join("\n"), warnings };
  }
  const str = new TextDecoder().decode(buf);
  if (mt.includes("json") || ext === ".json") {
    try { const json = JSON.parse(str); return { text: JSON.stringify(json, null, 2), json }; } catch { return { text: str, warnings: ["invalid JSON; treated as text"] }; }
  }
  if (mt.includes("html") || ext === ".html" || ext === ".htm") return { text: htmlToPlain(str) };
  // txt, md, csv, yaml, code, ... -> as-is
  return { text: str };
}

registerIngestor("file", async (input, i, o) => {
  if (input.type !== "file") throw new Error("bad input");
  let buf: Uint8Array;
  let name = input.filename ?? "";
  if (input.base64) buf = Uint8Array.from(Buffer.from(input.base64, "base64"));
  else if (input.path) {
    if (!o.allowLocalFiles) throw new Error("local file paths are disabled; send base64 content instead");
    const { readFile } = await import("node:fs/promises");
    const { basename } = await import("node:path");
    buf = new Uint8Array(await readFile(input.path));
    name ||= basename(input.path);
  } else throw new Error("file input needs `path` or `base64`");
  const { text, json, warnings } = await extractFromBuffer(buf, name, input.mimeType);
  return make(input, i, text, { label: input.label ?? name, source: name, json, warnings }, o.maxChars);
});

/* ---------- url ---------- */
export function htmlToPlain(html: string): string {
  return htmlToText(html, {
    wordwrap: false,
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

async function fetchWithTimeout(f: typeof fetch, url: string, ms: number, init: RequestInit = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await f(url, { ...init, signal: ctrl.signal, headers: { "user-agent": "verdict-engine/0.1 (+https://github.com/verdict)", accept: "text/html,application/json,text/plain,*/*", ...(init.headers ?? {}) } });
  } finally { clearTimeout(t); }
}

registerIngestor("url", async (input, i, o) => {
  if (input.type !== "url") throw new Error("bad input");
  const res = await fetchWithTimeout(o.fetch, input.url, o.timeoutMs);
  if (!res.ok) throw new Error(`fetch ${input.url} -> HTTP ${res.status}`);
  const ct = res.headers.get("content-type") ?? "";
  let title: string | undefined;
  let text: string;
  let json: unknown;
  if (ct.includes("application/json")) { json = await res.json(); text = JSON.stringify(json, null, 2); }
  else if (ct.includes("pdf")) { ({ text } = await extractFromBuffer(new Uint8Array(await res.arrayBuffer()), "download.pdf", ct)); }
  else {
    const html = await res.text();
    title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim();
    text = ct.includes("html") || /<html/i.test(html) ? htmlToPlain(html) : html;
  }
  const e = make(input, i, text, { label: input.label ?? title ?? input.url, source: input.url, json }, o.maxChars);
  if (input.screenshot) {
    const so = typeof input.screenshot === "object" ? input.screenshot : {};
    const shot = o.screenshot ? await o.screenshot(input.url, { width: so.width ?? 1280, height: so.height ?? 800, fullPage: so.fullPage ?? false }) : null;
    if (shot) {
      attachImages(e, [shot]);
      e.text += `\n\n[screenshot of ${input.url} attached: ${describeImage(e.images!.at(-1)!)}]`;
      e.stats = stats(e.text);
    } else e.warnings = [...(e.warnings ?? []), o.screenshot ? "no screenshot captured (is Playwright installed?)" : "screenshot requested, but this engine has no screenshot renderer (CLI / MCP with Playwright installed)"];
  }
  return e;
});

/* ---------- youtube ---------- */
export function youtubeId(url: string): string | null {
  const m =
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/.exec(url) ??
    /^([A-Za-z0-9_-]{11})$/.exec(url.trim());
  return m?.[1] ?? null;
}

function decodeXml(s: string) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/** Best-effort transcript via YouTube's public caption tracks. Falls back to oEmbed title + description. */
export async function fetchYoutubeTranscript(f: typeof fetch, id: string, lang: string | undefined, timeoutMs: number) {
  const warnings: string[] = [];
  const watch = await fetchWithTimeout(f, `https://www.youtube.com/watch?v=${id}&hl=en`, timeoutMs, { headers: { "accept-language": "en-US,en;q=0.9" } });
  const html = watch.ok ? await watch.text() : "";
  const title = decodeXml(/<meta name="title" content="([^"]*)"/.exec(html)?.[1] ?? /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? `YouTube ${id}`);
  const description = decodeXml(/"shortDescription":"((?:[^"\\]|\\.)*)"/.exec(html)?.[1]?.replace(/\\n/g, "\n").replace(/\\"/g, '"') ?? "");
  const tracksJson = /"captionTracks":(\[.*?\])/.exec(html)?.[1];
  let transcript = "";
  if (tracksJson) {
    try {
      const tracks = JSON.parse(tracksJson) as Array<{ baseUrl: string; languageCode: string; kind?: string }>;
      const pick = tracks.find((t) => lang && t.languageCode === lang) ?? tracks.find((t) => t.kind !== "asr") ?? tracks[0];
      if (pick) {
        const xml = await (await fetchWithTimeout(f, pick.baseUrl.replace(/\\u0026/g, "&"), timeoutMs)).text();
        transcript = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map((m) => decodeXml(m[1]!.replace(/<[^>]+>/g, ""))).join(" ").replace(/\s+/g, " ").trim();
        if (pick.kind === "asr") warnings.push("transcript is auto-generated (ASR)");
      }
    } catch (e) { warnings.push(`caption parse failed: ${(e as Error).message}`); }
  }
  if (!transcript) warnings.push("no transcript available; evaluated on title + description only");
  return { title, description, transcript, warnings };
}

registerIngestor("youtube", async (input, i, o) => {
  if (input.type !== "youtube") throw new Error("bad input");
  const id = youtubeId(input.url);
  if (!id) throw new Error(`not a YouTube URL: ${input.url}`);
  let title: string | undefined, body: string, warnings: string[] = [];
  const custom = o.youtubeTranscript ? await o.youtubeTranscript(id, input.lang) : null;
  if (custom) { title = custom.title; body = custom.text; }
  else {
    const r = await fetchYoutubeTranscript(o.fetch, id, input.lang, o.timeoutMs);
    title = r.title; warnings = r.warnings;
    body = `# ${r.title}\n\n## Description\n${r.description}\n\n## Transcript\n${r.transcript}`;
  }
  return make(input, i, body, { label: input.label ?? title ?? input.url, source: `https://www.youtube.com/watch?v=${id}`, warnings: warnings.length ? warnings : undefined }, o.maxChars);
});

/* ---------- entry point ---------- */
export async function ingest(subject: Subject, options: IngestOptions = {}): Promise<Evidence[]> {
  const opts = { maxChars: 200_000, fetch: ((input, init) => globalThis.fetch(input, init)) as typeof fetch, allowLocalFiles: false, timeoutMs: 20_000, ...options };
  return Promise.all(
    subject.inputs.map(async (input, i) => {
      const fn = registry.get(input.type);
      if (!fn) throw new Error(`no ingestor for input type ${input.type}`);
      return fn(input, i, opts);
    }),
  );
}

import { htmlToText } from "html-to-text";
import type { Evidence, Input, Subject } from "../schema/subject.js";

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
}

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
  return make(input, i, text, { label: input.label ?? title ?? input.url, source: input.url, json }, o.maxChars);
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

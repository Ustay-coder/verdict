/**
 * Parses command input shorthand and reads standard input.
 * Tag prefixes must not split URL query parameters; file ingestion still requires local authorization.
 */
import { youtubeId, type Input } from "@verdict-ai/core";
import { basename, resolve } from "node:path";

/** `-i` values: a path (PNG/JPEG/WebP become image inputs), a URL, a YouTube URL, `text:...`, `json:...`; with optional `#tag` suffix after a space? keep simple: `tag=path`. */
export function parseInput(raw: string): Input {
  let tags: string[] | undefined;
  let label: string | undefined;
  const m = /^([a-zA-Z0-9_-]+)=(.+)$/.exec(raw);
  if (m && !/^https?$/.test(m[1]!)) { label = m[1]; tags = [m[1]!]; raw = m[2]!; }
  return parseSource(raw, label, tags);
}

function parseSource(raw: string, label?: string, tags?: string[]): Input {
  if (raw.startsWith("text:")) return { type: "text", text: raw.slice(5), label, tags };
  if (raw.startsWith("json:")) return { type: "json", data: JSON.parse(raw.slice(5)), label, tags };
  if (/^https?:\/\//.test(raw)) return youtubeId(raw) ? { type: "youtube", url: raw, label, tags } : { type: "url", url: raw, label, tags };
  if (raw === "-") return { type: "text", text: "", label: label ?? "stdin", tags };
  if (/\.(png|jpe?g|webp)$/i.test(raw)) return { type: "image", path: resolve(raw), filename: basename(raw), label, tags };
  return { type: "file", path: resolve(raw), filename: basename(raw), label, tags };
}

/** Reads UTF-8 standard input to completion; rejects on stream failure. */
export async function readStdin() { let s = ""; for await (const chunk of process.stdin) s += chunk; return s; }

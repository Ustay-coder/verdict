import { ValidationError } from "../engine/errors.js";
import { ProviderError } from "../provider-error.js";
import { z } from "zod";
import { fetchWithTimeout } from "./network.js";
import { make } from "./evidence.js";
import type { Ingestor } from "./contracts.js";

/** Returns a recognized YouTube video ID, or null for unsupported URLs. */
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
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new ValidationError(`invalid YouTube video id: ${id}`);
  const warnings: string[] = [];
  // why: unavailable caption tracks still permit metadata-only evaluation; watch transport failures remain explicit.
  const watch = await fetchWithTimeout(f, `https://www.youtube.com/watch?v=${id}&hl=en`, timeoutMs, { headers: { "accept-language": "en-US,en;q=0.9" } });
  const html = watch.ok ? await watch.text() : "";
  const title = decodeXml(/<meta name="title" content="([^"]*)"/.exec(html)?.[1] ?? /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? `YouTube ${id}`);
  const description = decodeXml(/"shortDescription":"((?:[^"\\]|\\.)*)"/.exec(html)?.[1]?.replace(/\\n/g, "\n").replace(/\\"/g, '"') ?? "");
  const tracksJson = /"captionTracks":(\[.*?\])/.exec(html)?.[1];
  let transcript = "";
  if (tracksJson) {
    try {
      const caption = await readCaptionTrack(f, tracksJson, lang, timeoutMs);
      transcript = caption.text;
      if (caption.automatic) warnings.push("transcript is auto-generated (ASR)");
    } catch (e) { warnings.push(`caption parse failed: ${(e as Error).message}`); }
  }
  // why: captions can be disabled or malformed; metadata remains usable with an explicit evidence warning.
  if (!transcript) warnings.push("no transcript available; evaluated on title + description only");
  return { title, description, transcript, warnings };
}

export const youtubeIngestor: Ingestor = async (input, i, o) => {
  if (input.type !== "youtube") throw new ValidationError("expected YouTube input");
  const id = youtubeId(input.url);
  if (!id) throw new ValidationError(`not a YouTube URL: ${input.url}`);
  let title: string | undefined, body: string, warnings: string[] = [];
  const custom = o.youtubeTranscript ? await o.youtubeTranscript(id, input.lang) : null;
  if (custom) { title = custom.title; body = custom.text; }
  else {
    const r = await fetchYoutubeTranscript(o.fetch, id, input.lang, o.timeoutMs);
    title = r.title; warnings = r.warnings;
    body = `# ${r.title}\n\n## Description\n${r.description}\n\n## Transcript\n${r.transcript}`;
  }
  return make(input, i, body, { label: input.label ?? title ?? input.url, source: `https://www.youtube.com/watch?v=${id}`, warnings: warnings.length ? warnings : undefined }, o.maxChars);
};

async function readCaptionTrack(f: typeof fetch, json: string, lang: string | undefined, timeoutMs: number) {
  const tracks = z.array(z.object({ baseUrl: z.string(), languageCode: z.string(), kind: z.string().optional() })).parse(JSON.parse(json));
  // why: honor the requested language first, otherwise prefer human captions over ASR before taking any available track.
  const track = tracks.find(track => lang && track.languageCode === lang) ?? tracks.find(track => track.kind !== "asr") ?? tracks[0];
  if (!track) return { text: "", automatic: false };
  const response = await fetchWithTimeout(f, track.baseUrl.replace(/\\u0026/g, "&"), timeoutMs);
  if (!response.ok) throw new ProviderError("youtube", `caption fetch for ${track.languageCode}: HTTP ${response.status}`, response.status);
  const xml = await response.text();
  const text = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map(captionText).join(" ").replace(/\s+/g, " ").trim();
  return { text, automatic: track.kind === "asr" };
}

function captionText(match: RegExpMatchArray): string {
  // why: captions contain XML entities and inline markup; judges need the visible words alone.
  return decodeXml(match[1]!.replace(/<[^>]+>/g, ""));
}

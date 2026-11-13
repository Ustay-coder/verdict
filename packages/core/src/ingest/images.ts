/**
 * Attaches images to evidence for vision-capable judges.
 * Bytes live in a WeakMap keyed by the evidence object, never on the evidence itself, so a stored evaluation carries
 * only the metadata (format, size, pixel dimensions) and no image data.
 */
import type { Evidence, ImageMeta } from "../schema/subject.js";

const media = new WeakMap<Evidence, string[]>();

/** Data URIs of the images attached to an evidence block; empty when there are none. */
export function evidenceImages(e: Evidence): string[] { return media.get(e) ?? []; }

/** Attaches images to an evidence block: metadata on the evidence, bytes in memory only. Rejects non-image bytes. */
export function attachImages(e: Evidence, images: Array<{ data: Uint8Array; mimeType?: string }>): Evidence {
  const uris: string[] = [];
  const meta: ImageMeta[] = [];
  for (const img of images) {
    const info = imageInfo(img.data);
    if (!info) throw new Error("unsupported image: expected PNG, JPEG or WebP");
    uris.push(`data:${info.mimeType};base64,${toBase64(img.data)}`);
    meta.push(info);
  }
  media.set(e, [...evidenceImages(e), ...uris]);
  e.images = [...(e.images ?? []), ...meta];
  return e;
}

/** Sniffs PNG, JPEG or WebP from the bytes (never the declared type) and reads the pixel size from the header. */
export function imageInfo(buf: Uint8Array): ImageMeta | undefined {
  return pngInfo(buf) ?? jpegInfo(buf) ?? webpInfo(buf);
}

/** One-line description for the evidence text, e.g. "1280×800 PNG". */
export const describeImage = (m: ImageMeta) => `${m.width && m.height ? `${m.width}×${m.height} ` : ""}${m.mimeType.slice(6).toUpperCase()}`;

const byteAt = (b: Uint8Array, i: number) => b[i] ?? 0;
const be16 = (b: Uint8Array, i: number) => (byteAt(b, i) << 8) | byteAt(b, i + 1);
const be32 = (b: Uint8Array, i: number) => ((byteAt(b, i) << 24) >>> 0) + (byteAt(b, i + 1) << 16) + (byteAt(b, i + 2) << 8) + byteAt(b, i + 3);
const le16 = (b: Uint8Array, i: number) => byteAt(b, i) | (byteAt(b, i + 1) << 8);
const le24 = (b: Uint8Array, i: number) => le16(b, i) | (byteAt(b, i + 2) << 16);
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

// PNG: the IHDR chunk always comes first, so width and height sit at fixed offsets.
function pngInfo(b: Uint8Array): ImageMeta | undefined {
  if (ascii(b, 1, 4) !== "PNG" || byteAt(b, 0) !== 0x89) return undefined;
  return { mimeType: "image/png", bytes: b.length, width: be32(b, 16), height: be32(b, 20) };
}

// JPEG: walk the segments to the first start-of-frame marker (C0–CF except DHT C4, JPG C8 and DAC CC).
function jpegInfo(b: Uint8Array): ImageMeta | undefined {
  if (byteAt(b, 0) !== 0xff || byteAt(b, 1) !== 0xd8) return undefined;
  for (let i = 2; i + 9 < b.length;) {
    if (byteAt(b, i) !== 0xff) { i++; continue; }
    const marker = byteAt(b, i + 1);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { mimeType: "image/jpeg", bytes: b.length, height: be16(b, i + 5), width: be16(b, i + 7) };
    i += 2 + be16(b, i + 2);
  }
  return { mimeType: "image/jpeg", bytes: b.length };
}

// WebP: the size lives in a different place for each of the three chunk kinds.
function webpInfo(b: Uint8Array): ImageMeta | undefined {
  if (ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 12) !== "WEBP") return undefined;
  const base = { mimeType: "image/webp" as const, bytes: b.length };
  const chunk = ascii(b, 12, 16);
  if (chunk === "VP8X") return { ...base, width: le24(b, 24) + 1, height: le24(b, 27) + 1 };
  if (chunk === "VP8 ") return { ...base, width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  if (chunk !== "VP8L") return base;
  const bits = (le24(b, 21) | (byteAt(b, 24) << 24)) >>> 0;
  return { ...base, width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
}

// btoa/atob exist on Workers and in Node; Buffer is only a faster path where it exists.
export function toBase64(u8: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(u8).toString("base64");
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Decodes base64 or a `data:` URI to bytes. */
export function fromBase64(b64: string): Uint8Array {
  const raw = b64.replace(/^data:[^;]+;base64,/, "");
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(raw, "base64"));
  return Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
}

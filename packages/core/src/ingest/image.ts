/**
 * Ingests `image` inputs. The evidence text gets a one-line placeholder, so text-only judges know an image exists
 * and what it is; vision-capable judges receive the image itself through `evidenceImages`.
 */
import { FileAccessError } from "../file-error.js";
import { make } from "./evidence.js";
import { attachImages, describeImage, fromBase64, imageInfo } from "./images.js";
import type { Ingestor } from "./contracts.js";

type ImageInput = { path?: string; base64?: string; filename?: string };
type ImageOptions = Parameters<Ingestor>[2];

/** Reads the image bytes and its display name; rejects when neither source is given or local paths are disabled. */
async function readImage(input: ImageInput, options: ImageOptions): Promise<{ bytes: Uint8Array; name: string }> {
  const name = input.filename ?? "";
  if (input.base64) return { bytes: fromBase64(input.base64), name };
  if (!input.path) throw new Error("image input needs `path` or `base64`");
  // Same rule as `file`: multi-tenant servers keep local paths disabled.
  if (!options.allowLocalFiles) throw new Error("local file paths are disabled; send base64 content instead");
  const { readFile } = await import("node:fs/promises");
  const { basename } = await import("node:path");
  try { return { bytes: new Uint8Array(await (options.readFile ?? readFile)(input.path)), name: name || basename(input.path) }; }
  catch (cause) { throw new FileAccessError(input.path, "read", cause); }
}

/** Rejects bytes that are not PNG, JPEG or WebP, whatever `mimeType` claims. */
export const imageIngestor: Ingestor = async (input, index, options) => {
  if (input.type !== "image") throw new Error("bad input");
  const { bytes, name } = await readImage(input, options);
  const info = imageInfo(bytes);
  if (!info) throw new Error(`unsupported image${name ? ` ${name}` : ""}: expected PNG, JPEG or WebP`);
  const label = input.label ?? (name || `image #${index + 1}`);
  const evidence = make(input, index, `[image: ${label}, ${describeImage(info)}; attached for vision-capable judges]`, { label, source: name || undefined }, options.maxChars);
  return attachImages(evidence, [{ data: bytes, mimeType: info.mimeType }]);
};

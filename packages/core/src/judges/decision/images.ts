/**
 * Image limits for vision-capable decision models.
 * Clef (Workers AI model page, verified live 2026-11-05): at most 4 images, embedded PNG/JPEG/WebP data URIs,
 * at most 4 MiB each and 8 MiB per request. Checked before the call so a bad image fails with a clear message.
 */
const MIB = 1024 * 1024;
export const CLEF_LIMITS = { maxImages: 4, maxImageBytes: 4 * MIB, maxTotalBytes: 8 * MIB };

/** Throws a descriptive error when `images` break a Clef limit. */
export function checkClefImages(images: string[]) {
  if (images.length > CLEF_LIMITS.maxImages) throw new Error(`Clef accepts at most ${CLEF_LIMITS.maxImages} images per request (got ${images.length})`);
  let total = 0;
  for (const [i, uri] of images.entries()) {
    if (!/^data:image\/(png|jpeg|webp);base64,/.test(uri)) throw new Error(`image ${i + 1} must be an embedded PNG/JPEG/WebP data URI`);
    const bytes = Math.floor(((uri.length - uri.indexOf(",") - 1) * 3) / 4);
    if (bytes > CLEF_LIMITS.maxImageBytes) throw new Error(`image ${i + 1} is ${(bytes / MIB).toFixed(1)} MiB; Clef allows 4 MiB per image`);
    total += bytes;
  }
  if (total > CLEF_LIMITS.maxTotalBytes) throw new Error(`images total ${(total / MIB).toFixed(1)} MiB; Clef allows 8 MiB per request`);
}

/** Images sent to Clef: any the rubric passes in `options.request.images`, then the evidence's own. */
export function clefImages(extras: Record<string, unknown>, fromEvidence: string[] = []): string[] {
  const configured = Array.isArray(extras.images) ? extras.images.filter((x): x is string => typeof x === "string") : [];
  const images = [...configured, ...fromEvidence];
  checkClefImages(images);
  return images;
}

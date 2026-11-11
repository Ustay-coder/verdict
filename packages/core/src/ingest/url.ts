import { extractFromBuffer, htmlToPlain } from "./extract.js";
import { fetchWithTimeout } from "./network.js";
import { make, stats } from "./evidence.js";
import { attachImages, describeImage } from "./images.js";
import type { Ingestor, IngestOptions } from "./contracts.js";
import type { Evidence, Input } from "../schema/subject.js";

export const urlIngestor: Ingestor = async (input, i, o) => {
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
  return input.screenshot ? attachScreenshot(e, input, o.screenshot) : e;
};

// why: a missing renderer or a failed capture must not lose the page text the other criteria still need.
async function attachScreenshot(e: Evidence, input: Extract<Input, { type: "url" }>, render: IngestOptions["screenshot"]): Promise<Evidence> {
  if (!render) return warn(e, "screenshot requested, but this engine has no screenshot renderer (CLI / MCP with Playwright installed)");
  const so = typeof input.screenshot === "object" ? input.screenshot : {};
  let shot: Awaited<ReturnType<NonNullable<IngestOptions["screenshot"]>>>;
  try { shot = await render(input.url, { width: so.width ?? 1280, height: so.height ?? 800, fullPage: so.fullPage ?? false, settleMs: so.settleMs ?? 1500 }); }
  catch (error) { return warn(e, `screenshot failed: ${error instanceof Error ? error.message : String(error)}`); }
  if (!shot) return warn(e, "no screenshot captured (is Playwright installed?)");
  attachImages(e, [shot]);
  e.text += `\n\n[screenshot of ${input.url} attached: ${describeImage(e.images!.at(-1)!)}]`;
  e.stats = stats(e.text);
  return e;
}

function warn(e: Evidence, message: string): Evidence {
  e.warnings = [...(e.warnings ?? []), message];
  return e;
}

/**
 * Screenshot renderers for `url` inputs with `screenshot` set.
 * Playwright is loaded lazily and only in Node: importing this module never touches it, so core stays Workers-safe.
 * Callers treat a null result or a rejection as "no screenshot" and keep the page text (see url ingestion).
 */
import type { ScreenshotOptions } from "../schema/subject.js";

/** Captures `url`; resolves null when no screenshot could be taken. Rejects when the page cannot be loaded. */
export type ScreenshotRenderer = (url: string, opts: Required<ScreenshotOptions>) => Promise<{ data: Uint8Array; mimeType?: string } | null>;

/** The slice of Playwright this module uses; tests pass a fake through `load`. */
export interface BrowserLauncher { launch(o?: { headless?: boolean }): Promise<Browser> }
interface Browser { newPage(o: { viewport: { width: number; height: number }; deviceScaleFactor: number }): Promise<Page>; close(): Promise<void> }
interface Page { goto(u: string, o: { waitUntil: "networkidle"; timeout: number }): Promise<unknown>; waitForTimeout(ms: number): Promise<void>; screenshot(o: { type: "png"; fullPage: boolean }): Promise<Uint8Array> }

// why: a page that never reaches network idle must not hold the evaluation forever.
const NAVIGATION_TIMEOUT_MS = 20_000;

/** Resolves Playwright's Chromium launcher, or undefined when the package isn't installed. */
export async function loadChromium(): Promise<BrowserLauncher | undefined> {
  try {
    const { createRequire } = await import("node:module");
    const pw: unknown = createRequire(import.meta.url)("playwright");
    return isPlaywright(pw) ? pw.chromium : undefined;
  } catch { return undefined; } // not installed: screenshots are optional
}

function isPlaywright(x: unknown): x is { chromium: BrowserLauncher } {
  return typeof x === "object" && x !== null && "chromium" in x && typeof x.chromium === "object" && x.chromium !== null && "launch" in x.chromium;
}

/** A Chromium-backed renderer, or undefined when no launcher is available. The browser closes even when capture fails. */
export async function playwrightScreenshot(load: () => Promise<BrowserLauncher | undefined> = loadChromium): Promise<ScreenshotRenderer | undefined> {
  const chromium = await load();
  if (!chromium) return undefined;
  return async (url, o) => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: o.width, height: o.height }, deviceScaleFactor: 1 });
      await page.goto(url, { waitUntil: "networkidle", timeout: NAVIGATION_TIMEOUT_MS });
      if (o.settleMs) await page.waitForTimeout(o.settleMs);
      return { data: new Uint8Array(await page.screenshot({ type: "png", fullPage: o.fullPage })), mimeType: "image/png" };
    } finally { await browser.close(); }
  };
}

/** A renderer that loads the launcher on first use (once) and resolves null when it isn't available. */
export function lazyPlaywrightScreenshot(load: () => Promise<BrowserLauncher | undefined> = loadChromium): ScreenshotRenderer {
  let renderer: Promise<ScreenshotRenderer | undefined> | undefined;
  return async (url, o) => {
    const r = await (renderer ??= playwrightScreenshot(load));
    return r ? r(url, o) : null;
  };
}

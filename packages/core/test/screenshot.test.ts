import { describe, expect, it, vi } from "vitest";
import { ingest, lazyPlaywrightScreenshot, playwrightScreenshot, type BrowserLauncher } from "../src/ingest/index.js";

const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEklEQVR4nGKpsXrLAAZMDDAAAAAA//9F4ac5AAAABklEQVQDAB19AapnIGSYAAAAAElFTkSuQmCC", "base64"));
const opts = { width: 1024, height: 700, fullPage: true, settleMs: 300 };

function fakeChromium(screenshot = vi.fn().mockResolvedValue(PNG)) {
  const page = { goto: vi.fn().mockResolvedValue(null), waitForTimeout: vi.fn().mockResolvedValue(undefined), screenshot };
  const browser = { newPage: vi.fn().mockResolvedValue(page), close: vi.fn().mockResolvedValue(undefined) };
  const chromium: BrowserLauncher = { launch: vi.fn().mockResolvedValue(browser) };
  return { chromium, browser, page };
}

describe("screenshot renderers", () => {
  it("captures the page at the requested viewport after it settles, then closes the browser", async () => {
    const { chromium, browser, page } = fakeChromium();
    const render = await playwrightScreenshot(async () => chromium);
    expect(await render!("http://localhost:5173/", opts)).toEqual({ data: PNG, mimeType: "image/png" });
    expect(browser.newPage).toHaveBeenCalledWith({ viewport: { width: 1024, height: 700 }, deviceScaleFactor: 1 });
    expect(page.waitForTimeout).toHaveBeenCalledWith(300);
    expect(page.screenshot).toHaveBeenCalledWith({ type: "png", fullPage: true });
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("closes the browser when capture fails, and is absent without a launcher", async () => {
    const { chromium, browser } = fakeChromium(vi.fn().mockRejectedValue(new Error("crashed")));
    const render = await playwrightScreenshot(async () => chromium);
    await expect(render!("http://x.test/", opts)).rejects.toThrow("crashed");
    expect(browser.close).toHaveBeenCalledOnce();
    expect(await playwrightScreenshot(async () => undefined)).toBeUndefined();
  });

  it("loads the launcher once, lazily, and resolves null when it is missing", async () => {
    const load = vi.fn(async () => fakeChromium().chromium);
    const lazy = lazyPlaywrightScreenshot(load);
    expect(load).not.toHaveBeenCalled();
    await lazy("http://a.test/", opts); await lazy("http://b.test/", opts);
    expect(load).toHaveBeenCalledOnce();
    expect(await lazyPlaywrightScreenshot(async () => undefined)("http://a.test/", opts)).toBeNull();
  });

  it("keeps the page text and records a warning when the screenshot fails", async () => {
    const page = (async () => new Response("<html><body>Revenue</body></html>", { headers: { "content-type": "text/html" } })) as typeof fetch;
    const [e] = await ingest({ inputs: [{ type: "url", url: "http://x.test/", screenshot: true }] }, { fetch: page, screenshot: async () => { throw new Error("net::ERR_NAME_NOT_RESOLVED"); } });
    expect(e!.text).toContain("Revenue");
    expect(e!.images).toBeUndefined();
    expect(e!.warnings).toEqual(["screenshot failed: net::ERR_NAME_NOT_RESOLVED"]);
  });
});

import { describe, expect, it } from "vitest";
import { ingest, youtubeId, htmlToPlain, fetchYoutubeTranscript } from "../src/ingest/index.js";

describe("ingest", () => {
  it("parses youtube ids", () => {
    expect(youtubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youtubeId("https://youtu.be/dQw4w9WgXcQ?t=3")).toBe("dQw4w9WgXcQ");
    expect(youtubeId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youtubeId("https://example.com")).toBeNull();
  });
  it("strips html", () => {
    expect(htmlToPlain("<html><head><script>x()</script></head><body><h1>Hi</h1><p>there <a href='/x'>link</a></p></body></html>")).toMatch(/HI\s+there link/i);
  });
  it("ingests text, json, base64 files and urls via injected fetch", async () => {
    const f: typeof fetch = async (url) => {
      const u = String(url);
      if (u.endsWith(".json")) return new Response(JSON.stringify({ a: 1 }), { headers: { "content-type": "application/json" } });
      return new Response("<html><title>Page</title><body><p>Hello web</p></body></html>", { headers: { "content-type": "text/html" } });
    };
    const ev = await ingest({ inputs: [
      { type: "text", text: "plain" },
      { type: "json", data: { k: [1, 2] } },
      { type: "file", base64: Buffer.from("file body").toString("base64"), filename: "notes.md" },
      { type: "url", url: "https://example.com/page" },
      { type: "url", url: "https://example.com/data.json" },
    ] }, { fetch: f });
    expect(ev[0]!.text).toBe("plain");
    expect(ev[1]!.json).toEqual({ k: [1, 2] });
    expect(ev[2]!.text).toBe("file body");
    expect(ev[2]!.label).toBe("notes.md");
    expect(ev[3]!.label).toBe("Page");
    expect(ev[3]!.text).toContain("Hello web");
    expect(ev[4]!.json).toEqual({ a: 1 });
  });
  it("extracts youtube captions from a watch page", async () => {
    const f: typeof fetch = async (url) => {
      const u = String(url);
      if (u.includes("/watch")) return new Response(`<html><meta name="title" content="My Talk"><script>var x={"shortDescription":"About stuff\\nline2","captionTracks":[{"baseUrl":"https://yt/api/timedtext?v=1\\u0026lang=en","languageCode":"en"}]}</script></html>`);
      return new Response(`<transcript><text start="0">Hello &amp; welcome</text><text start="1">to the <b>show</b></text></transcript>`);
    };
    const r = await fetchYoutubeTranscript(f, "dQw4w9WgXcQ", undefined, 1000);
    expect(r.title).toBe("My Talk");
    expect(r.transcript).toBe("Hello & welcome to the show");
    expect(r.description).toContain("line2");
    expect(r.warnings).toHaveLength(0);
  });
  it("truncates large inputs", async () => {
    const [e] = await ingest({ inputs: [{ type: "text", text: "x".repeat(1000) }] }, { maxChars: 100 });
    expect(e!.truncated).toBe(true);
    expect(e!.text).toHaveLength(100);
  });
});

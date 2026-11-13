import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Engine } from "@verdict-ai/core";
import { registerRun } from "../src/commands/run.js";
import type { VersionDependencies } from "../src/versions/workspace.js";

// The rubric names no model of its own: its decision judge is the default (Jev).
const rubric = `name: Wants a person
criteria:
  - id: wants
    name: Asks for a person
    scale: { type: binary, labels: ["no", "yes"] }
    anchors: { "no": "A question the bot can answer.", "yes": "Asks for an agent or a human." }
`;
const rules = `name: Mentions an agent
criteria:
  - { id: wants, name: Mentions an agent, scale: { type: binary }, judge: { type: benchmark, method: keywords, keywords: [agent] } }
`;
const line = (id: string, text: string, wants: string) => JSON.stringify({ id, name: id, inputs: [{ type: "text", text }], expected: { wants } });
const cases = [line("agent", "connect me to an agent", "yes"), line("human", "is there a human I can talk to", "yes"), line("hours", "what are your opening hours", "no")].join("\n");

interface Sent { url: string; body: { model: string; state: string; questions: Record<string, unknown> } }

/**
 * Two providers that answer over HTTP as the real ones do. "Jev" hears a request for a person in "agent" and
 * "human"; "Clef" only in "agent"; "Clef-flash" is refused. What each was sent is kept.
 */
function setup(files: Array<[string, string]> = [["intent.yaml", rubric], ["rules.yaml", rules], ["cases.jsonl", cases]], reply?: (who: "jev" | "clef") => Record<string, unknown>, ingest?: NonNullable<ConstructorParameters<typeof Engine>[0]>["ingest"]) {
  const sent: Sent[] = [];
  const answer = (body: Sent["body"], words: string[]) => ({ model: body.model === "jev-latest" ? "jev-1.14.0" : body.model, answers: reply ? reply(words.length > 1 ? "jev" : "clef") : Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "noul", noul: words.some((w) => body.state.includes(w)) ? 0.9 : 0.1 }])), usage: { input_tokens: 100, output_tokens: 0 } });
  const net = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), body = JSON.parse(String(init?.body)) as Sent["body"];
    sent.push({ url, body });
    if (url === "https://api.typesafe.ai/v1/systemone") return Response.json(answer(body, ["agent", "human"]));
    if (url.endsWith("/ai/run/@cf/cloudflare/clef")) return Response.json({ success: true, result: answer(body, ["agent"]) });
    // Refused the way providers refuse: a page of indented JSON.
    return new Response(JSON.stringify({ success: false, errors: [{ message: "model not enabled for this account" }] }, null, 2), { status: 403, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const keys: Record<string, string> = { TYPESAFE_API_KEY: "k", CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "t" };
  const engine = new Engine({ fetch: net, env: (name) => keys[name], ...(ingest ? { ingest } : {}) });
  const store = new Map(files.map(([path, text]) => [resolve(path), text]));
  const out = vi.fn(), warn = vi.fn(), exitCode = vi.fn();
  const read = async (p: string) => store.get(resolve(p));
  const deps: VersionDependencies = {
    engine: () => engine, remote: () => undefined, out, fail: vi.fn(), warn, exitCode,
    readText: async (p) => { const t = await read(p); if (t === undefined) throw new Error(`missing ${p}`); return t; },
    readBytes: async (p) => new TextEncoder().encode((await read(p)) ?? ""),
    lockIo: { read, write: async (p, t) => { store.set(resolve(p), t); } },
    writeNew: async (p, t) => { store.set(resolve(p), t); },
  };
  const program = new Command();
  registerRun(program, deps);
  const run = async (...args: string[]) => { out.mockClear(); warn.mockClear(); exitCode.mockClear(); await program.parseAsync(["run", ...args], { from: "user" }); return { out: out.mock.calls.map((c) => String(c[0])), warn: warn.mock.calls.map((c) => String(c[0])) }; };
  return { run, sent, store, engine, exitCode };
}

describe("verdict run --models", () => {
  it("asks each model the same questions and shows them side by side, without touching the rubric", async () => {
    const t = setup();
    const { out, warn } = await t.run("-r", "intent.yaml", "-d", "cases.jsonl", "--models", "jev,clef");
    expect(out[0]).toBe("Wants a person × cases.jsonl: 3 case(s), 2 model(s), the same questions to each");
    const cells = (row: string) => row.trim().split(/ {3,}/);
    expect(cells(out[1]!)).toEqual(["model", "answered by", "agreed with labels", "failed", "asked a human", "input tokens", "calls", "time"]);
    expect(cells(out[2]!).slice(0, 7)).toEqual(["jev", "typesafe/jev-1.14.0", "3/3 (100%)", "0", "0", "300", "3"]);
    expect(cells(out[3]!).slice(0, 7)).toEqual(["clef", "cloudflare/clef", "2/3 (67%)", "0", "0", "300", "3"]);
    expect(out.slice(4)).toEqual([
      "the models gave one answer on 2 of 3 question(s) they all answered; they differ on 1:",
      // The number is the probability each model gave its answer (0.9 for yes, and 1 − 0.1 for no), not its confidence.
      "  human   expected yes   jev yes (0.90) | clef no (0.90)",
    ]);
    expect(warn[0]).toMatch(/^runs: jev run_\w+, clef run_\w+; two of them case by case: verdict diff --base run_\w+ --head run_\w+$/);

    // One request format: each provider got the same questions about the same text, under its own model name.
    const jev = t.sent.filter((s) => s.url.includes("typesafe")), clef = t.sent.filter((s) => s.url.includes("cloudflare"));
    expect(jev.map((s) => s.body.questions)).toEqual(clef.map((s) => s.body.questions));
    expect(jev.map((s) => s.body.state)).toEqual(clef.map((s) => s.body.state));
    expect([jev[0]!.body.model, clef[0]!.body.model]).toEqual(["jev-latest", "clef"]);
    // The file is as it was, nothing was locked, and both runs are kept for later comparison.
    expect(t.store.get(resolve("intent.yaml"))).toBe(rubric);
    expect(t.store.has(resolve("verdict.lock"))).toBe(false);
    const runs = await (t.engine.store as unknown as { listRuns: (q: object) => Promise<Array<{ rubricVersionId: string; fingerprint: { judgmentHash: string; bindingHash: string } }>> }).listRuns({});
    expect(runs).toHaveLength(2);
    // Two versions that ask the same thing of different models.
    expect(new Set(runs.map((r) => r.fingerprint.judgmentHash)).size).toBe(1);
    expect(new Set(runs.map((r) => r.fingerprint.bindingHash)).size).toBe(2);
  });

  it("puts beside each answer the probability the model gave it, whatever the provider calls its confidence", async () => {
    // Three kinds of answer, and two providers that report a confidence of their own that is not that probability.
    const triage = `name: Triage
scale: { type: numeric, min: 0, max: 3 }
criteria:
  - id: team
    name: Team
    choices: { support: "How-to questions.", engineering: "Something is broken." }
  - id: urgency
    name: Urgency
    scale: { type: ordinal, labels: [low, medium, high] }
  - id: severity
    name: Severity
    levels: [{ value: 0, label: none, description: "Nothing broken." }, { value: 1, label: minor, description: "A workaround exists." }, { value: 2, label: major, description: "A feature is down." }, { value: 3, label: outage, description: "Everything is down." }]
`;
    const answers = {
      jev: {
        team: { type: "choice", choice: "engineering", confidence: 0.2, probabilities: { support: 0.4, engineering: 0.6 } },
        urgency: { type: "score", score: 0.2, confidence: 0.7, probabilities: [0.8, 0.2, 0] },
        severity: { type: "score", score: 2.5, confidence: 0.33, probabilities: [0, 0, 0.5, 0.5] },
      },
      clef: {
        team: { type: "choice", choice: "support", confidence: 0.01, probabilities: { support: 0.55, engineering: 0.45 } },
        urgency: { type: "score", score: 1, confidence: 0.51, probabilities: [0.1, 0.8, 0.1] },
        severity: { type: "score", score: 3, confidence: 1, probabilities: [0, 0, 0, 1] },
      },
    };
    const t = setup([["triage.yaml", triage], ["one.jsonl", JSON.stringify({ id: "down", name: "down", inputs: [{ type: "text", text: "checkout is down" }], expected: { team: "engineering" } })]], (who) => answers[who]);
    const { out } = await t.run("-r", "triage.yaml", "-d", "one.jsonl", "--models", "jev,clef");
    expect(out.slice(4)).toEqual([
      "the models gave one answer on 0 of 3 question(s) they all answered; they differ on 3:",
      "  down · team   expected engineering   jev engineering (0.60) | clef support (0.55)",
      "  down · urgency   jev low (0.80) | clef medium (0.80)",
      // 2.5 lies between two levels: the model put no probability on it, so no number is shown.
      "  down · severity   jev 2.5 | clef 3 (1.00)",
    ]);
    const json = JSON.parse((await t.run("-r", "triage.yaml", "-d", "one.jsonl", "--models", "jev,clef", "--json")).out[0]!) as { splits: Array<{ answers: Array<{ probability: number | null; confidence: number | null }> }> };
    // --json keeps both, so nothing a provider said is lost.
    expect(json.splits[0]!.answers).toMatchObject([{ probability: 0.6, confidence: 0.2 }, { probability: 0.55, confidence: 0.01 }]);
    expect(json.splits[2]!.answers).toMatchObject([{ probability: null, confidence: 0.33 }, { probability: 1, confidence: 1 }]);
  });

  it("says how many of the cases' pictures each model was sent, only when the cases carry pictures", async () => {
    const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEklEQVR4nGKpsXrLAAZMDDAAAAAA//9F4ac5AAAABklEQVQDAB19AapnIGSYAAAAAElFTkSuQmCC";
    const withPicture = [
      JSON.stringify({ id: "agent", name: "agent", inputs: [{ type: "text", text: "connect me to an agent" }, { type: "image", base64: PNG, filename: "chat.png" }], expected: { wants: "yes" } }),
      JSON.stringify({ id: "hours", name: "hours", inputs: [{ type: "text", text: "what are your opening hours" }], expected: { wants: "no" } }),
    ].join("\n");
    const t = setup([["intent.yaml", rubric], ["pictures.jsonl", withPicture]]);
    const { out } = await t.run("-r", "intent.yaml", "-d", "pictures.jsonl", "--models", "jev,clef");
    const cells = (row: string) => row.trim().split(/ {3,}/);
    expect(cells(out[1]!)).toEqual(["model", "answered by", "agreed with labels", "failed", "asked a human", "pictures sent", "input tokens", "calls", "time"]);
    // Jev takes text only, so it judged the one picture's case from its text; Clef was sent the picture.
    expect(cells(out[2]!).slice(0, 6)).toEqual(["jev", "typesafe/jev-1.14.0", "2/2 (100%)", "0", "0", "0/1"]);
    expect(cells(out[3]!).slice(0, 6)).toEqual(["clef", "cloudflare/clef", "2/2 (100%)", "0", "0", "1/1"]);
    expect((t.sent.find((s) => s.url.includes("cloudflare")) as unknown as { body: { images: string[] } }).body.images).toEqual([`data:image/png;base64,${PNG}`]);
    expect(t.sent.filter((s) => s.url.includes("typesafe")).every((s) => !("images" in s.body))).toBe(true);
    const json = JSON.parse((await t.run("-r", "intent.yaml", "-d", "pictures.jsonl", "--models", "jev,clef", "--json")).out[0]!) as { models: Array<{ media?: unknown }> };
    expect(json.models.map((m) => m.media)).toEqual([{ pictures: { attached: 1, sent: 0 } }, { pictures: { attached: 1, sent: 1 } }]);
  });

  it("says how many pages of a PDF a model that takes only pictures was sent, and that a text-only model was sent none", async () => {
    const pdf = readFileSync(fileURLToPath(new URL("../../core/test/fixtures/six-pages.pdf", import.meta.url))).toString("base64");
    const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEklEQVR4nGKpsXrLAAZMDDAAAAAA//9F4ac5AAAABklEQVQDAB19AapnIGSYAAAAAElFTkSuQmCC";
    const document = JSON.stringify({ id: "invoice", name: "invoice", inputs: [{ type: "file", base64: pdf, filename: "invoice.pdf" }], expected: { wants: "no" } });
    // A stand-in for the canvas: one small picture for each page asked for.
    const pdfPages = async (_pdf: Uint8Array, pages: number[]) => pages.map(() => ({ data: Uint8Array.from(Buffer.from(PNG, "base64")), mimeType: "image/png" as const }));
    const t = setup([["intent.yaml", rubric], ["documents.jsonl", document]], undefined, { pdfPages });
    const { out } = await t.run("-r", "intent.yaml", "-d", "documents.jsonl", "--models", "jev,clef");
    const cells = (row: string) => row.trim().split(/ {3,}/);
    expect(cells(out[1]!)).toEqual(["model", "answered by", "agreed with labels", "failed", "asked a human", "PDFs sent", "PDF pages sent as pictures", "input tokens", "calls", "time"]);
    // Neither reads PDFs. Jev takes text only; Clef takes four pictures, so it saw four of the six pages.
    expect(cells(out[2]!).slice(5, 7)).toEqual(["0/1", "—"]);
    expect(cells(out[3]!).slice(5, 7)).toEqual(["0/1", "4/6"]);
    expect((t.sent.find((s) => s.url.includes("cloudflare")) as unknown as { body: { images: string[] } }).body.images).toHaveLength(4);
    expect(out.join("\n")).not.toContain("@napi-rs/canvas");

    // With nothing to draw pages, Clef is given the text alone, and the table says what would change that.
    const bare = setup([["intent.yaml", rubric], ["documents.jsonl", document]]);
    const without = (await bare.run("-r", "intent.yaml", "-d", "documents.jsonl", "--models", "jev,clef")).out;
    expect(cells(without[3]!).slice(5, 7)).toEqual(["0/1", "0/6"]);
    expect(without).toContain("  no PDF page was sent as a picture: drawing pages needs @napi-rs/canvas where Verdict runs (npm install -g @napi-rs/canvas)");
  });

  it("prints the same comparison as JSON", async () => {
    const t = setup();
    const { out } = await t.run("-r", "intent.yaml", "-d", "cases.jsonl", "--models", "jev,clef", "--json");
    expect(JSON.parse(out[0]!)).toMatchObject({
      rubric: "Wants a person", cases: 3, sameQuestions: true, answered: 3, unanimous: 2,
      models: [{ label: "jev", labelled: { n: 3, agreed: 3, agreement: 1 } }, { label: "clef", labelled: { n: 3, agreed: 2 } }],
      splits: [{ caseId: "human", criterionId: "wants", expected: { answer: 1, shown: "yes" }, answers: [{ label: "jev", answer: 1, shown: "yes", probability: 0.9, confidence: 0.8 }, { label: "clef", answer: 0, shown: "no", probability: 0.9, confidence: 0.8 }] }],
    });
  });

  it("gives a model that could not answer a row with the reason, and keeps it out of the disagreements", async () => {
    const t = setup();
    const { out, warn } = await t.run("-r", "intent.yaml", "-d", "cases.jsonl", "--models", "jev,clef-flash");
    expect(out[0]).toContain("2 model(s), the same questions to each");
    expect(out[3]).toMatch(/^ {2}clef-flash {3}— {3,}— {3,}3 /);
    // One line, whatever the provider sent back.
    expect(out[4]).toMatch(/^ {2}clef-flash failed: cloudflare: decide: HTTP 403: .*model not enabled for this account/);
    expect(out[4]).not.toContain("\n");
    expect(out).toHaveLength(5);
    expect(warn[0]).not.toContain("verdict diff");
    expect(t.exitCode).not.toHaveBeenCalled();
    // When nothing answered at all, the shell is told.
    await t.run("-r", "intent.yaml", "-d", "cases.jsonl", "--models", "clef-flash");
    expect(t.exitCode).toHaveBeenCalledWith(1);
  });

  it("takes a provider and model by name, and refuses what it cannot compare", async () => {
    const t = setup();
    const named = await t.run("-r", "intent.yaml", "-d", "cases.jsonl", "--models", "typesafe:jev-1.14.0,cloudflare:@cf/cloudflare/clef");
    expect(named.out[2]).toMatch(/^ {2}typesafe:jev-1\.14\.0 /);
    expect(t.sent.filter((s) => s.url.includes("typesafe"))[0]!.body.model).toBe("jev-1.14.0");
    const refuse = (...args: string[]) => expect(t.run("-r", "intent.yaml", "-d", "cases.jsonl", ...args)).rejects;
    await refuse("--models", "gpt").toThrow('--models "gpt": use jev, jev-preview, clef, clef-flash, gemini, or provider:model with one of typesafe, cloudflare, openrouter, openai, gemini, systemone, mock');
    await refuse("--models", "jev,jev").toThrow("jev is named twice");
    await refuse("--models", " , ").toThrow("name at least one model");
    await refuse("--models", "jev", "--mock").toThrow("--mock and --models both say who answers");
    await refuse("--models", "jev", "--report").toThrow("--models compares models and reports nothing");
    await expect(t.run("-r", "rules.yaml", "-d", "cases.jsonl", "--models", "jev,clef")).rejects.toThrow("rules.yaml asks no decision model");
  });
});

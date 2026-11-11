import { describe, expect, it, vi } from "vitest";
import { Engine } from "@verdict-ai/core";
import { watchState } from "../src/watch/state.js";
import { watchPage } from "../src/watch/page.js";

const rubric = { name: "Keywords", criteria: [
  { id: "a", name: "Mentions alpha", judge: { type: "benchmark", method: "keywords", keywords: ["alpha"] } },
  { id: "b", name: "Mentions beta", judge: { type: "benchmark", method: "keywords", keywords: ["beta"] } },
] } as const;

describe("watchState", () => {
  it("is empty without evaluations", () => {
    expect(watchState([])).toMatchObject({ view: "empty", entries: [], running: 0 });
  });

  it("shows the latest evaluation with the previous one of the same rubric and the score history", async () => {
    const engine = new Engine();
    await engine.evaluate({ rubric, subject: { name: "draft", inputs: [{ type: "text", text: "gamma\nalpha" }] } });
    await new Promise((r) => setTimeout(r, 5));
    await engine.evaluate({ rubric, subject: { name: "draft", inputs: [{ type: "text", text: "gamma\nalpha beta" }] } });
    const s = watchState(await engine.store.listEvaluations());
    expect(s.view).toBe("single");
    expect(s.entries[0]!.evidence[0]!.text).toBe("gamma\nalpha beta");
    expect(s.previous!.evidence[0]!.text).toBe("gamma\nalpha");
    expect(s.history.map((h) => h.score)).toEqual([50, 100]);
    expect(s.entries[0]!.criteria.map((c) => c.normalized)).toEqual([1, 1]);
  });

  it("shows a batch as a leaderboard and re-ranks it after re-aggregation", async () => {
    const engine = new Engine();
    const { evaluations } = await engine.evaluateBatch({ ...rubric, criteria: [{ ...rubric.criteria[0], weight: 3 }, rubric.criteria[1]] }, [
      { name: "beta only", inputs: [{ type: "text", text: "beta" }] },
      { name: "alpha only", inputs: [{ type: "text", text: "alpha" }] },
    ]);
    let s = watchState(await engine.store.listEvaluations());
    expect(s.view).toBe("leaderboard");
    expect(s.entries.map((e) => e.name)).toEqual(["alpha only", "beta only"]);
    await new Promise((r) => setTimeout(r, 5));
    // Weight beta instead: same ratings, no judges called, new order.
    for (const ev of evaluations) await engine.reaggregate(ev.id, { method: "formula", formula: "b_n" });
    s = watchState(await engine.store.listEvaluations());
    expect(s.aggregation).toEqual({ method: "formula", formula: "b_n" });
    expect(s.entries.map((e) => e.name)).toEqual(["beta only", "alpha only"]);
  });

  it("shows each entry's score in every round and how far it moved since the previous round", async () => {
    const engine = new Engine();
    const subjects = (x: string) => [{ name: "x", inputs: [{ type: "text" as const, text: x }] }, { name: "y", inputs: [{ type: "text" as const, text: "alpha" }] }];
    await engine.evaluateBatch(rubric, subjects("gamma"));
    await new Promise((r) => setTimeout(r, 5));
    let s = watchState(await engine.store.listEvaluations());
    expect(s.round).toBe(1);
    expect(s.entries.map((e) => e.rounds)).toEqual([undefined, undefined]);
    await engine.evaluateBatch(rubric, subjects("alpha beta")); // x improves and overtakes y
    s = watchState(await engine.store.listEvaluations());
    expect(s.round).toBe(2);
    expect(s.entries.map((e) => [e.name, e.rounds, e.prevRank])).toEqual([["x", [0, 100], 2], ["y", [50, 50], 1]]);
    expect(watchPage()).toContain("lhist");
  });

  it("keeps the last finished result while a new evaluation runs", async () => {
    const engine = new Engine();
    const done = await engine.evaluate({ rubric, subject: { inputs: [{ type: "text", text: "alpha" }] } });
    const running = { ...structuredClone(done), id: "eval_running", status: "running" as const, updatedAt: new Date(Date.now() + 1000).toISOString() };
    const s = watchState([done, running]);
    expect(s.entries[0]!.id).toBe(done.id);
    expect(s.running).toBe(1);
  });

  it("keeps the previous batch on screen until a new batch has finished", async () => {
    const engine = new Engine();
    const first = await engine.evaluateBatch(rubric, [{ name: "x", inputs: [{ type: "text", text: "alpha" }] }, { name: "y", inputs: [{ type: "text", text: "beta" }] }]);
    const second = await engine.evaluateBatch(rubric, [{ name: "x", inputs: [{ type: "text", text: "alpha beta" }] }, { name: "y", inputs: [{ type: "text", text: "beta" }] }]);
    const later = (e: (typeof second.evaluations)[number], ms: number, status = e.status) => ({ ...e, status, updatedAt: new Date(Date.now() + ms).toISOString() });
    const partial = [...first.evaluations, later(second.evaluations[0]!, 1000), later(second.evaluations[1]!, 1000, "running")];
    expect(new Set(watchState(partial).entries.map((e) => e.id))).toEqual(new Set(first.evaluations.map((e) => e.id)));
    const done = [...first.evaluations, later(second.evaluations[0]!, 1000), later(second.evaluations[1]!, 2000)];
    expect(new Set(watchState(done).entries.map((e) => e.id))).toEqual(new Set(second.evaluations.map((e) => e.id)));
  });

  it("surfaces failed gates", async () => {
    const engine = new Engine();
    await engine.evaluate({ rubric: { ...rubric, aggregation: { gates: [{ criterion: "b", min: 1, message: "beta is required" }] } }, subject: { inputs: [{ type: "text", text: "alpha" }] } });
    const s = watchState(await engine.store.listEvaluations());
    expect(s.entries[0]!.gatesFailed).toEqual(["beta is required"]);
    expect(s.entries[0]!.criteria.find((c) => c.id === "b")!.gateFailed).toBe("beta is required");
  });

  it("serves a self-contained page", () => {
    const html = watchPage("/tmp/x/.verdict");
    expect(html).toContain("/api/state");
    expect(html).not.toMatch(/<script src=|<link /);
  });
});

describe("watch server and command", () => {
  it("serves the page and the state, answers 404 elsewhere and 500 when the store fails", async () => {
    const { createWatchServer } = await import("../src/commands/watch.js");
    const { MemoryStore } = await import("@verdict-ai/core");
    const broken = { ...new MemoryStore(), listEvaluations: async () => { throw new Error("disk gone"); } };
    for (const [store, path, status, body] of [
      [new MemoryStore(), "/", 200, "verdict watch"], [new MemoryStore(), "/api/state", 200, '"view":"empty"'],
      [new MemoryStore(), "/nope", 404, ""], [broken, "/api/state", 500, "disk gone"],
      [new MemoryStore(), "/compare?base=x", 200, "startCompare();"], [new MemoryStore(), "/api/compare", 200, '"notice":"No runs yet'],
    ] as const) {
      const server = createWatchServer(store as never, "/data/<x>");
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const { port } = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      expect(res.status).toBe(status);
      const text = await res.text();
      expect(text).toContain(body);
      if (path === "/") expect(text).toContain("/data/x");
      await new Promise((r) => server.close(r));
    }
  });

  it("starts on the given host and port and says where it reads from", async () => {
    const { registerWatch } = await import("../src/commands/watch.js");
    const { MemoryStore } = await import("@verdict-ai/core");
    const { Command } = await import("commander");
    const out = vi.fn(), listen = vi.fn().mockResolvedValue(undefined);
    const program = new Command();
    registerWatch(program, { out, store: () => new MemoryStore(), directory: () => "/data", listen });
    await program.parseAsync(["watch", "-p", "4700"], { from: "user" });
    expect(listen).toHaveBeenCalledWith(expect.anything(), 4700, "127.0.0.1");
    expect(out).toHaveBeenCalledWith("verdict watch on http://127.0.0.1:4700/  (reading /data)");
  });
});

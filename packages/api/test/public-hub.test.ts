import { describe, expect, it } from "vitest";
import { createDatasetVersion, Engine, freezeRubric, MemoryStore, runCases, type RubricVersion } from "@verdict-ai/core";
import { createApp, envAuth } from "../src/app.js";

const base = { defaultJudge: { type: "decision", provider: "mock" }, metadata: { domain: "customer_support", locale: "ko-KR" } };
const criterion = { id: "wants", name: "고객이 상담원과 직접 대화하려고 하는가", scale: { type: "binary", labels: ["no", "yes"] }, threshold: 0.6, anchors: { yes: "현재의 연결 요청", no: "과거 경험만 설명" } };
const caseOf = (id: string, text: string) => ({ id, name: id, inputs: [{ type: "text", text }], expected: { wants: "yes" }, visibility: "public", labelSource: "human" });

async function setup() {
  const store = new MemoryStore();
  let clock = Date.parse("2026-11-08T00:00:00.000Z");
  const app = createApp({ engine: new Engine({ store }), auth: envAuth({ VERDICT_API_KEYS: "ka:alice,kb:bob" }), now: () => (clock += 1000) });
  const call = (path: string, init: RequestInit = {}, key?: string) => app.request(`http://hub.test${path}`, { ...init, headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) } });
  const publish = async (key: string, slug: string, v: RubricVersion, extra: Record<string, unknown> = {}) => {
    const res = await call("/v1/publications", { method: "POST", body: JSON.stringify({ slug, version: { id: v.id, rubric: v.rubric, ...(v.parentVersionId ? { parentVersionId: v.parentVersionId, fork: v.fork } : {}) }, license: "CC-BY-4.0", ...extra }) }, key);
    expect(res.status).toBe(201);
    return ((await res.json()) as { publication: { id: string } }).publication.id;
  };
  return { call, publish, store };
}

async function published() {
  const t = await setup();
  const v1 = await freezeRubric({ ...base, name: "상담원 연결 요청", criteria: [criterion] });
  const v2 = await freezeRubric({ ...base, name: "상담원 연결 요청", criteria: [{ ...criterion, description: "완곡한 요청 포함" }] }, { parent: v1, note: "완곡한 표현" });
  const xss = await freezeRubric({ ...base, name: "<script>alert(1)</script> 긴급도", metadata: { domain: "documents" }, criteria: [{ ...criterion, id: "urgent", name: "긴급한가" }] });
  const p1 = await t.publish("ka", "agent", v1, { cases: [caseOf("c1", "상담원 연결해 주세요")] });
  const p2 = await t.publish("ka", "agent", v2, { cases: [caseOf("c1", "상담원 연결해 주세요"), caseOf("c2", "사람이랑 얘기하고 싶어요")] });
  const fork = await freezeRubric({ ...base, name: "Bob의 상담원 연결", criteria: [{ ...criterion, threshold: 0.7 }] }, { parent: v2 });
  const pb = await t.publish("kb", "agent-strict", fork);
  const px = await t.publish("kb", "urgency", xss);
  return { ...t, v1, v2, fork, p1, p2, pb, px };
}

describe("public hub reads", () => {
  it("searches without a key, one result per card at its newest version, and never shows the publishing tenant", async () => {
    const t = await published();
    const res = await t.call("/v1/public/rubrics");
    expect(res.status).toBe(200);
    const { data } = await res.json() as { data: Array<{ ref: string; latest: { versionId: string }; cases: number; parent?: unknown }> };
    expect(data.map((d) => d.ref)).toEqual(["bob/urgency", "bob/agent-strict", "alice/agent"]);
    expect(data.find((d) => d.ref === "alice/agent")).toMatchObject({ latest: { versionId: t.v2.id }, cases: 2, parent: { public: true, ref: "alice/agent", versionId: t.v1.id } });
    expect(data.find((d) => d.ref === "bob/agent-strict")!.parent).toMatchObject({ public: true, ref: "alice/agent", versionId: t.v2.id });
    expect(JSON.stringify(data)).not.toMatch(/tenantId|"alice"\s*,\s*"tenant/);

    const refs = async (query: string) => ((await (await t.call(`/v1/public/rubrics?${query}`)).json()) as { data: Array<{ ref: string }> }).data.map((d) => d.ref);
    expect(await refs("q=%EC%83%81%EB%8B%B4%EC%9B%90")).toEqual(["bob/agent-strict", "alice/agent"]);
    expect(await refs("domain=documents")).toEqual(["bob/urgency"]);
    expect(await refs("owner=alice&type=noul")).toEqual(["alice/agent"]);
    expect(await refs("type=score")).toEqual([]);
    expect(await refs("limit=1")).toEqual(["bob/urgency"]);
    expect((await t.call("/v1/public/rubrics?limit=500")).status).toBe(400);
  });

  it("reads a card at its newest live version or any version, with the history, and says when a version was withdrawn", async () => {
    const t = await published();
    const card = async (q = "") => t.call(`/v1/public/rubrics/alice/agent${q}`);
    const latest = await (await card()).json() as { publication: Record<string, unknown> & { version: { id: string; changeKinds: string[]; forkNote: string } }; versions: Array<{ versionId: string }> };
    expect(latest.publication.version).toMatchObject({ id: t.v2.id, changeKinds: ["question_text"], forkNote: "완곡한 표현" });
    expect(latest.publication).not.toHaveProperty("tenantId");
    expect(latest.versions.map((v) => v.versionId)).toEqual([t.v2.id, t.v1.id]);
    expect((await (await card(`?version=${t.v1.id}`)).json() as typeof latest).publication.version.id).toBe(t.v1.id);

    expect((await t.call(`/v1/publications/${t.p2}`, { method: "DELETE" }, "ka")).status).toBe(204);
    expect((await (await card()).json() as typeof latest).publication.version.id).toBe(t.v1.id);
    const gone = await card(`?version=${t.v2.id}`);
    expect(gone.status).toBe(410);
    expect(await gone.json()).toMatchObject({ error: { type: "withdrawn", message: expect.stringMatching(/was withdrawn on 2026-11-08; copies people already pulled or forked remain theirs/) } });
    expect((await (await card()).json() as { versions: Array<{ versionId: string; withdrawnAt?: string }> }).versions[0]).toMatchObject({ versionId: t.v2.id, withdrawnAt: expect.any(String) });
    expect((await t.call(`/v1/public/publications/${t.p2}`)).status).toBe(410);
    expect(await (await t.call(`/v1/public/publications/${t.p1}`)).json()).not.toHaveProperty("tenantId");
    // Withdrawn versions leave search; the card stays findable through its live version.
    expect(((await (await t.call("/v1/public/rubrics?owner=alice")).json()) as { data: Array<{ latest: { versionId: string } }> }).data[0]!.latest.versionId).toBe(t.v1.id);

    expect((await t.call("/v1/public/rubrics/alice/nope")).status).toBe(404);
    expect((await card("?version=rv_00000000000000000000")).status).toBe(404);
    expect((await t.call("/v1/public/publications/pub_nope")).status).toBe(404);
  });

  it("opens only the public paths: tenant routes still need a key", async () => {
    const t = await published();
    for (const path of ["/v1/publications", "/v1/rubrics", "/v1/evaluations", "/v1/hub/me", "/v1/publicx/rubrics"]) expect((await t.call(path)).status).toBe(401);
  });
});

describe("hub pages", () => {
  it("lists cards, escapes what authors wrote and loads no scripts", async () => {
    const t = await published();
    const res = await t.call("/hub?q=%3Cscript%3E");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(res.headers.get("content-security-policy")).toMatch(/default-src 'none'/);
    const page = await res.text();
    expect(page).toContain("&#60;script&#62;alert(1)&#60;/script&#62; 긴급도");
    expect(page).not.toContain("<script>");
    expect(page).toContain('href="/hub/bob/urgency"');
    expect(await (await t.call("/hub?type=bogus")).text()).toContain("bob/agent-strict");
  });

  it("shows a card with copyable pull and fork commands, its lineage, cases, versions and rubric", async () => {
    const t = await published();
    const page = await (await t.call("/hub/bob/agent-strict")).text();
    expect(page).toContain(`verdict pull hub:bob/agent-strict@${t.fork.id} --hub http://hub.test`);
    expect(page).toContain(`verdict fork hub:bob/agent-strict@${t.fork.id} --to agent-strict.yaml --hub http://hub.test`);
    expect(page).toContain(`Forked from <a href="/hub/alice/agent?version=${t.v2.id}">alice/agent</a>`);
    expect(page).toContain("at least 0.7");
    expect(page).toContain("The author attached no runs.");
    expect(page).not.toMatch(/tenant|\bkb\b/);
    const alice = await (await t.call("/hub/alice/agent")).text();
    expect(alice).toContain("사람이랑 얘기하고 싶어요");
    expect(alice).toContain(`<a href="/hub/alice/agent?version=${t.v1.id}">${t.v1.id}</a>`);
    expect(alice).toContain("threshold: 0.6");
  });

  it("leads a reported run with its agreement on the card's question, not the 0-of-0 pass/fail tally", async () => {
    const t = await setup();
    const v = await freezeRubric({ ...base, name: "Agent", defaultJudge: { type: "decision", provider: "mock", options: { noul: 0.9 } }, criteria: [criterion] });
    const cases = [caseOf("a", "상담원 연결"), caseOf("b", "사람과 통화"), { ...caseOf("c", "어제 통화함"), expected: { wants: "no" } }];
    const { run, report } = await runCases(new Engine(), v, await createDatasetVersion(cases));
    await t.publish("ka", "with-run", v, { cases, runs: [{ run, report }] });
    const page = await (await t.call("/hub/alice/with-run")).text();
    expect(report.decided).toBe(0);
    expect(page).toContain("<strong>67%</strong> agreement with the labels (2 of 3 labelled case(s)) over 3 case(s)");
    expect(page).toContain("Every case of this run is public: anyone can repeat it.");
  });

  it("answers 410 for a withdrawn version and 404 for an unknown card", async () => {
    const t = await published();
    await t.call(`/v1/publications/${t.pb}`, { method: "DELETE" }, "kb");
    const gone = await t.call("/hub/bob/agent-strict");
    expect(gone.status).toBe(410);
    expect(await gone.text()).toMatch(/was withdrawn on 2026-11-08; copies people already pulled or forked remain theirs/);
    expect((await t.call("/hub/nobody/nothing")).status).toBe(404);
  });
});

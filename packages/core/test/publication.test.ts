import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPublication, createDatasetVersion, Engine, FileStore, formatHubRef, freezeRubric, GoldItem as GoldItemSchema, hasPublications, hasPublishers, latestPerRef, listingOf, MemoryStore, parseGoldSet, parseHubRef, publicView, runCases, toGoldItem, verifyPublishedVersion, withdrawalNote,
  type GoldItem, type Publication, type PublicationRequest, type RubricVersion,
} from "../src/index.js";

// The design doc's example card: one yes/no question with an explicit threshold.
const card = {
  name: "한국어 상담원 연결 요청 판별",
  metadata: { domain: "customer_support", locale: "ko-KR" },
  defaultJudge: { type: "decision", provider: "mock" },
  criteria: [{ id: "wants_agent", name: "고객이 현재 상담원과 직접 대화하려고 하는가", scale: { type: "binary", labels: ["no", "yes"] }, threshold: 0.6 }],
};
const pub = (id: string, text: string, extra: Partial<GoldItem> = {}): GoldItem => ({ id, name: id, inputs: [{ type: "text", text }], expected: { wants_agent: "yes" }, visibility: "public", labelSource: "human", ...extra });

async function request(overrides: Partial<PublicationRequest> = {}, version?: RubricVersion): Promise<PublicationRequest> {
  const v = version ?? (await freezeRubric(card));
  return { slug: "agent-intent-ko", version: { id: v.id, rubric: v.rubric }, license: "CC-BY-4.0", cases: [pub("c1", "상담원 연결해 주세요.")], ...overrides };
}

const issuesOf = async (req: unknown) => (await buildPublication(req, { owner: "alice" })).issues.map((i) => `${i.path}: ${i.message}`);

describe("buildPublication", () => {
  it("builds the public document from what the author chose, with search fields taken from the rubric", async () => {
    const result = await buildPublication(await request(), { owner: "alice", tenantId: "t1" });
    expect(result).toMatchObject({ ok: true, issues: [], warnings: [] });
    expect(result.publication).toMatchObject({
      owner: "alice", slug: "agent-intent-ko", ref: "alice/agent-intent-ko", tenantId: "t1",
      title: "한국어 상담원 연결 요청 판별", domain: "customer_support", locale: "ko-KR", judgmentType: "noul", license: "CC-BY-4.0",
      cases: [{ id: "c1", name: "c1", inputs: [{ type: "text", text: "상담원 연결해 주세요." }], expected: { wants_agent: "yes" }, labelSource: "human" }],
      runs: [],
    });
    expect(result.publication!.version.id).toMatch(/^rv_/);
    expect(result.publication).not.toHaveProperty("parent");
  });

  it("rejects what the hub does not publish, each with its path", async () => {
    const two = await freezeRubric({ ...card, criteria: [...card.criteria, { id: "urgent", name: "Urgent", scale: { type: "binary" }, threshold: 0.5 }] });
    const noThreshold = await freezeRubric({ ...card, criteria: [{ ...card.criteria[0], threshold: undefined }] });
    const endpoint = await freezeRubric({ ...card, defaultJudge: { type: "decision", provider: "systemone", baseUrl: "https://decide.internal.example/v1" } });
    expect(await issuesOf({ ...(await request()), version: { id: "rv_wrong", rubric: card } })).toEqual([expect.stringMatching(/^version\.id: the rubric freezes to rv_\w+, not rv_wrong$/)]);
    expect(await issuesOf(await request({}, two))).toEqual(["version.rubric.criteria: the hub publishes single-question cards: exactly 1 criterion, got 2"]);
    expect(await issuesOf(await request({}, noThreshold))).toEqual(["version.rubric.criteria.0.threshold: a yes/no criterion needs an explicit threshold to be published"]);
    expect(await issuesOf(await request({}, endpoint))).toEqual(["version.rubric.defaultJudge.baseUrl: remove baseUrl (https://decide.internal.example/v1) before publishing: endpoints, possibly internal, would become public"]);
    expect(await issuesOf(await request({ license: "proprietary" }))).toEqual([expect.stringMatching(/^license: choose a licence: CC-BY-4.0, /)]);
    expect(await issuesOf(await request({ slug: "Not A Slug" }))).toEqual([expect.stringMatching(/^slug: slug: lowercase letters/)]);
  });

  it("publishes only cases marked public, with text, json or url inputs", async () => {
    const issues = await issuesOf(await request({ cases: [pub("p", "ok"), pub("private", "secret", { visibility: "private" }), { ...pub("f", ""), inputs: [{ type: "file", path: "/home/me/tickets.csv" }] }] }));
    expect(issues).toEqual([
      "cases.1.visibility: case private is not marked public; set visibility: public to publish it",
      "cases.2.inputs.0: file inputs cannot be published (text, json and url can)",
    ]);
  });

  it("asks the author to look again at personal-looking data and unreviewed labels, without blocking", async () => {
    const result = await buildPublication(await request({ cases: [pub("mail", "kim@example.com 으로 연락 주세요"), pub("phone", "010-1234-5678 로 전화"), pub("ai", "연결", { labelSource: "ai_unreviewed" })] }), { owner: "alice" });
    expect(result.ok).toBe(true);
    expect(result.warnings.map((w) => w.message)).toEqual([
      "case mail looks like it contains an e-mail address; make sure it may be public",
      "case phone looks like it contains a phone number; make sure it may be public",
      "case ai: its label is shown as ai_unreviewed (not reviewed by a person)",
    ]);
  });

  it("keeps only the numbers of attached runs, says whether anyone can repeat them, and refuses runs of other versions", async () => {
    const version = await freezeRubric(card);
    const cases = [pub("c1", "상담원 연결해 주세요."), pub("private-case-kim", "어제 상담원과 통화했어요", { expected: { wants_agent: "no" }, visibility: "private", labelSource: "human" })];
    const { run, report } = await runCases(new Engine(), version, await createDatasetVersion(cases));
    const result = await buildPublication(await request({ cases: [cases[0]!], runs: [{ run, report }] }, version), { owner: "alice" });
    expect(result.ok).toBe(true);
    const summary = result.publication!.runs[0]!;
    expect(summary).toMatchObject({ runId: run.id, origin: "author_reported", casesPublic: false, counts: { cases: 2 }, agreement: { criteria: { wants_agent: { n: 2 } } } });
    const text = JSON.stringify(summary);
    for (const leak of ["private-case-kim", "어제", run.cases[1]!.evaluationId, "preview"]) expect(text).not.toContain(leak);

    const other = await freezeRubric({ ...card, name: "Other" });
    expect(await issuesOf(await request({ runs: [{ run, report }] }, other))).toEqual([`runs.0.run.rubricVersionId: run ${run.id} is of ${version.id}; only runs of the published version can be attached`]);
  });

  it("links a published parent and only mentions an unpublished one", async () => {
    const parent = await freezeRubric(card);
    const child = await freezeRubric({ ...card, criteria: [{ ...card.criteria[0], description: "완곡한 요청 포함" }] }, { parent });
    const req = await request({}, child);
    req.version = { id: child.id, rubric: child.rubric, parentVersionId: parent.id, fork: child.fork };
    const linked = await buildPublication(req, { owner: "bob", findParent: async (id) => (id === parent.id ? { id: "pub_1", ref: "alice/agent-intent-ko" } : undefined) });
    expect(linked.publication).toMatchObject({ parent: { public: true, versionId: parent.id, publicationId: "pub_1", ref: "alice/agent-intent-ko" }, version: { changeKinds: ["question_text"] } });
    const hidden = await buildPublication(req, { owner: "bob", findParent: async () => undefined });
    expect(hidden.publication!.parent).toEqual({ public: false });
    expect(JSON.stringify(hidden.publication!.parent)).not.toContain(parent.id);
  });
});

describe("publication stores", () => {
  const roundTrip = async (store: MemoryStore | FileStore) => {
    expect(hasPublications(store)).toBe(true);
    const draft = (await buildPublication(await request(), { owner: "alice", tenantId: "t1" })).publication!;
    const p: Publication = { ...draft, id: "pub_a", createdAt: "2026-11-08T00:00:00.000Z" };
    const other: Publication = { ...draft, id: "pub_b", owner: "bob", ref: "bob/agent-intent-ko", tenantId: "t2", domain: "documents", createdAt: "2026-11-08T00:00:01.000Z" };
    await store.putPublication(p); await store.putPublication(other);
    expect((await store.getPublication("pub_a"))?.ref).toBe("alice/agent-intent-ko");
    expect((await store.listPublications()).map((x) => x.id)).toEqual(["pub_b", "pub_a"]);
    expect((await store.listPublications({ q: "상담원" })).map((x) => x.id)).toEqual(["pub_b", "pub_a"]);
    expect((await store.listPublications({ q: "BOB" })).map((x) => x.id)).toEqual(["pub_b"]);
    expect((await store.listPublications({ domain: "customer_support" })).map((x) => x.id)).toEqual(["pub_a"]);
    expect(await store.withdrawPublication("pub_a", "t2", "2026-11-09T00:00:00.000Z")).toBe(false);
    expect(await store.withdrawPublication("pub_a", "t1", "2026-11-09T00:00:00.000Z")).toBe(true);
    expect((await store.listPublications()).map((x) => x.id)).toEqual(["pub_b"]);
    expect((await store.listPublications({ tenantId: "t1", includeWithdrawn: true }))[0]).toMatchObject({ id: "pub_a", withdrawnAt: "2026-11-09T00:00:00.000Z" });
  };
  it("work in memory", () => roundTrip(new MemoryStore()));
  it("work as JSON files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verdict-pub-"));
    try { await roundTrip(new FileStore(dir)); } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("publishers and gold items", () => {
  const roundTrip = async (store: MemoryStore | FileStore) => {
    expect(hasPublishers(store)).toBe(true);
    await store.putPublisher({ tenantId: "gh:42", githubId: 42, login: "alice", createdAt: "a", updatedAt: "a" });
    await store.putPublisher({ tenantId: "gh:42", githubId: 42, login: "alice-renamed", createdAt: "a", updatedAt: "b" });
    expect(await store.getPublisher("gh:42")).toEqual({ tenantId: "gh:42", githubId: 42, login: "alice-renamed", createdAt: "a", updatedAt: "b" });
    expect(await store.getPublisher("gh:43")).toBeUndefined();
  };
  it("keep publishers in memory", () => roundTrip(new MemoryStore()));
  it("keep publishers as JSON files named by a hash of the tenant", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verdict-publisher-"));
    try { await roundTrip(new FileStore(dir)); } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("turn a labelled case back into a gold item a request accepts", () => {
    const [labelled] = parseGoldSet(JSON.stringify([{ id: "a", name: "a", inputs: [{ type: "text", text: "x" }], expected: { q: "yes" }, human: { passed: true } }]));
    const item = toGoldItem(labelled!);
    expect(item).toEqual({ id: "a", name: "a", inputs: [{ type: "text", text: "x" }], expected: { q: "yes" }, human: { passed: true } });
    expect(GoldItemSchema.safeParse(item).success).toBe(true);
    expect(GoldItemSchema.safeParse(labelled).success).toBe(false);
  });
});

describe("public views", () => {
  it("parse and print hub references", () => {
    expect(parseHubRef("hub:alice/agent-intent-ko")).toEqual({ owner: "alice", slug: "agent-intent-ko" });
    expect(parseHubRef("hub:Team.A/x@rv_0123456789abcdef0123")).toEqual({ owner: "Team.A", slug: "x", versionId: "rv_0123456789abcdef0123" });
    expect(formatHubRef({ owner: "a", slug: "b", versionId: "rv_1" })).toBe("hub:a/b@rv_1");
    for (const bad of ["alice/x", "hub:alice", "hub:alice/X", "hub:alice/x@v2", "hub:../x"]) expect(() => parseHubRef(bad)).toThrow(/not a hub reference/);
  });

  it("drop the publishing tenant and keep the newest version of each card", async () => {
    const draft = (await buildPublication(await request(), { owner: "alice", tenantId: "t1" })).publication!;
    const newer: Publication = { ...draft, id: "pub_2", createdAt: "2026-11-08T00:00:02.000Z" };
    const older: Publication = { ...draft, id: "pub_1", createdAt: "2026-11-08T00:00:01.000Z" };
    const other: Publication = { ...draft, id: "pub_3", ref: "bob/x", owner: "bob", slug: "x", createdAt: "2026-11-08T00:00:00.000Z" };
    expect(latestPerRef([newer, older, other]).map((p) => p.id)).toEqual(["pub_2", "pub_3"]);
    expect(publicView(newer)).not.toHaveProperty("tenantId");
    expect(listingOf(newer)).toMatchObject({ ref: "alice/agent-intent-ko", latest: { publicationId: "pub_2", versionId: draft.version.id }, cases: 1, runs: 0 });
    expect(JSON.stringify(listingOf(newer))).not.toContain("t1");
  });

  it("check what a hub sent against the version asked for, and say why a version left", async () => {
    const draft = (await buildPublication(await request(), { owner: "alice" })).publication!;
    expect((await verifyPublishedVersion(draft)).id).toBe(draft.version.id);
    await expect(verifyPublishedVersion(draft, "rv_00000000000000000000", "https://hub.example")).rejects.toThrow(/https:\/\/hub\.example sent a rubric that freezes to rv_\w+, not rv_0+; nothing was written/);
    await expect(verifyPublishedVersion({ version: { ...draft.version, rubric: { ...draft.version.rubric, name: "Other" } } })).rejects.toThrow(/the hub sent a rubric/);
    expect(withdrawalNote({ ...draft, withdrawnAt: "2026-11-09T10:00:00.000Z" })).toBe(`alice/agent-intent-ko at ${draft.version.id} was withdrawn on 2026-11-09; copies people already pulled or forked remain theirs`);
    expect(withdrawalNote({ ...draft, withdrawnAt: "2026-11-09T10:00:00.000Z", takedown: { reason: "licence complaint", at: "2026-11-10T00:00:00.000Z" } })).toBe(`alice/agent-intent-ko at ${draft.version.id} was taken down by the hub's operators on 2026-11-10: licence complaint`);
  });
});

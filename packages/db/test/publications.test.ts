import { describe, expect, it } from "vitest";
import { buildPublication, freezeRubric, type Publication } from "@verdict-ai/core";
import { backends } from "./backends.js";

const card = (name: string, domain: string) => ({
  name, metadata: { domain, locale: "ko-KR" }, defaultJudge: { type: "decision", provider: "mock" },
  criteria: [{ id: "q", name: "Question", scale: { type: "binary", labels: ["no", "yes"] }, threshold: 0.5 }],
});

async function publication(id: string, owner: string, tenantId: string, name: string, domain: string, createdAt: string): Promise<Publication> {
  const v = await freezeRubric(card(name, domain));
  const built = await buildPublication({ slug: "card", version: { id: v.id, rubric: v.rubric }, license: "CC0-1.0" }, { owner, tenantId });
  return { ...built.publication!, id, createdAt };
}

describe.each(backends)("publications on $name", ({ open }) => {
  it("stores public documents, searches them across dialects, and withdraws only for their publisher", async () => {
    const { store } = await open();
    const a = await publication("pub_a", "alice", "t1", "상담원 연결 100% 판별", "customer_support", "2026-11-08T00:00:00.000Z");
    const b = await publication("pub_b", "bob", "t2", "Missing Information", "documents", "2026-11-08T00:00:01.000Z");
    await store.putPublication(a); await store.putPublication(b);
    expect(await store.getPublication("pub_a")).toEqual(a);
    expect((await store.listPublications()).map((p) => p.id)).toEqual(["pub_b", "pub_a"]);
    // Case-insensitive on both dialects, and LIKE wildcards in the query are literal.
    expect((await store.listPublications({ q: "missing" })).map((p) => p.id)).toEqual(["pub_b"]);
    expect((await store.listPublications({ q: "ALICE" })).map((p) => p.id)).toEqual(["pub_a"]);
    expect((await store.listPublications({ q: "100%" })).map((p) => p.id)).toEqual(["pub_a"]);
    expect(await store.listPublications({ q: "%%" })).toEqual([]);
    expect((await store.listPublications({ domain: "documents", locale: "ko-KR", judgmentType: "noul" })).map((p) => p.id)).toEqual(["pub_b"]);
    expect((await store.listPublications({ owner: "alice", slug: "card", versionId: a.version.id })).map((p) => p.id)).toEqual(["pub_a"]);
    expect(await store.withdrawPublication("pub_a", "t2", "2026-11-09T00:00:00.000Z")).toBe(false);
    expect(await store.withdrawPublication("pub_a", "t1", "2026-11-09T00:00:00.000Z")).toBe(true);
    expect((await store.listPublications()).map((p) => p.id)).toEqual(["pub_b"]);
    expect(await store.getPublication("pub_a")).toMatchObject({ withdrawnAt: "2026-11-09T00:00:00.000Z" });
    expect((await store.listPublications({ tenantId: "t1", includeWithdrawn: true })).map((p) => p.id)).toEqual(["pub_a"]);
  }, 30000);

  it("takes a publication down and puts it back by rewriting it, as the admin routes do", async () => {
    const { store } = await open();
    const a = await publication("pub_t", "alice", "t1", "Takedown", "documents", "2026-11-08T00:00:00.000Z");
    await store.putPublication({ ...a, withdrawnAt: "2026-11-09T00:00:00.000Z", takedown: { reason: "personal data", at: "2026-11-09T00:00:00.000Z" } });
    expect(await store.listPublications()).toEqual([]);
    expect((await store.getPublication("pub_t"))?.takedown).toEqual({ reason: "personal data", at: "2026-11-09T00:00:00.000Z" });
    await store.putPublication(a);
    expect((await store.listPublications()).map((p) => p.id)).toEqual(["pub_t"]);
    expect(await store.getPublication("pub_t")).toEqual(a);
  });

  it("keeps publishers by tenant and refreshes a renamed login", async () => {
    const { store } = await open();
    await store.putPublisher({ tenantId: "gh:42", githubId: 42, login: "alice", createdAt: "2026-11-08T00:00:00.000Z", updatedAt: "2026-11-08T00:00:00.000Z" });
    await store.putPublisher({ tenantId: "gh:42", githubId: 42, login: "alice2", createdAt: "2026-11-09T00:00:00.000Z", updatedAt: "2026-11-09T00:00:00.000Z" });
    expect(await store.getPublisher("gh:42")).toEqual({ tenantId: "gh:42", githubId: 42, login: "alice2", createdAt: "2026-11-08T00:00:00.000Z", updatedAt: "2026-11-09T00:00:00.000Z" });
    expect(await store.getPublisher("gh:1")).toBeUndefined();
  }, 30000);
});

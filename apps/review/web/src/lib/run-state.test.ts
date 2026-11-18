import { describe, expect, it } from "vitest";
import { applyEvent, binDocs, countsOf, fromSnapshot } from "./run-state";
import type { RunSnapshot } from "./types";

const snap: RunSnapshot = {
  run: { id: "run", status: "running", error: null, lastSeq: 3, requirement: "", requirements: [{ id: "r1", text: "울산 소재" }] },
  docs: [0, 1, 2].map((i) => ({ docId: `d${i}`, position: i, fileName: `${i}.pdf`, status: "queued" as const, stage: null, attempt: 1 })),
  counts: { queued: 3, reviewing: 0, met: 0, not_met: 0, needs_review: 0, error: 0 },
};

describe("run state", () => {
  it("applies events once and counts from document state", () => {
    let s = fromSnapshot(snap);
    const events = [
      { seq: 4, type: "doc.started", docId: "d0" },
      { seq: 5, type: "doc.requirement", docId: "d0", requirementId: "r1", outcome: "met" },
      { seq: 6, type: "doc.completed", docId: "d0", verdict: "met" },
    ];
    for (const e of [...events, ...events]) s = applyEvent(s, e); // 재전송
    expect(countsOf(s.docs)).toMatchObject({ met: 1, queued: 2 });
    expect(s.docs[0]!.outcomes).toEqual({ r1: "met" });
    const before = s;
    expect(applyEvent(s, { seq: 2, type: "doc.completed", docId: "d1", verdict: "not_met" })).toBe(before); // 스냅샷 이전 이벤트
  });
  it("puts retried documents back in the pile and orders bins by completion", () => {
    let s = fromSnapshot(snap);
    s = applyEvent(s, { seq: 4, type: "doc.failed", docId: "d1", error: "x" });
    expect(countsOf(s.docs).error).toBe(1);
    s = applyEvent(s, { seq: 5, type: "doc.requeued", docId: "d1" });
    expect(s.docs[1]!.status).toBe("queued");
    s = { ...s, docs: s.docs.map((d, i) => ({ ...d, status: "met" as const, completedAt: `2026-01-0${3 - i}` })) };
    expect(binDocs(s.docs, "met").map((d) => d.docId)).toEqual(["d0", "d1", "d2"]);
  });
});

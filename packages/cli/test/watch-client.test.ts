import { describe, expect, it } from "vitest";
import { changeNote, CLIENT_FUNCTIONS, escapeHtml, historyLine, leaderboardRow, leaderboardView, lineClass, lineDiff, rankCell, statusText } from "../src/watch/client.js";
import { watchPage } from "../src/watch/page.js";
import type { WatchEntry } from "../src/watch/state.js";

const entry = (over: Partial<WatchEntry> = {}): WatchEntry => ({
  id: "e", name: "Alpha <b>", status: "completed", score: 72.25, range: [0, 100], grade: "good", passed: true, gatesFailed: [],
  criteria: [{ id: "a", name: "A", weight: 1, status: "scored", normalized: 0.5 }, { id: "z", name: "Zero weight", weight: 0, status: "scored", normalized: 1 }],
  evidence: [{ label: "text", kind: "text", text: " first line " }], createdAt: "", updatedAt: "", ...over,
});

describe("watch page client", () => {
  it("diffs lines and describes the change", () => {
    const rows = lineDiff("a\nb\n\nc", "a\nB\nc\nd");
    expect(rows).toEqual([["=", "a"], ["-", "b"], ["-", ""], ["+", "B"], ["=", "c"], ["+", "d"]]);
    expect(changeNote(true, true, rows)).toBe("2 lines added, 1 removed since the previous evaluation");
    expect(changeNote(true, true, lineDiff("x", "x"))).toBe("unchanged since the previous evaluation");
    expect(changeNote(false, false, [])).toBe("first evaluation");
    expect(changeNote(true, false, [])).toBe("new in this evaluation");
    expect([lineClass("+", "x"), lineClass("+", " "), lineClass("-", "x"), lineClass("-", ""), lineClass("=", "x")]).toEqual(["chg", "", "del", "gone", ""]);
  });

  it("renders rank changes, round history and escapes subject text", () => {
    expect(rankCell(entry({ prevRank: 3 }), 1)).toContain("▲2");
    expect(rankCell(entry({ prevRank: 1 }), 2)).toContain("▼1");
    expect(rankCell(entry({ prevRank: 2 }), 2)).not.toContain("delta");
    expect(historyLine([10, undefined, 72.25])).toBe("10 → — → <b>72.3</b>");
    const row = leaderboardRow(entry({ rounds: [10, 72.25] }), 0);
    expect(row).toContain("Alpha &lt;b&gt;");
    expect(row).toContain('class="lhist"');
    expect(row).not.toContain("Zero weight");
    expect(leaderboardView({ view: "leaderboard", entries: [entry()], history: [], running: 0, round: 3, rubric: { name: "R", version: "1" }, aggregation: { method: "formula", formula: "a_n" } }))
      .toContain("round 3</span>");
    expect(escapeHtml('"&')).toBe("&quot;&amp;");
  });

  it("says what the engine is doing", () => {
    expect(statusText({ view: "empty", entries: [], history: [], running: 2 })).toBe("evaluating 2 subjects…");
    expect(statusText({ view: "empty", entries: [], history: [], running: 0 })).toBe("waiting for evaluations");
  });

  it("ships every client function and starts polling", () => {
    const html = watchPage("/data");
    for (const f of CLIENT_FUNCTIONS) expect(html).toContain(`function ${f.name}(`);
    expect(html).toContain("start(700);");
  });
});

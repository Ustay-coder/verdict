/**
 * examples/receipts is the example for pictures, so it is held to what it says: the cases are the ones its script
 * builds from the annotations, every answer is one its rubrics offer, and the table in its README is the saved run's.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadRubricText } from "@verdict-ai/core";

const at = (name: string) => fileURLToPath(new URL(`../../../examples/receipts/${name}`, import.meta.url));
interface Case { id: string; inputs: Array<{ type: string; path: string }>; expected: { payment?: string; items?: string; large_total?: string } }
const cases = readFileSync(at("cases.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Case);
const COUNT = ["one", "two", "three", "four_or_more"];

describe("examples/receipts", () => {
  it("has a hundred receipts, each one photo, with answers its three rubrics can give", () => {
    expect(cases).toHaveLength(100);
    expect(cases.map((c) => c.id)).toEqual(Array.from({ length: 100 }, (_, i) => `receipt-${String(i).padStart(3, "0")}`));
    for (const c of cases) expect(c.inputs).toEqual([{ type: "image", path: `images/${c.id.slice(-3)}.jpg` }]);
    // What the README counts: 81 payments, 100 item counts and 95 totals, 276 answers in all.
    const answered = (key: keyof Case["expected"]) => cases.filter((c) => c.expected[key] !== undefined).length;
    expect([answered("payment"), answered("items"), answered("large_total")]).toEqual([81, 100, 95]);
    for (const c of cases) {
      if (c.expected.payment) expect(["cash", "card"]).toContain(c.expected.payment);
      expect(COUNT).toContain(c.expected.items);
      if (c.expected.large_total) expect(["no", "yes"]).toContain(c.expected.large_total);
    }
    // The three rubrics ask the same three things; only how the number of items is asked differs.
    for (const name of ["receipts-first.yaml", "receipts-second.yaml", "receipts.yaml"]) {
      const rubric = loadRubricText(readFileSync(at(name), "utf8"));
      expect(rubric.criteria.map((c) => c.id), name).toEqual(["payment", "items", "large_total"]);
      const items = rubric.criteria[1]!;
      const options = items.choices ? Object.keys(items.choices) : items.scale?.type === "ordinal" ? items.scale.labels : [];
      expect(options, name).toEqual(COUNT);
    }
    expect(loadRubricText(readFileSync(at("receipts-first.yaml"), "utf8")).criteria[1]!.description).toContain("Count lines");
    expect(loadRubricText(readFileSync(at("receipts.yaml"), "utf8")).criteria[1]!.choices).toBeDefined();
  });

  it("reads each answer from the annotation as it says: amounts however they are printed, an add-on as part of its item", () => {
    const dir = mkdtempSync(join(tmpdir(), "receipts-"));
    try {
      const receipt = (index: number, gt: unknown) => ({ index, file: `images/${String(index).padStart(3, "0")}.jpg`, gt });
      writeFileSync(join(dir, "annotations.json"), JSON.stringify([
        // One item with an add-on under it is one item; "60.000" is sixty thousand; a card amount alone is a card.
        receipt(0, { menu: { nm: "TEA", sub: { nm: "JELLY" } }, total: { total_price: "60.000", creditcardprice: "60.000" } }),
        // Cents are dropped, and separators of either kind read as thousands.
        receipt(1, { menu: [{ nm: "A" }, { nm: "B" }], total: { total_price: "Rp 165000.00", cashprice: "Rp 200000.00" } }),
        receipt(2, { menu: [{ nm: "A" }, { nm: "B" }, { nm: "C" }], total: { total_price: "9.500,00", cashprice: "10.000" } }),
        // Five entries are "four or more"; exactly 100,000 is "yes"; both ways of paying give no answer.
        receipt(3, { menu: [1, 2, 3, 4, 5].map((n) => ({ nm: `I${n}` })), total: { total_price: "100,000", cashprice: "0", creditcardprice: "100,000" } }),
        // No total and no payment: only the count is answered.
        receipt(4, { menu: [{ nm: "A" }], total: { menuqty_cnt: "1" } }),
      ]));
      const built = execFileSync("node", [at("build-cases.mjs"), join(dir, "annotations.json")], { encoding: "utf8" }).trim().split("\n").map((line) => JSON.parse(line) as Case);
      expect(built.map((c) => c.expected)).toEqual([
        { payment: "card", items: "one", large_total: "no" },
        { payment: "cash", items: "two", large_total: "yes" },
        { payment: "cash", items: "three", large_total: "no" },
        { items: "four_or_more", large_total: "yes" },
        { items: "one" },
      ]);
      expect(built[0]).toMatchObject({ id: "receipt-000", name: "receipt-000", inputs: [{ type: "image", path: "images/000.jpg" }] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("shows in its README the table the saved run printed, and the counts the three runs printed", () => {
    const readme = readFileSync(at("README.md"), "utf8");
    const lines = (name: string) => readFileSync(at(name), "utf8").split("\n");
    const shown = /```\n(Receipt facts[\s\S]*?)```/.exec(readme)![1]!.trimEnd().split("\n");
    expect(shown).toEqual(lines("run-2026-11-12.txt").slice(0, shown.length));
    expect(shown).toHaveLength(7);
    // Each run's "agreed with labels" for a model, as the saved outputs have it.
    const agreed = (name: string, model: string) => Number(/ (\d+)\/276 /.exec(lines(name).find((line) => line.startsWith(`  ${model} `))!)![1]);
    const models = ["clef", "clef-flash", "openai", "gemini"];
    const runs = ["run-2026-11-12-first.txt", "run-2026-11-12-second.txt", "run-2026-11-12.txt"];
    // The README's table of item counts, plus the payment and total answers that did not change between the runs.
    const row = (label: string) => readme.split("\n").filter((line) => line.startsWith(`| ${label} |`)).at(-1)!.split("|").slice(2, 5).map((cell) => Number(cell.trim()));
    const others: Record<string, number> = { clef: 81 + 95, "clef-flash": 81 + 95, openai: 80 + 95, gemini: 81 + 95 };
    const labels: Record<string, string> = { clef: "Clef", "clef-flash": "Clef-flash", openai: "OpenAI", gemini: "Gemini" };
    for (const model of models) expect(row(labels[model]!).map((items) => items + others[model]!), model).toEqual(runs.map((name) => agreed(name, model)));
  });
});

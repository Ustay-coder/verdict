/**
 * Two versions of an offline rubric run over the same three cases — what a team's CI would have on disk before it
 * reports. One case holds a name and a phone number, so tests can check that neither reaches the server.
 */
import { compareRuns, createDatasetVersion, Engine, freezeRubric, parseGoldSet, runCases } from "@verdict-ai/core";

const rubric = (keywords: string[]) => ({
  name: "Wants an agent",
  criteria: [{ id: "wants", name: "Wants an agent", scale: { type: "binary", labels: ["no", "yes"] }, judge: { type: "benchmark", method: "keywords", keywords } }],
});

export const PRIVATE = ["kim-private", "Kim Minsu", "010-1234-5678", "eval_"];

const cases = [
  { id: "explicit", name: "explicit", inputs: [{ type: "text", text: "connect me to an agent" }], expected: { wants: "yes" }, labelSource: "human" },
  { id: "kim-private", name: "Kim Minsu", inputs: [{ type: "text", text: "Kim Minsu 010-1234-5678 wants a human" }], expected: { wants: "yes" }, labelSource: "human" },
  { id: "faq", name: "faq", inputs: [{ type: "text", text: "what are your opening hours" }], expected: { wants: "no" } },
];

export async function localRuns() {
  const engine = new Engine();
  const dataset = await createDatasetVersion(parseGoldSet(cases.map((c) => JSON.stringify(c)).join("\n")), { name: "cases.jsonl" });
  const base = await freezeRubric(rubric(["agent"])), head = await freezeRubric(rubric(["agent", "human"]));
  const baseRun = await runCases(engine, base, dataset), headRun = await runCases(engine, head, dataset);
  const comparison = compareRuns({ run: baseRun.run, version: base, evaluations: baseRun.evaluations }, { run: headRun.run, version: head, evaluations: headRun.evaluations }, dataset);
  return { dataset, base, head, baseRun, headRun, comparison };
}

/**
 * Exposes check_against_humans: run a rubric file over a human-labelled gold file and report agreement.
 * Agents edit the rubric between calls, so the file is re-read every time; the reply lists every disagreement with a
 * preview so the caller can see what to change without opening the gold file.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { checkAgainstHumans, loadRubricText, parseGoldSet, parseRubric, ValidationError, type AgreementReport, type Engine } from "@verdict-ai/core";
import { z } from "zod";
import { text, toolResult } from "./result.js";

/** File access stays injectable so the tool can be exercised in memory. */
export interface AgreementDependencies { engine?: Engine; read: (path: string) => Promise<string>; resolve: (path: string) => string; dirname: (path: string) => string }

const percent = (x: number | null) => (x === null ? null : `${Math.round(x * 100)}%`);

/** Shapes a report for an agent: totals first, then only the subjects and criteria that disagree. */
export function agreementSummary(report: AgreementReport) {
  const disagreeing = report.results.filter((x) => x.agrees === false || Object.values(x.criteria).some((c) => c.agrees === false));
  return {
    rubric: report.rubric, items: report.items,
    agreement: `${report.agreed}/${report.decided} decided by Verdict agree with the humans (${percent(report.agreement)})`,
    decided: report.decided, agreed: report.agreed, askedHuman: report.askedHuman, failed: report.failed,
    criteria: Object.fromEntries(Object.entries(report.criteria).map(([id, c]) => [id, { agreed: c.agreed, n: c.n, agreement: percent(c.agreement), askedHuman: c.askedHuman }])),
    splits: Object.fromEntries(Object.entries(report.splits).map(([name, t]) => [name, { agreed: t.agreed, decided: t.decided, items: t.items, agreement: percent(t.agreement) }])),
    labelSources: report.labelSources,
    disagreements: disagreeing.map((x) => ({
      id: x.id, name: x.name, human: x.human, preview: x.preview,
      verdict: { passed: x.passed, criteria: Object.fromEntries(Object.entries(x.criteria).map(([id, c]) => [id, { value: c.verdict, confidence: c.confidence === null ? null : Math.round(c.confidence * 100) / 100 }])) },
    })),
    askedHumanFor: report.results.filter((x) => x.askedHuman).map((x) => x.name),
    invalidInput: report.results.filter((x) => x.inputErrors).map((x) => ({ id: x.id, name: x.name, errors: x.inputErrors })),
  };
}

/** Registers the tool; failures reach the caller as MCP error content. */
export function registerAgreement(server: McpServer, deps: AgreementDependencies) {
  server.registerTool("check_against_humans", {
    title: "Check a rubric against human labels",
    description: "Run a rubric over a gold set (subjects people already judged) and report how often Verdict reached the same verdict: overall pass/fail agreement, per-criterion agreement, how many subjects the judge handed to a human (low-confidence escalation), and every disagreement with a preview. `rubricPath` is a local YAML/JSON rubric file, re-read on every call; `gold` is a local JSON array or JSON-lines file of {id?, name, inputs, expected?: {criterion: label}, human?: {passed?, criteria?}, labelSource?, split?}; choice criteria are labelled with an option id, and unreadable labels are rejected before any judge runs. Local mode only.",
    inputSchema: {
      rubricPath: z.string().optional().describe("Local rubric file (YAML or JSON)"),
      rubric: z.union([z.string(), z.record(z.string(), z.unknown())]).optional().describe("Stored rubric id or inline rubric, instead of rubricPath"),
      gold: z.string().describe("Local gold-set file: JSON array or JSON lines"),
    },
  }, async ({ rubricPath, rubric, gold }) => toolResult(async () => {
    // Gold files and rubric paths are local; a remote API has no access to them.
    if (!deps.engine) throw new ValidationError("check_against_humans needs the local engine (unset VERDICT_API_URL)");
    const ref = rubricPath ? loadRubricText(await deps.read(deps.resolve(rubricPath))) : typeof rubric === "string" ? rubric : rubric ? parseRubric(rubric) : undefined;
    if (!ref) throw new ValidationError("pass rubricPath or rubric");
    const goldPath = deps.resolve(gold);
    const items = parseGoldSet(await deps.read(goldPath), deps.dirname(goldPath));
    return text(agreementSummary(await checkAgainstHumans(deps.engine, ref, items)));
  }));
}

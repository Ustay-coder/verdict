import type { Criterion } from "../schema/rubric.js";
import type { Rating } from "../schema/evaluation.js";
import { ratingBase, type Judge, type JudgeContext } from "../judges/index.js";
import { mapLimit } from "./concurrency.js";

export type JudgeUnit = { criterion: Criterion; judge: Judge; ctx: JudgeContext };

export async function runJudgeUnits(units: JudgeUnit[], ratingsByCriterion: Map<string, Rating[]>, concurrency: number) {
  const groups = new Map<string, JudgeUnit[]>();
  const singles: JudgeUnit[] = [];
  // A shared spec can batch only identical evidence; otherwise criteria would see the wrong state.
  for (const u of units) {
    if (u.judge.rateMany && u.judge.batchKey) {
      const key = `${u.judge.batchKey()}|${u.ctx.evidence.map((e) => e.inputIndex).join(",")}`;
      groups.set(key, [...(groups.get(key) ?? []), u]);
    } else singles.push(u);
  }
  const jobs: Array<() => Promise<void>> = [
    ...[...groups.values()].map((g) => async () => {
      const m = await g[0]!.judge.rateMany!(g.map((u) => u.ctx));
      for (const u of g) appendRatings(u, m.get(u.criterion.id), ratingsByCriterion);
    }),
    ...singles.map((u) => async () => { appendRatings(u, await u.judge.rate(u.ctx), ratingsByCriterion); }),
  ];
  await mapLimit(jobs, concurrency, (job) => job());
}


// Missing and empty responses are explicit failures, so aggregation never silently drops a criterion.
function appendRatings(unit: JudgeUnit, ratings: Rating[] | undefined, results: Map<string, Rating[]>) {
  const returned: Rating[] = ratings?.length ? ratings : [{ ...ratingBase(unit.ctx, unit.judge), status: "error", error: `judge returned no rating for criterion ${unit.criterion.id}` }];
  const existing = results.get(unit.criterion.id) ?? [];
  existing.push(...returned);
  results.set(unit.criterion.id, existing);
}

import { z } from "zod";
import type { DecisionJudgeSpec } from "../../schema/rubric.js";
import type { Rating } from "../../schema/evaluation.js";
import { newRatingId, type JudgeContext } from "../types.js";
type Spec = z.infer<typeof DecisionJudgeSpec>;

export function escalateDecision(c: JudgeContext, rating: Rating, options: { spec: Spec; low: boolean; distribution: string }): Rating[] {
  const { spec, low, distribution: dist } = options;
  const confidence = rating.confidence!;
  if (low && spec.onLowConfidence === "error") return [{ ...rating, status: "error", error: `confidence ${confidence.toFixed(2)} below ${spec.minConfidence}` }];
  else if (low && spec.onLowConfidence === "human") {
    // A pending human slot prevents finalization from accepting uncertainty; the original answer feeds calibration.
    return [{ id: newRatingId(c), criterionId: c.criterion.id, raterId: spec.escalateTo[0] && spec.escalateTo.length === 1 ? spec.escalateTo[0] : `human#1`, judgeType: "human", status: "pending", createdAt: new Date((c.now ?? Date.now)()).toISOString(), raw: { instructions: `Decision model was unsure (confidence ${confidence.toFixed(2)}): ${dist}. Please score "${c.criterion.name}".`, allowedRaters: spec.escalateTo, escalatedFrom: rating } }];
  } else return [rating];
}

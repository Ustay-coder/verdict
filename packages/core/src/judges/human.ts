/**
 * Allocates pending human rating slots without performing judgement.
 * Named raters receive individual slots; anonymous slots retain their allowed-rater restrictions.
 */
import type { HumanJudgeSpec as HumanSpec } from "../schema/rubric.js";
import type { Rating } from "../schema/evaluation.js";
import { type Judge, type JudgeContext, ratingBase } from "./types.js";
import type { z } from "zod";

type Spec = z.infer<typeof HumanSpec>;

/**
 * Human-in-the-loop judge. It never scores by itself: it emits `pending` placeholder ratings
 * (one per required rater) which the engine later fills via `Engine.submitScore`.
 */
export class HumanJudge implements Judge {
  readonly type = "human" as const;
  readonly id: string;
  constructor(public spec: Spec) { this.id = spec.id ?? "human"; }
  expectedRatings() { return this.spec.required; }
  async rate(ctx: JudgeContext): Promise<Rating[]> {
    const out: Rating[] = [];
    // Named slots only when every listed rater must respond; otherwise any allowed rater may fill a generic slot.
    const named = this.spec.raters.length > 0 && this.spec.raters.length <= this.spec.required;
    for (let i = 0; i < this.spec.required; i++) {
      const raterId = named ? this.spec.raters[i] ?? `${this.id}#${i + 1}` : `${this.id}#${i + 1}`;
      out.push({ ...ratingBase(ctx, this, raterId), status: "pending", raw: { instructions: this.spec.instructions, allowedRaters: this.spec.raters } });
    }
    return out;
  }
}

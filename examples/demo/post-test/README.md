# Topic test: which demo gets the best response on X?

**Status: design (2026-11-08). Nothing posted yet.**

Five videos, five use cases for Verdict. The question is which one developers on X respond to most, because that is
the use case to lead with on the site, in the next videos and in the launch post.

| Arm | Topic (use case) | Video | Post | Length | Post score |
| --- | --- | --- | --- | --- | --- |
| **B** | An AI one-shot landing page with fake testimonials, 0 → 93 | `verdict-landing-strict-*.mp4` ([`../landing-ui-loop/`](../landing-ui-loop)) | [`b/drafts/a.md`](../post-loop/captions/b/drafts/a.md) | 29.2 s | 93 |
| **C** | A hackathon write-up, 5th → 1st | `verdict-hackathon-strict-*.mp4` ([`../ranking-loop/v2/`](../ranking-loop/v2)) | [`c/drafts/b.md`](../post-loop/captions/c/drafts/b.md) | 31.3 s | 91.5 |
| **D** | Does the AI judge agree with people? 57% → 76% | `verdict-commit-judge-*.mp4` ([`../judge-loop/`](../judge-loop)) | [`d/drafts/c.md`](../post-loop/captions/d/drafts/c.md) | 35.8 s | 92.5 |
| **E** | A sponsored script, reject → approve | `verdict-sponsor-strict-*.mp4` ([`../sponsor-loop/v2/`](../sponsor-loop/v2)) | [`e/drafts/b.md`](../post-loop/captions/e/drafts/b.md) | 30.9 s | 90.5 |
| **F** | Our own launch post, 0 → 88 | `verdict-post-strict-*.mp4` ([`../post-loop/v2/`](../post-loop/v2)) | [`f/drafts/c.md`](../post-loop/captions/f/drafts/c.md) | 34.2 s | 89.7 |

- **Left out:** video G (Korean detail page). Its audience is Korean sellers, not developers on X, so it would answer a
  different question. It can run later as its own test with Korean targeting.
- **The videos:** rendered from each take folder's `warp.json` (the command is in each README). They aren't committed.

## What varies and what is held constant

The topic is the only thing meant to vary. Everything else is held constant, or the difference is recorded:

| | How it's held constant | What is left |
| --- | --- | --- |
| **Post text** | All five were written to the same rubric (`../post-loop/captions/`), and they share one shape: "X scored 0 → result", what Verdict is, one limit, a question | The wording still differs. A strong line can win for a topic that isn't the strongest |
| **Video format** | One format for every arm (vertical or wide, chosen in prep) | — |
| **Video length** | 29–36 s now. **Recommended:** re-render all five to the same length (e.g. 30 s) by adjusting `warp.json` | Until then, the 50% mark comes 15 s in for B and 18 s in for D |
| **Audience, time, budget** | Paid phase: one A/B test, so the audience is split at random into non-overlapping groups that see one arm each, in the same period, with the same budget | — |
| **First frame** | Every cut opens on the finished result (cold open) | What that result looks like differs by topic, and that is part of the topic |

## Metrics (fixed before launch)

- **Primary (attention): views to 50% per impression.** It is common enough to compare at a budget a small account can
  afford, and Ads Manager reports video quartiles. `analyze.py` reads it as `video_50 / impressions`.
- **Secondary (direction only, not used to pick):**
  - **Intent:** follows + profile visits + bookmarks per 1,000 impressions.
  - **Conversation:** replies + quotes per 1,000.
  - **Reposts** per 1,000.
  - Likes are recorded but not used.
- **If intent matters more than attention**, make intent the primary instead, before launch. It is rarer, so it needs
  several times the impressions (see the plan below).
- **Decision rule:** the arm with the highest chance of being best on the primary metric wins, if that chance is
  **≥ 90%**. Otherwise there is no winner on attention, and the top arms are compared on the secondary metrics and the
  replies. The chance is computed the same way as the "win chance" in X's own A/B test (a Bayesian comparison of rates),
  so the two should agree.

## Phase 0: prep

1. Choose the format: preview both cuts of one arm in the ad composer on a phone, and use the one X shows larger in the
   timeline for every arm.
2. Re-render the five cuts to the same length (recommended, see above).
3. Write the predictions in [`predictions.md`](predictions.md) before anything goes out.
4. Copy [`results/template.csv`](results/template.csv) to `results/phase1.csv` and `results/phase2.csv`.

## Phase 1: paid A/B test (the evidence)

- **Setup:** one campaign in X Ads Manager with A/B testing turned on before launch; X requires a new campaign for each
  test. Five ads, one per arm, and the ad is the only variable. Ads Manager warns when cells differ in more than one
  variable.
- **Posts:** promoted-only posts, which don't appear on the profile, so Phase 2's organic posts start clean.
- **Objective:** Reach, paid per impression, so delivery isn't steered toward people likely to watch to the end, which
  is the primary metric itself.
- **Audience:** English-speaking developers, one targeting set for every cell; for example, interests in software
  development and AI, and keywords such as coding agent, Claude Code, LLM evals.
- **Budget:** equal per cell. First a 1–2 day pilot, to measure the real CPM and the base rate of the primary metric.
  Then set impressions per arm from the plan:

  ```bash
  python3 analyze.py plan --base <pilot rate> --lift 0.25
  ```

  | Base rate (50% views per impression) | To see +50% relative | To see +25% relative |
  | --- | --- | --- |
  | 5% | 2,086 per arm | 7,572 per arm |
  | 10% | 971 per arm | 3,558 per arm |
  | 20% | 413 per arm | 1,551 per arm |

  The plan is 80% power, comparing the best arm against each of the other four (α = 0.05 with a Bonferroni
  correction). Intent actions happen at well under 1% of impressions, so making intent the primary takes tens of
  thousands of impressions per arm.
- **Stopping:** every cell reaches its target, or 7 days pass. Don't stop early because one arm leads; X shows results
  during the flight, but a lead that early is mostly noise.
- **Reading it:** export the per-ad numbers to `results/phase1.csv`, then:

  ```bash
  python3 analyze.py results results/phase1.csv
  ```

  The output gives each arm's rate, its 95% interval, its chance of being best, cost per 50% view, the decision and
  the secondary metrics.

## Phase 2: organic posts (direction and replies)

- **Order:** the five posts go up on the Verdict account in random order, one per day at the same local time. The order
  was drawn with seed 20261108: **F, C, B, E, D**.
- **Data:** read each post's numbers 48 hours after it goes up and enter them in `results/phase2.csv`.
- **Limits:** one post per topic on one account can't separate the topic from the day, from follower growth or from
  the posts before it, so Phase 2 doesn't overrule Phase 1.
- **What it adds:** the replies. Code each one by what it asks about (the use case, how the judge works, price or
  access, doubt) and count them per arm.

## Predictions (written before launch)

[`predictions.md`](predictions.md) records three rankings before anything goes out:
- The founder's.
- Claude's.
- The post scores from the caption rubric: B 93, D 92.5, C 91.5, E 90.5, F 89.7.

After Phase 1, each is compared with the real ranking.

**Caveats on the comparison:**
- Five arms are too few to validate anything. It shows only whether a prediction was close.
- The caption rubric scores how well each post is written, not how interesting its topic is. If its ranking matches
  the results, that is a hint, not proof, that the rubric tracks response.

**Possible follow-up:** "We predicted which demo would win. Here's how wrong we were." would make an honest follow-up
post.

## Threats to the result

- **Copy:** see the table above. If the winner's margin is small, a second test with one fixed template caption per
  topic would tell copy and topic apart.
- **Ad audience ≠ followers:** Phase 1 measures cold developers. Followers may respond differently, and Phase 2 hints
  at that.
- **Metric definitions:** X has changed how it counts video views. Compare arms within one test, never against
  numbers from another period.
- **Analytics access:** some account-level analytics need X Premium. Per-post numbers and Ads Manager reports are what
  this plan uses.

## Decisions before launch

| Decision | Default in this plan |
| --- | --- |
| Paid phase or organic only | Paid; organic only gives direction |
| Primary metric: attention or intent | Attention (50% views per impression) |
| Format | One format for every arm, chosen from the phone preview |
| Equal lengths | Re-render all five to the same length |
| Audience | English-speaking developers with interests in software development and AI, plus agent and eval keywords |

## Files

| | |
| --- | --- |
| [`analyze.py`](analyze.py) | `plan` (impressions per arm) and `results` (rates, intervals, chance of being best, decision); standard library only |
| [`results/template.csv`](results/template.csv) | One row per arm, with the columns `analyze.py` reads |
| [`predictions.md`](predictions.md) | Rankings written before launch |

Sources on X's ad tools: [A/B testing in Ads Manager](https://business.x.com/en/help/campaign-measurement-and-analytics/ab-testing),
[Ads API A/B testing](https://docs.x.com/x-ads-api/measurement/ab-testing), [ads pricing](https://help.x.com/business-and-advertising/ads-pricing),
[campaigns 101](https://business.x.com/en/help/campaign-setup/campaigns-101). The Ads API page caps a test at five
user groups; whether the Ads Manager UI has the same cap wasn't confirmed.

# Video D: does the AI judge agree with people?

**Status: Take 1 recorded (2026-11-07). Cuts: vertical and wide, 36 s. It did not reach its target.**

The original plan for D was "AI judges vs human judges". Like B, C and G, this version climbs in steps:
- **The setup:** a commit-message reviewer (a Verdict rubric) is checked against 96 commit messages that people already
  labelled.
- **The loop:** the agent changes one thing in the rubric per check.
- **On screen:** the share of Verdict's verdicts that match the humans climbs, and each message's square turns green
  when it matches.

| | |
| --- | --- |
| Human labels | [`source/sampled-messages.csv`](source/sampled-messages.csv): 1,649 commit messages labelled by Tian et al., *What Makes a Good Commit Message?* (ICSE 2022), from [their repository](https://github.com/WhatMakesAGoodCM/What-Makes-a-Good-Commit-Message). It has no license file; the messages come from public open-source repositories |
| Gold sets | [`start/gold/dev.jsonl`](start/gold/dev.jsonl) (96 to tune on) and [`start/gold/test.jsonl`](start/gold/test.jsonl) (96 held out). Each has 48 good and 48 not good (16 no why, 16 no what, 16 neither) |
| Codebook | [`start/codebook.md`](start/codebook.md): how the reviewers labelled, from the authors' released coding of 252 messages |
| Start rubric | [`start/commit-review.yaml`](start/commit-review.yaml): the usual commit style rules (50-character subject, imperative mood, wrapped body) |
| Tool | `check_against_humans` (MCP) and `verdict check` (CLI), in [`packages/core/src/agreement.ts`](../../../packages/core/src/agreement.ts) |
| Take 1 | [`take-1/`](take-1): prompt, speed schedule, recording (cast, transcript), timeline, final rubric |
| Renderer | [`recording/plain2pane-agree.mjs`](recording/plain2pane-agree.mjs) with [`recording/build_timeline.py`](recording/build_timeline.py) |

## Why commit messages (what was tried first)

A climb in agreement needs human labels that follow a specific written standard. With generic human judgement the
judge already agrees about as much as it can, and rewriting the rubric moves little. Probes on 24 to 48 items each,
with Jev and Clef:

| Data | Human labels | Rubric changes moved agreement |
| --- | --- | --- |
| SummEval (summaries, 3 expert ratings) | 1–5 on four qualities | 58% → 54% (the guidelines didn't help) |
| LLMBar (Princeton, which of two answers follows the instruction) | one preferred answer | 71% → 79% (Jev), 58% → 71% (Clef) |
| Commit messages (ICSE 2022) | good only if it says what changed and why | 59% → 76% (Jev, on 96) |

The commit labels follow a codebook that a judge wouldn't guess, for example that an issue or PR link counts as the
reason. In the same study, experienced open-source developers matched these labels on 102 of 120 (85%). The authors'
two labellers had Cohen's kappa 0.91.

## Calibration

| Rubric | dev 96 | held-out pool of 150 |
| --- | --- | --- |
| Style rules ([`cal/start-jev.yaml`](cal/start-jev.yaml)) | 59% | 58% |
| Codebook what + why, hand-written ([`cal/codebook-jev.yaml`](cal/codebook-jev.yaml)) | 76% | 77% |

- **Judge:** Jev. Clef stayed lower (65% → 69% on an earlier 48).
- **First dev set:** 48 messages turned out easy. The codebook rubric scored 88% on them and 73% on the test set, so
  both sets went to 96.
- **Target:** 80%, set below the developers' 85%, which the video shows as a reference line.
- **A first take** let the agent apply the whole codebook in one change: 54% → 85% in one step, 71% on held-out
  messages. It was discarded and the prompt now allows one codebook row, one criterion or one setting per change.

## Take 1 (2026-11-07)

Interactive Claude Code, unattended:
- **Tools:** Read, Edit and Write, plus the Verdict MCP server. No shell.
- **Prompt:** [`take-1/prompt.txt`](take-1/prompt.txt): edit only the rubric, one small change per check, don't copy
  gold messages into it, hand at most 12 of 96 to a human. Stop at 80% or after 10 checks, then check once on the
  held-out set.
- **Time:** 2 min 24 s from submit to done.

| Check | Agreement | Asked a human | Change before this check (the agent's own log) |
| --- | --- | --- | --- |
| 1 | **57%** (55/96) | 0 | (start) the style rules |
| 2 | **64%** (61/96) | 0 | Good = says what changed and why; style doesn't matter |
| 3 | **78%** (75/96) | 0 | Codebook row: an issue or PR link counts as the why |
| 4 | 77% | 0 | Codebook row: describing only the problem has no what |
| 5 | 78% | 0 | Aggregation `weighted_mean` → `min` (no effect yet) |
| 6 | 76% | 0 | A separate `what` criterion |
| 7 | 78% | 0 | `what` anchors from the codebook's "object of change" |
| 8 | 75% | 0 | A `why` criterion built from the codebook's ways of saying why |
| 9 | 75% (68/91) | 5 | Hand ratings below 0.1 confidence to a human |
| 10 | 75% (61/81) | 15 | Cutoff 0.2: over the cap of 12, and no better |
| 11 | 76% (68/89) | 7 | Cutoff back to 0.1 |
| **held out** | **76%** (66/87) | 9 | the final rubric, once |

**Checked:**
- [`build_timeline.py`](recording/build_timeline.py) replays the agent's edits from the transcript; the last state
  matches [`take-1/final-commit-review.yaml`](take-1/final-commit-review.yaml).
- The agent never opened `gold/test.jsonl`, and the rubric quotes no gold message.

**Deviations from the prompt:**
- It made 11 dev checks, not 10: the last one re-checked the restored 0.1 cutoff.
- Check 10 went over the cap of 12 handed to a human (15). It reverted that.

**Why it stalled** (the agent's own analysis):
- The same rubric scores 77% and 78% on consecutive runs, so 1–2-point changes can't be told apart from chance.
- Two criteria must both be right; each matches the humans 80–83%.
- Some labels are lenient ("Update README.md" counted as having a why), and the judge follows the codebook instead.

## The cut

[`recording/plain2pane-agree.mjs`](recording/plain2pane-agree.mjs) with [`take-1/warp.json`](take-1/warp.json):
- **Board:** the agent's own `check_against_humans` results. The percentage counts up, the history grows, a bar shows
  the developers' 85%. Each of the 96 messages is a square, grouped by what the humans said: green when Verdict
  matched, red when not, grey when handed to a human. Squares that changed are outlined.
- **Rubric:** the file as it was at each moment; the lines the last edit added are green until the next check.
- **Speed:** each result plays at 1.5×, the waiting in between at 8–14×. A 1.6 s cold open shows the end first.
  Nothing is cut; the model and plan label is blanked.

```bash
python3 recording/build_timeline.py take-1/recording start/commit-review.yaml start/gold/dev.jsonl take-1/timeline --final take-1/final-commit-review.yaml
XTERM_MODULES=<dir with @xterm/xterm> node recording/plain2pane-agree.mjs take-1/recording take-1/timeline out.mp4 --warp take-1/warp.json --layout vertical
```

The caption is in [`../post-loop/d-judge/`](../post-loop/d-judge).

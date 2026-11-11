# Quality harness

`scripts/harness/run.mjs` turns the improvement loop we ran by hand (score → brief → agent → verify → re-score → commit) into a repeatable, guarded process. Verdict scores the code; a coding agent (Codex CLI by default, any `cmd "<brief>"` works) does the editing; the harness decides what survives.

```
baseline ──► brief ──► agent ──► verify ──► re-score ──► accept + commit ──► next round
                                   │            │
                                   └─ reject ◄──┘   (git checkout -- . ; git clean)
```

## Run it

```bash
pnpm quality:improve                      # up to config.maxRounds rounds until target (90)
node scripts/harness/run.mjs --plan-only  # measure and write .verdict-quality/round1-brief.md, run nothing
node scripts/harness/run.mjs --rounds 1 --no-commit --agent "claude -p"   # another agent; leave changes uncommitted
node scripts/harness/smoke.mjs [--update] # behaviour goldens on their own
```

Requirements: a clean working tree, `TYPESAFE_API_KEY` for the file review (`--judge clef` needs the Cloudflare pair), Codex logged in (`scripts/codex-cloud.sh`). Each round writes `roundN-brief.md`, `roundN-agent.log`, `roundN-score.json` and, on rejection, `roundN-rejected.txt` under `.verdict-quality/` (git-ignored). `history.json` records the score per accepted round. Exit code 0 = target reached, 2 = not reached, 1 = harness error.

## What a round must pass to be kept

1. `verify` commands from `scripts/harness/config.json`: build, typecheck, tests, lint with zero warnings, website build.
2. **Behaviour goldens** (`scripts/harness/smoke.mjs` vs `golden.json`): deterministic evaluations through the real CLI (mock decision/LLM judges, benchmarks, panels, humans, checks, choice criteria, PDF ingestion, batch ranking). Round two of the manual loop broke PDF ingestion with 149 green tests; this gate exists because of that. Update the goldens deliberately with `--update` when behaviour is meant to change.
3. **Protected paths** untouched: the rubrics, the scorer, the metrics collector, this harness, the ESLint config and the workflows. An agent that edits the ruler does not get to keep the measurement.
4. **Metric floors**: 0 cognitive-complexity violations, 0 long functions/files, 0 unused, 0 lint errors, duplication ≤ 1.4 %.
5. **Score does not fall** (tolerance 0.05) on the re-score; the model review must have no provider errors — a review that could not reach the judge is an error, never a score (the agent's sandbox has no network, which once produced a meaningless "99").

Rejected rounds are reverted and logged; the loop continues with a fresh brief.

## The brief

`scripts/harness/plan.mjs` builds the agent's instructions from the report: rules and protected paths, every ESLint finding with file:line, duplication examples when over the floor, line-weighted criterion means, and the files to improve ordered by `lines × (82 − score)` with their three weakest criteria. It restates what a 5 means for each weak criterion so the agent fixes the named concern instead of adding defensive noise — the file rubric scores an absent concern as 5, so "more code" is not the answer.

## Tuning

`scripts/harness/config.json`: `target`, `maxRounds`, `judge`, agent command and timeout, verify commands, metric floors, file focus (minimum lines, threshold, how many files per brief), commit policy. Keep the per-round scope small (one criterion family or ≤ 30 files): large briefs produce more module splitting than improvement.

## Using it from CI

`.github/workflows/quality.yml` runs the measured half on every pull request and the full score on `main` (needs the `TYPESAFE_API_KEY` secret); it fails a PR when a metric floor is broken, and fails `main` when the overall score drops more than `gateTolerance` (1 point) below the target: Jev's score varies by about 0.1 between runs, so the gate must not sit exactly on the target the harness aims for. The harness itself is meant to be run by a person or a scheduled agent session, not on every PR: it spends agent tokens and commits code.

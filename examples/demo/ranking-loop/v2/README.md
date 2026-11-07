# Video C v2: our hackathon write-up climbs from 5th to 1st, one judging check per round

**Status: Take 1 recorded (2026-11-07). Cuts: vertical and wide, 31 s.**

The first video C (in [`../`](..)) judged five entries once and changed only the aggregation, so the winner changed
three times. It was hard to feel because nothing climbed. In this version:
- **The setup:** one entry is ours, Tidewatch. Its write-up starts with hype and missing sections.
- **The loop:** the agent fixes one failing check per round and compares all five entries again.
- **On screen:** the live leaderboard shows Tidewatch's score in every round and its rank climbing.

| | |
| --- | --- |
| Entries | [`start/entries/`](start/entries): five fictional entries, each a write-up (`.md`) and a facts file (`.facts.json`, everything true about it) |
| Rubric | [`hackathon-judging-strict.yaml`](hackathon-judging-strict.yaml) |
| Calibration | [`cal/board.sh`](cal/board.sh) `<tidewatch.md>`: compares the five entries and prints the leaderboard |
| Take 1 | [`take-1/`](take-1): prompt, speed schedule, recording (cast, transcript, store snapshots) |

## Research behind the rubric (2026-11-07)

These come from event rule pages and organiser guides, not studies. Each event sets its own rules.

| Topic | What the sources say | Where it went |
| --- | --- | --- |
| Judging criteria | No single standard. The recurring criteria are potential impact, technical implementation ("does it work, is the architecture sound") and quality or originality of the idea. One event weighted technical 40%, idea 30%, design 20%, wow 10% ([Devpost rule pages](https://kelaenderkoe.pages.dev/patterns-https-hackcc-2025.devpost.com/rules), [Okta](https://devforum.okta.com/t/what-are-the-judging-criteria-for-the-hackathon/15842), [Global Travel Hackathon](https://github.com/Global-Travel-Hackathon/Evaluation-Criteria)) | Quality: `impact` ×3, `technical` ×2, `originality` ×1 (Jev) |
| Honesty | Misrepresenting the project is disqualifying | Gate `honest`: claims beyond facts.json score 0 |
| Before vs during | Judges consider only what was built at the event; say what existed before ([MLH guide](https://guide.mlh.io/general-information/judging-and-submissions/rules-for-your-hackathon)) | `built_during` |
| AI tools | AI use must be credited, or the entry is disqualified (MLH guide) | `ai_credited` |
| Code | Code must be public and linked from the submission (MLH guide) | `code` |
| Demo | A short demo video (often 2–5 minutes, sometimes at most 2) or a live demo ([UniHack](https://unihack.notion.site/How-to-submit-your-project-2e05dc7357fb4d3ba3e23f51207f996a), [Chainlink](https://chain.link/blog/blockchain-hackathon-tips)) | `demo` |
| Write-up | Open with what it does and the problem; judges prefer entries that are clear, complete and easy to evaluate ([DoraHacks](https://dev.to/dorahacks/what-does-a-good-hackathon-submission-look-like-5398), [RevenueCat](https://www.revenuecat.com/blog/engineering/how-to-win-shipaton-part-4-pitching-your-app), [DEV](https://dev.to/jacklynbiggin/how-to-make-your-devpost-submissions-not-suck-37i0)) | `what_for_whom`, `limits` |

## The rubric

```
honest < 0.5 ? 0 : (impact × 3 + technical × 2 + originality) / 6 × (1 + checks passed) / 7
checks = what_for_whom, built_during, ai_credited, demo, code, limits   (Clef, binary, judged against facts.json)
```

- An overclaim scores 0.
- Past the gate, the entry earns 1/7 of its quality score, plus 1/7 for each check it passes.
- Grades: finalist ≥ 80, contender ≥ 50, out.

**Calibration** (leaderboard before recording):
- **Rivals:** each passes a different number of checks (Receipt Run 6, Common Room 4, Menu Match 2, Plant Pal 1), so
  they score 58 / 40 / 21 / 13. Tidewatch has to pass them one at a time.
- **Tidewatch:** 0 at the start, and 85 for a hand-written final ([`cal/tidewatch-final.md`](cal/tidewatch-final.md)).
- **Originality fix:** the judges rated originality 1–20% for every entry. The levels now ask whether the write-up
  says what existing options miss. facts.json got `existing_alternatives` (regional flood warnings cover whole
  districts), so a true sentence can earn it. The pass mark was set to the calibrated 80.

## Take 1 (2026-11-07)

Interactive Claude Code, unattended:
- **Tools:** Read, Edit and Write, plus the Verdict MCP server. No shell.
- **Prompt:** [`take-1/prompt.txt`](take-1/prompt.txt): edit only `entries/tidewatch.md`, claim nothing beyond its
  facts file, fix one failing criterion per round (gate first), and compare all five again. Stop when it passes or
  after 10 comparisons.
- **Time:** 2 min 11 s from submit to done.

| Round | Tidewatch | Rank | Fixed before this round (the agent's own log) |
| --- | --- | --- | --- |
| 1 | **0** | 5 | (start) gate failed: "99% accuracy", "protects 12 neighbourhoods", AI and ML that don't exist |
| 2 | **10** | 5 | Gate: removed the false claims |
| 3 | **22** | 3 | `what_for_whom`: a plain opening that names creek-side residents |
| 4 | **32** | 3 | `built_during`: what was built in the 36 hours vs. what existed before |
| 5 | **43** | 2 | `ai_credited`: Claude Code wrote most of the map dashboard's frontend |
| 6 | **56** | 2 | `demo`: linked the 2:40 demo video |
| 7 | **67** | **1** | `code`: linked the public repo |
| 8 | **79** | 1 | `limits`: the four limitations from facts.json |
| 9 | **91** | 1 | `impact`, the weakest quality criterion: a "Why it matters" section with the creek test results. **Finalist** |

The rivals were judged again every round and barely moved: Receipt Run 58–59, Common Room 40–41, Menu Match 21,
Plant Pal 13–14. That is the judges' own spread.

**Checked:**
- Every claim in the final write-up is in its facts file, except one closing sentence that states no fact.
- No other file was edited.
- The agent's own caveats: the honesty gate passed at 69–84% probability, so it is the criterion most likely to flip.
  Round 9 probably raised `technical` too (82 → 99).

## Watch: rounds and rank changes

`verdict watch` now shows, in the leaderboard of a rubric that has compared the same subjects before:
- each entry's score in every round (Tidewatch: 0 → 10 → … → 91), the current one in bold;
- a ▲/▼ next to its rank when it moved since the previous round;
- a "round N" chip.

This is `watchState` in [`packages/cli/src/watch.ts`](../../../../packages/cli/src/watch.ts), tested in
`packages/cli/test/watch.test.ts`. Re-aggregating a batch still re-ranks it in place, as in the first C.

## The cut

[`../../watch-recording/plain2pane-watch.mjs`](../../watch-recording/plain2pane-watch.mjs) with
[`take-1/warp.json`](take-1/warp.json):
- **Speed:** each new leaderboard plays at 1.2–2×, and the waiting in between at 5–15×.
- **Cold open:** 1.6 s of the finished leaderboard first.
- **Labels:** the speed is printed, and the model and plan label is blanked.
- **Nothing is cut.**

```bash
XTERM_MODULES=<dir with @xterm/xterm> node ../../watch-recording/plain2pane-watch.mjs take-1/recording take-1/recording/snapshots out.mp4 --warp take-1/warp.json --title "claude — ~/hackathon-v2" --url "127.0.0.1:4611 — verdict watch" --layout vertical
```

The caption is in [`../../post-loop/c-hackathon/`](../../post-loop/c-hackathon).

# X posts for videos B–F, pass mark 90

Each video goes out with one X post. The earlier captions (`../b-landing/`, `../c-hackathon/`, `../d-judge/`,
`../e-sponsor/`, `../f-post/`) used [`../post-review.yaml`](../post-review.yaml), which passes at 80. These were
written again and scored with a stricter rubric that passes at **90**.

| Video | Post | Runs of the pick | Average | X length |
| --- | --- | --- | --- | --- |
| **B** landing page, 0 → 93 | [`b/drafts/a.md`](b/drafts/a.md) | 93, 93 | **93** | 270 |
| **C** hackathon write-up, 5th → 1st | [`c/drafts/b.md`](c/drafts/b.md) | 91, 92 | **91.5** | 266 |
| **D** AI judge vs. people, 57% → 76% | [`d/drafts/c.md`](d/drafts/c.md) | 93, 92 | **92.5** | 272 |
| **E** sponsored script, reject → approve | [`e/drafts/b.md`](e/drafts/b.md) | 91, 89, 91, 91 | **90.5** | 268 |
| **F** our launch post, 0 → 88 | [`f/drafts/c.md`](f/drafts/c.md) | 91, 89, 90, 89, 90, 89, 89, 90, 90, 90 | **89.7, not passed** | 275 |

"Runs of the pick" are every review of that exact text. A post passes when its average over those runs is at least 90.
F's best draft reached 90 or more in 6 of 10 runs, but its average stayed under 90 after 24 rounds.

## The posts

**B** (with video B):
> An AI one-shot landing page scored 0. Eight minutes later: 93.
>
> Claude Code rebuilt the page for Tideline (a fictional product) one check at a time, scored by Verdict, an evaluation engine. Two rounds barely moved.
>
> What check would you add before an agent ships a page?

Draft A started as video F's final post, unchanged: 86, because at 509 characters it fails `fits`. Rewritten to 270 characters, it scored 93.

**C** (with video C v2):
> A hackathon write-up scored 0. Two minutes later: 91, and 1st place.
>
> Claude Code fixed one judging check per round on Tidewatch (a fictional entry), scored by Verdict, an evaluation engine. The honesty check passed narrowly.
>
> What does your last write-up leave out?

**D** (with video D):
> 57%. That's how often our AI judge agreed with human reviewers on real commit messages, from a study.
>
> Claude Code tuned its rubric in Verdict, our evaluation engine, one rule at a time: 78%, then nothing moved it. 76% on unseen commits.
>
> Would you ship a reviewer at 76%?

**E** (with video E v2):
> One line in this sponsored script promised guaranteed credit approval. Verdict, an evaluation engine, gave it 0.
>
> Claude Code fixed one rule per review. Nine reviews later: 85, approved, just over the bar. The creator is fictional.
>
> Which rule would your script break?

**F** (with video F v2), the best draft, which did not pass:
> Our launch post scored 0. It claimed our agent fixes any landing page, guaranteed.
>
> Claude Code fixed one rule per review: no hype, two hashtags, no tags. Verdict, an evaluation engine, gave it 88 after 10 reviews, just over the bar. Tideline is fictional.
>
> Would yours pass?

## The rubric

[`caption-review.yaml`](caption-review.yaml) is video F's strict launch-post rubric
([`../v2/post-review-strict.yaml`](../v2/post-review-strict.yaml), sources in [`../v2/README.md`](../v2/README.md)),
made general for any of our videos, plus one check:

```
claims_true < 0.5 ? 0 : (hook × 3 + specific × 2 + clear) / 6 × (1 + checks passed) / 10
checks = no_hype, hashtags, mentions, styled_text, fits, real_or_made_up, what_it_is, limits, question
```

- **Gate:** every claim must be in the video's `brief.md`; anything else scores 0.
- **New check, `fits`:** at most 280 characters. X shows the first 280 characters of a post in the timeline and puts
  the rest behind "Show more". It is a `benchmark` length judge, no model. Four checks are now deterministic.
- **Grades:** post it ≥ 90, close ≥ 60, rework.

Each video's `brief.md` is the earlier caption brief, plus two sections the checks read: **Fictional** (what in the
video is made up) and **What didn't go smoothly** (from the take's own caveats).

### What changed while setting it up

These were tested on loose drafts ([`probe.sh`](probe.sh)) before round 1, and B's round 1 was scored again with the
final rubric.

- **`clear`:** "One idea, plain words" scored every 280-character draft 28–48, because the required disclosures
  (what is fictional, what Verdict is) read as extra ideas. With clarity capped there, no post could reach 90. Now it is
  "Plain, easy to read", and a short note on what is fictional or what the tool is doesn't count against it. The same
  drafts then scored 66–88.
- **`fiction_flagged` → `real_or_made_up`:** asking whether the post flags "what brief.md calls fictional" was a coin flip
  (49–58%) on a post that names Tideline without calling it fictional. The check now reads only the post: does it say
  whether the demo is real or made up? That also covers video D, whose data is real. The failing probe dropped to
  36% and the passing ones rose to 75–81%.
- **`what_it_is`, `limits`:** they read only the post now, and their anchors give examples ("Verdict, an evaluation
  engine"; "rounds that barely moved, a target it missed, a pass just over the bar"). Each failed the probe that left
  its item out.

## The loop

- Three drafts per video. Each round rewrites the lowest draft and scores all three again; drafts are judged one by
  one, so a rewrite doesn't move the others.
- When a draft reaches 90, it stays unchanged for at least one more round. The pick is the draft whose average over
  its unchanged runs is highest, and it passes at 90.
- Facts only from `brief.md`. Every round's drafts and scores are in `<video>/rounds/<n>/`.

| Video | Rounds | Best per round |
| --- | --- | --- |
| B | 5 | 88, 87, 88, **93**, **93** |
| C | 10 | 89, 88, 88, 90, 89, 90, 90, 89, **91**, **92** |
| D | 3 | 87, **93**, **92** |
| E | 6 | 77, 77, **91**, 89, **91**, **91** |
| F | 24 | 74, 77, 79, 77, 78, 87, 87, 87, 87, 86, 86, 85, 86, 87, 91, 89, 91, 89, 90, 90, 89, 90, 90, 90 |

**What the rounds showed:**
- **Clarity is still the ceiling.** It is the lowest criterion in four of the five picks (62–77). The posts that cleared
  90 with room to spare (B, D) open with the result in one or two short sentences and fold the disclosures into one.
- **Wording the judge reads weakly:** "(a made-up product)" passed `real_or_made_up` at 44%, "(a fictional product)" at
  78%. "Verdict, our evaluation engine" passed `what_it_is` at 49–82% depending on the post.
- **F stayed at 89–91.** Its story has three layers (a post about a video about a fictional product's page), so
  clarity topped out around 75. Listing the whole score climb didn't raise `specific` (82–86) and dropped `clear` to 38–45. Calling the
  post "real" instead of naming Tideline failed `real_or_made_up`.

**Checked:**
- Every claim in the five posts is in that video's brief, and the gate passed in every run.
- X length: X counts some characters, such as arrows, as two. None of the five posts has one, so each is within 280.
- **One judge error:** F round 7, Draft C, got Cloudflare HTTP 429 on five Clef criteria. Verdict marked the
  evaluation completed and counted the errored criteria as 0, so 78 became 43. The round was run again with the same
  drafts; the first result is kept in `f/rounds/7/scores-429.txt`. [`score.sh`](score.sh) now prints `JUDGE ERROR`
  when any criterion errors.
- **My own slips:** five times I sent a draft over 280 characters to scoring without counting first. `fits` failed
  each one, and the next round shortened it.

## Files

| | |
| --- | --- |
| [`caption-review.yaml`](caption-review.yaml) | The rubric |
| `<video>/brief.md` | The facts each post may use |
| `<video>/drafts/` | The three drafts as they stand now |
| `<video>/rounds/<n>/` | Each round's drafts and `scores.txt` |
| [`score.sh`](score.sh) `<video> <round>` | Scores one round and keeps it |
| [`probe.sh`](probe.sh) `<video> <file>...` | Scores loose drafts, for testing the rubric; `PEEK=<criteria>` prints the judges' probabilities |
| [`peek.py`](peek.py) `<video> [criteria]` | The judges' probabilities for a video's latest round |

# Topic test: which demo gets the best response on X?

**Status: design (2026-11-08). Nothing posted yet.**

Five videos show five use cases for Verdict. The question is which one developers on X respond to most, because that
is the use case to lead with on the site, in the next videos and in the launch post.

**Decided (2026-11-08):**
- **Organic posts only**, no paid ads.
- **Primary metric:** attention.
- **Format:** whichever X shows larger in the phone timeline (checked in prep, below).
- **Length:** every video re-rendered to **30.0 s**.

| Arm | Topic (use case) | Take | Post, round 1 | Post score |
| --- | --- | --- | --- | --- |
| **B** | An AI one-shot landing page with fake testimonials, 0 → 93 | [`../landing-ui-loop/`](../landing-ui-loop) | [`b/drafts/a.md`](../post-loop/captions/b/drafts/a.md) | 93 |
| **C** | A hackathon write-up, 5th → 1st | [`../ranking-loop/v2/`](../ranking-loop/v2) | [`c/drafts/b.md`](../post-loop/captions/c/drafts/b.md) | 91.5 |
| **D** | Does the AI judge agree with people? 57% → 76% | [`../judge-loop/`](../judge-loop) | [`d/drafts/c.md`](../post-loop/captions/d/drafts/c.md) | 92.5 |
| **E** | A sponsored script, reject → approve | [`../sponsor-loop/v2/`](../sponsor-loop/v2) | [`e/drafts/b.md`](../post-loop/captions/e/drafts/b.md) | 90.5 |
| **F** | Our own launch post, 0 → 88 | [`../post-loop/v2/`](../post-loop/v2) | [`f/drafts/c.md`](../post-loop/captions/f/drafts/c.md) | 89.7 |

**Left out:** video G (Korean detail page). It speaks to Korean sellers, not developers on X; it can be a separate
test later.

## The 30-second cuts

Each take has a `take-1/warp-30s.json` next to its original `warp.json`. The results play at the same speed as before
(1–2×; in D, 2× instead of 1.5×), and only the waiting and reading parts in between run faster. Every speed is a whole
number, so the on-screen label stays readable. Any gap left is filled by holding the last frame.

| Arm | Before | Fast parts, before → after | After |
| --- | --- | --- | --- |
| B | 29.2 s | 20–80× → 19–75× | 30.0 s |
| C | 31.3 s | 5–15× → 6–16× | 30.0 s |
| D | 35.8 s | 8–14× → 9–15×, results 1.5× → 2× | 30.0 s |
| E | 30.9 s | 5–12× → 6–13× | 30.0 s |
| F | 34.2 s | 5–12× → 9–20× | 30.0 s |

Each take README has the render command; use `--warp take-1/warp-30s.json`, with `--layout vertical` for the
vertical cut. The MP4s aren't committed.

## What varies and what is held constant

The topic is the only thing meant to vary. Everything else is held constant, or balanced across the posts:

| | How |
| --- | --- |
| **Post text** | All posts are written to the same rubric (`../post-loop/captions/`, pass 90) and share one shape: "X scored 0 → result", what Verdict is, one limit, a question. Round 2 uses a second caption per topic, so one strong line can't carry a topic |
| **Video** | Same length (30.0 s) and same format. Every cut opens on the finished result |
| **Time** | One post per weekday, at the same local time |
| **Order** | Round 1 was drawn at random (seed 20261108): **F, C, B, E, D**. Round 2 runs in reverse: **D, E, B, C, F**. Each topic gets one early and one late slot, so a steady drift over the two weeks (follower growth, the account warming up) affects every topic about equally |

**Why two rounds:** one organic post per topic can't separate the topic from the day it went out. A topic counts as the
winner only if it wins in both rounds.

## Metrics (fixed before the first post)

- **Primary (attention): views watched to the end per impression.**
  - It is computed as video views × completion rate ÷ impressions.
  - It counts people who stopped scrolling and kept watching. With every video at 30 s, the comparison is fair.
  - Impressions and video views come from the post's analytics. Completion rate comes from Media Studio's video
    analytics.
- **Fallback:** if the account can't see completion rate, the primary is **video views per impression**. Check this in
  prep and set `PRIMARY` in [`analyze.py`](analyze.py) **before the first post**; don't change it afterwards.
- **Secondary (direction only):**
  - Views per impression.
  - Intent: follows + profile visits + bookmarks per 1,000 impressions.
  - Conversation: replies + quotes per 1,000.
  - Reposts per 1,000.
  - Reach (impressions).
  - Likes are recorded but not used.
- **When to read:** each post's numbers **48 hours** after it goes up, for every post.
- **Decision rule:** a topic wins only if both are true:
  1. Its chance of being best, pooling both rounds, is **≥ 90%**.
  2. It is **first in each round**.

  Otherwise there is no winner on attention. The leading topics are then compared on the secondary metrics and the
  replies.
  - Pooling treats every impression as independent, which overstates the certainty: posts on different days vary more
    than that. That is why the topic also has to win each round.

## How big a difference this can see

Organic reach is small, so this test can only see large differences:

```bash
python3 analyze.py detectable --impressions <impressions per post> --base <primary rate>
```

| Impressions per post | Primary rate 3% | Primary rate 6% |
| --- | --- | --- |
| 300 | one round +219%, two pooled +141% | one round +136%, two pooled +91% |
| 800 | +119%, +79% | +77%, +52% |
| 2,000 | +70%, +47% | +46%, +32% |

Smallest relative lift of the best topic over each other topic, at 80% power and α = 0.05 with a Bonferroni
correction. For example, at 800 impressions and a 6% base rate, the winner needs about 9.1% against 6%. A smaller real
difference ends as "no winner", and the replies then carry the decision.

## Prep

1. **Format:**
   - Render both 30-second cuts of one topic (vertical 1080×1920 and wide 1920×1080).
   - Attach each to a new post in the X app on a phone and look at the preview, without posting.
   - Use the one shown larger, for every topic.
   - If the vertical cut is cropped in the timeline, check that the score and the terminal stay in frame.
   - Guides disagree on how X crops 9:16 video in the feed, so this check is the deciding test.
2. **Metric:** check whether the account can see completion rate (Media Studio, on an older video). Set `PRIMARY`.
3. **Round 2 captions:** write a second caption per topic to the same rubric, average ≥ 90. The current runner-ups score
   88 (B), 91 (C), 84 (D), 88 (E) and 89 (F). They are a starting point, but D's needs work.
4. **Predictions:** write them in [`predictions.md`](predictions.md) before the first post.
5. **Record sheet:** copy [`results/template.csv`](results/template.csv) to `results/posts.csv`. It has one row per post,
   already in posting order.

## Running it

- **Weeks 1–2:** one post per weekday at the same time:

  | | Mon | Tue | Wed | Thu | Fri |
  | --- | --- | --- | --- | --- | --- |
  | Week 1 (round 1) | F | C | B | E | D |
  | Week 2 (round 2) | D | E | B | C | F |

- **Record:** 48 hours after each post, enter its numbers in `results/posts.csv`, including the time it was posted.
- **Don't post anything else** on the account during the two weeks, apart from replies, and don't pin any of the five
  posts.
- **Replies:** answer them all the same way, briefly and within a day. A long thread under one post would lift that
  post alone.
- **Code each reply** by what it asks about (the use case, how the judge works, price or access, doubt) and keep the
  count per topic.
- **Then:**

  ```bash
  python3 analyze.py results results/posts.csv
  ```

  The output gives each round's ranking, the pooled rate with its 95% interval, each topic's chance of being best, the
  decision and the secondary metrics.

## Predictions

[`predictions.md`](predictions.md) records three rankings before the first post:
- The founder's.
- Claude's.
- The caption rubric's post scores.

After the test, each is compared with the real ranking. Five topics are too few to prove anything; it shows only
whether a prediction was close. The caption rubric scores how well a post is written, not how interesting its topic
is.

## What can still go wrong

- **Repeat exposure:** some followers see each topic twice. Every topic has this in round 2, so it lowers round 2's
  numbers but not the comparison.
- **Outside events:** a big news day can bury one post. Note anything unusual next to that row. If one post is clearly
  off for that reason, post it again at the end of week 2 with its round-2 caption, and say so in the results.
- **Followers ≠ all developers:** organic posts reach the account's followers first, so the result says what *they*
  respond to.
- **Analytics access:** some account-level analytics need X Premium. This plan uses per-post numbers and Media Studio.
  X has also changed how it counts video views, so compare posts only within this test.

## Files

| | |
| --- | --- |
| [`analyze.py`](analyze.py) | `detectable` (how big a difference the test can see) and `results` (per-round ranking, pooled rates, chance of being best, decision); standard library only |
| [`results/template.csv`](results/template.csv) | One row per post, in posting order, with the columns `analyze.py` reads |
| [`predictions.md`](predictions.md) | Rankings written before the first post |

Sources: [Media Studio analytics](https://help.x.com/en/using-x/media-studio-analytics) (views, completion rate,
average watch time); on X's timeline crop of 9:16 video, third-party guides disagree, e.g.
[aspect ratio guide](https://aspectratiocalculator.pages.dev/blog/aspect-ratio-guide-twitter-x) and
[socialk.it](https://socialk.it/en/sizes/x-video-size), which is why prep checks it on a phone.

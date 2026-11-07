# Video F v2: our launch post climbs from 0 to "post it", one check per review

**Status: Take 1 recorded (2026-11-07). Cuts: vertical and wide, 34 s.**

The first video F (in [`../take-1/`](../take-1)) compared three drafts that already scored 80–90, so the climb was
small and hard to read. In this version:
- **The setup:** one post, our own X launch post for video B, in the form an AI first writes it: self-praise, a
  promise we can't back, Unicode "bold" letters, cc'd accounts and five hashtags.
- **The loop:** the agent fixes one failing check per review and evaluates again.
- **On screen:** `verdict watch` shows the post with the changed lines marked, the score history and every criterion.
  Three of the checks are plain regex, and the page shows the pattern and its match count next to the model judges.

| | |
| --- | --- |
| Start | [`start/post.md`](start/post.md) and [`start/brief.md`](start/brief.md) (the facts the post may use; video B's brief plus "the video is attached") |
| Rubric | [`post-review-strict.yaml`](post-review-strict.yaml) |
| Calibration | [`cal/steps.py`](cal/steps.py) writes the start post with one more fix per step; [`cal/mcp-score.mjs`](cal/mcp-score.mjs) evaluates them through the MCP server, as the agent does |
| Take 1 | [`take-1/`](take-1): prompt, speed schedule, recording (cast, transcript, store snapshots), final post |

## Research behind the rubric (2026-11-07)

Platform rules, guidelines and case law, plus summaries of them. Most primary pages couldn't be fetched from this
session (blocked hosts), so search summaries and secondary write-ups were used; links point to the primary page where
there is one.

| Topic | What the sources say | Where it went |
| --- | --- | --- |
| Claims | FTC Act §5: a claim needs a basis. [FTC v. Colgate-Palmolive (1965)](https://law.cornell.edu/supremecourt/text/380/374): presenting a mock-up as a real demonstration is a material deception; "dramatization" disclaimers followed | Gate `claims_true`: anything beyond the brief scores 0. Check `fiction_flagged`: say the product in the demo (Tideline) is fictional |
| Hype | [HN guidelines](https://news.ycombinator.com/newsguidelines.html): don't use uppercase or exclamation points for emphasis, or say how great it is; moderators call marketing tone a turn-off | `no_hype` (Clef) |
| Limits | [Show HN](https://news.ycombinator.com/showhn.html) and launch guides built on it: early work is fine; state limitations plainly | `limits`: say what didn't go smoothly (two rounds barely moved) |
| Hashtags | [X Help Center](https://help.x.com/en/using-x/how-to-use-hashtags): no more than 2 hashtags per post | `hashtags`: regex, fails at 3 or more |
| Mentions | [X Rules, platform manipulation and spam](https://help.x.com/en/rules-and-policies/platform-manipulation): no bulk, unsolicited mentions | `mentions`: regex, fails on any `@handle` (the brief names none) |
| Accessibility | [Axbom](https://axbom.com/dont-fake-bold-and-italic-text-with-unicode), [Stanford UIT](https://uit.stanford.edu/accessibility/learn-about/typography/italics-bold): screen readers read Unicode "bold" as "mathematical bold capital …", and search misses it | `styled_text`: regex over U+1D400–U+1D7FF |
| Clarity | [Paul Graham, How to apply](https://www.ycombinator.com/howtoapply.html) and Startup School talks: say what it is first, in the simplest terms | `what_it_is`: say what Verdict is |
| Replies | X's open-sourced ranker ([the-algorithm-ml](https://github.com/twitter/the-algorithm-ml), 2023 README; [summary](https://dev.to/septim_labs/i-read-the-x-twitter-algorithm-source-for-4-days-and-built-a-claude-code-sub-agent-that-scores-1ipb)): a reply weighs 13.5, a like 0.5, a reply the author answers 75. Production weights have likely changed since | `question`: end with a question readers can answer from their own work |

**Left out:**
- **Alt text:** X has alt text for images and GIFs, but no source showed it for video.
- **Links in the post:** the claim that X cuts the reach of posts with links is disputed and changes often.
- **Length:** a 280-character check would couple with every check that adds a sentence.

## The rubric

```
claims_true < 0.5 ? 0 : (hook × 3 + specific × 2 + clear) / 6 × (1 + checks passed) / 9
checks = no_hype, hashtags, mentions, styled_text, fiction_flagged, what_it_is, limits, question
```

- **Judges:** Jev rates the quality criteria. Clef judges the gate and five checks. Three checks are `benchmark`
  regex judges, with no model.
- A claim the brief doesn't support scores 0. Past the gate, the post earns 1/9 of its quality score, plus 1/9 for each
  check it passes.
- Grades: post it ≥ 85, close ≥ 50, rework.

| Sentence in the start post | Fails |
| --- | --- |
| "It now fixes any landing page in minutes, guaranteed." | gate `claims_true` |
| "Honestly the most INSANE thing we've built!!!" | `no_hype` |
| "#AI #DevTools #buildinpublic #webdev #SaaS" | `hashtags` |
| "cc @AnthropicAI @github" | `mentions` |
| "𝗧𝗵𝗲 𝘀𝗰𝗼𝗿𝗲𝘀:" | `styled_text` |
| (missing) Tideline is fictional | `fiction_flagged` |
| "scored by Verdict." (no explanation) | `what_it_is` |
| (missing) two rounds barely moved | `limits` |
| (missing) a closing question | `question` |

## Calibration

Through the MCP path (labels `post.md` and `brief.md`, as the agent sends them), two runs per step:

| Step | 0 start | gate | no_hype | styled_text | hashtags | mentions | fiction | what_it_is | limits | question |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Run 1 | 0 | 9 | 20 | 30 | 40 | 50 | 61 | 71 | 80 | 91 |
| Run 2 | 0 | 10 | 20 | 30 | 41 | 51 | 61 | 70 | 80 | 91 |

Each step moved only the check it fixed.

**What changed during calibration:**
- **Hype placement:** the hype was first on the first line ("We just dropped our new demo and honestly it's the most
  INSANE…"). The hook then scored 3%, so fixing the gate added only 4 points and fixing the hype jumped 15. The start
  post now opens with the real result, and the hype is a separate sentence after it, so each fix adds about 10.
- **Pass mark:** with 7 of 8 checks passed, the post already scored 80. At 80 the run would stop one check early, so
  the pass mark is 85.

## Take 1 (2026-11-07)

Interactive Claude Code, unattended:
- **Tools:** Read, Edit and Write, plus the Verdict MCP server. No shell.
- **Prompt:** [`take-1/prompt.txt`](take-1/prompt.txt): edit only `post.md`, use only facts in `brief.md`, fix one
  failing criterion per round (gate first) and evaluate again. Stop at "post it" or after 12 evaluations.
- **Time:** 80 s from the first evaluation to the last; 1 min 38 s from submit to done.

| Round | Score | Grade | Fixed before this round (the agent's own log) |
| --- | --- | --- | --- |
| 1 | **0** | rework | (start) gate failed: "fixes any landing page in minutes, guaranteed" |
| 2 | **10** | rework | Gate: removed that sentence |
| 3 | **20** | rework | `no_hype`: removed "Honestly the most INSANE thing we've built!!!" |
| 4 | **30** | rework | `hashtags`: five down to two (#DevTools #buildinpublic) |
| 5 | **40** | rework | `mentions`: removed "cc @AnthropicAI @github" |
| 6 | **51** | close | `styled_text`: "𝗧𝗵𝗲 𝘀𝗰𝗼𝗿𝗲𝘀" → "The scores" |
| 7 | **61** | close | `fiction_flagged`: "Tideline (a fictional product)" |
| 8 | **70** | close | `what_it_is`: "Verdict, an evaluation engine that scores work against a rubric" |
| 9 | **80** | close | `limits`: "Two rounds barely moved because the fix was partial." |
| 10 | **88** | **post it** | `question`: "What check would you add before you let an agent ship your landing page?" |

Each round moved exactly the check it fixed. The quality scores stayed at hook 97–100 and specific 92–97.

**Checked:**
- Only `post.md` changed ([`take-1/post-final.md`](take-1/post-final.md)), and every claim in it is in the brief.
- **The agent's own caveats:**
  - `clear` is the weakest score (44%), and it fell as required sentences were added.
  - `what_it_is` passed at 77%, so it is the check most likely to flip on a rerun.
- The first two sentences of the final post both say "an AI one-shot landing page". The repetition comes from the
  start post, and the agent left it there because no check asked about it.

## The cut

[`../../watch-recording/plain2pane-watch.mjs`](../../watch-recording/plain2pane-watch.mjs) with
[`take-1/warp.json`](take-1/warp.json):
- **Speed:** each new result plays at 1.2× (the final one at 1×), and the waiting in between at 5×. The agent reading
  the files plays at 12×.
- **Cold open:** 1.6 s of the passing result first.
- **Labels:** the speed is printed, and the model and plan label is blanked in the committed cast and transcript.
- **Nothing is cut.**

```bash
XTERM_MODULES=<dir with @xterm/xterm> node ../../watch-recording/plain2pane-watch.mjs take-1/recording take-1/recording/snapshots out.mp4 --warp take-1/warp.json --title "claude — ~/launch-post" --url "127.0.0.1:4614 — verdict watch" --layout vertical
```

The caption is in [`../f-post/`](../f-post).

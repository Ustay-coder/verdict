# Video E v2: a sponsored script goes from reject to approve, one rule per round

**Status: Take 1 recorded (2026-11-07). Cuts: vertical and wide, 31 s.**

The first video E (in [`../`](..)) had one problem in its script: a single sentence failed the brand-safety gate, the
agent deleted it, and the score went 0 → 94 in one step. Nothing climbed. In this version:
- **The setup:** a fictional creator's script for a fictional budgeting app breaks the rules a real sponsored video has
  to follow, eight of them. They come from regulators' guides, not from taste.
- **The loop:** the agent fixes one failing criterion per round (the gate first) and evaluates again.
- **On screen:** the live `verdict watch` page shows the script with the changed lines marked, the score history and
  every criterion with the judge's reason.

| | |
| --- | --- |
| Script | [`start/script.md`](start/script.md): Small Desk Studio's script for Tallyleaf |
| Brief | [`start/brief.json`](start/brief.json): the brand's brief (audience, talking points, disclosure, offer terms, must-not list, competitors) |
| Creator's notes | [`start/notes.json`](start/notes.json): what actually happened in the creator's month. Every personal experience in the script must match it |
| Rubric | [`sponsor-review-strict.yaml`](sponsor-review-strict.yaml) |
| Calibration | [`cal/mcp-score.mjs`](cal/mcp-score.mjs) `<script.md>...`: evaluates scripts the way the agent does, through the MCP server, and prints every criterion. [`cal/steps.py`](cal/steps.py) writes the start script with one more fix per step. [`cal/score.sh`](cal/score.sh) does the same through the CLI (labels differ, see below) |
| Take 1 | [`take-1/`](take-1): prompt, speed schedule, recording (cast, transcript, store snapshots), final script |

## Research behind the rubric (2026-11-07)

The FTC, eCFR, govinfo and YouTube help pages couldn't be fetched from this session, so the rules below come from
search results and law-firm summaries of those sources. Each is cited where it went.

| Rule | What the sources say | Where it went |
| --- | --- | --- |
| No credit-approval promises | The FTC treats false approval claims as deceptive under section 5 of the FTC Act: Credit Karma's "pre-approved" offers, of which almost a third were denied, cost it $3M in 2022 ([PYMNTS](https://www.pymnts.com/legal/2022/ftc-fines-credit-karma-3m-for-false-pre-approvals/), [JD Supra](https://production.jdsupra.com/legalnews/ftc-finalizes-credit-karma-order-3015984)) | Gate `claims_safe` |
| Not a bank, not FDIC-insured | FDIC Part 328 (final January 2024): a statement that implies a non-bank or its product is FDIC-insured is a misrepresentation; cease-and-desist letters followed ([Federal Register](https://www.federalregister.gov/documents/2024/01/18/2023-28629/fdic-official-signs-and-advertising-requirements-false-advertising-misrepresentation-of-insured), [FDIC letter](https://www.fdic.gov/resources/regulations/laws/section-18a4-of-fdi-act/letters/2024-01-19-ogpay.pdf)) | Gate `claims_safe` (brief's must-not list) |
| Finfluencers | UK FCA FG24/1 (March 2024): a financial promotion on social media, influencers included, must be fair, clear and not misleading ([FCA](https://fca.org.uk/publications/finalised-guidance/fg24-1-finalised-guidance-financial-promotions-social-media), [CMS](https://cms.law/en/int/legal-updates/fca-publishes-finalised-guidance-on-financial-promotions-on-social-media)) | Gate `claims_safe` |
| Disclose upfront, in the video | FTC *Disclosures 101* (2019): "the disclosure should be in the video and not just in the description"; not only at the end of a video; unambiguous words; audio and on-screen text together are more likely to be noticed ([Manatt](https://www.manatt.com/insights/newsletters/advertising-law/ftc-issues-disclosures-guide-for-social-media), [Loeb](https://www.loeb.com/en/insights/publications/2019/11/ftc-releases-sponsorship-disclosure-guide-for-influencers-on-social-media)). ASA research (UK): "upfront and immediately visible", "#ad" or "Ad" as the clearest label ([ASA report](https://www.asa.org.uk/static/2483d078-6689-449c-a946afa3990900d2/74d4641c-d826-4604-90388b880ab40fa5/Consumer-awareness-and-understanding-of-influencer-marketing-summary-report.pdf)) | `disclosure`: said in the first 30 seconds, before the app, with "Paid ad" on screen; a "thanks to my friends at" at the end doesn't count |
| Speak only to your own experience | FTC Endorsement Guides (16 CFR 255, revised 2023): an endorser must be a real user and reflect their honest experience ([Arnold & Porter](https://www.arnoldporter.com/en/perspectives/advisories/2023/07/ftc-endorsement-guides), [Wiggin](https://www.wiggin.com/publication/the-ftc-has-revised-its-endorsement-and-testimonial-guides/)) | `own_experience`: judged against `notes.json` |
| A personal result isn't a promise | Endorsement Guides 255.2(b): without proof that the endorser's result is what consumers will generally get, the ad must say what they can expect ([King & Spalding](https://www.kslaw.com/news-and-insights/ftc-revamps-the-guides-concerning-the-use-of-endorsements-and-testimonials-in-advertising), [Frankfurt Kurnit](https://advertisinglaw.fkks.com/post/102hpkl/part-iii-ftcs-proposed-revisions-to-the-endorsement-guides-consumer-endorsem)) | `typical_results` |
| Free trials say what they turn into | ROSCA: the material terms of a negative-option offer, such as a free trial that becomes paid, must be disclosed clearly ([Kelley Drye](https://www.kelleydrye.com/viewpoints/blogs/ad-law-access/ftc-settlement-addresses-free-trials-and-incentivized-reviews)). ASA/CAP: the price after a free trial is material and must be in the ad (Amazon Prime 2015, NOW TV 2024) ([Lewis Silkin](https://adlaw.lewissilkin.com/post/102ibs6/free-trials-put-on-trial), [ASA ruling](https://www.asa.org.uk/rulings/sky-uk-ltd-a24-1229858-sky-uk-ltd.html)) | `trial_terms`: $4.99 a month unless you cancel, where the offer is made |
| Brief practice | Agency and creator brief guides: about three priority talking points, the call to action and code, and an explicit rule on naming competitors ([Teleprompter](https://www.teleprompter.com/blog/how-to-create-sponsored-content), [Kingy AI](https://kingy.ai/news/youtube-sponsored-video-brief-builder/)) | `talking_points`, `call_to_action`, `no_competitor` |
| An honest review has a downside | Endorsement Guides: endorsements reflect the endorser's honest opinion; FCA: balanced. A sponsored review that calls the product perfect reads as ad copy | `drawback`, and `voice` in the quality score |

## The rubric

```
claims_safe < 0.5 ? 0 : (audience × 3 + shown × 2 + voice) / 6 × (1 + checks passed) / 9
checks = disclosure, own_experience, typical_results, trial_terms, no_competitor, talking_points, call_to_action, drawback
         (Clef, binary, judged against brief.json or notes.json)
```

- A claim on the brief's must-not list scores 0.
- Past the gate, the script earns 1/9 of its quality score (Jev), plus 1/9 for each check it passes.
- Grades: approve ≥ 80, revise ≥ 50, reject.

**The start script** breaks the gate and seven checks, one sentence each; only the call to action is right:

| Sentence in the start script | Fails |
| --- | --- |
| "Tallyleaf guarantees you'll be approved for a credit line, no credit check, 100% of the time." | gate |
| "Huge thanks to my friends at Tallyleaf for making this video possible!" (the last line, and the only mention) | `disclosure` |
| "I've used Tallyleaf every day for two years now" (the notes say 30 days) | `own_experience` |
| "Use it for a month and you'll spend at least $300 less." | `typical_results` |
| "Try it free with code SMALLDESK." (no price after the free month) | `trial_terms` |
| "Honestly, it's so much smarter than BudgetBee." | `no_competitor` |
| No word about the alert the day before a subscription renews | `talking_points` |
| "Honestly, it's the best app on my phone." | `drawback` |

**Calibration** (`cal/steps.py`, one fix per step, in this order; `cal/mcp-score.mjs`, two runs agreed within 1 point):

| Step | Score | Grade |
| --- | --- | --- |
| start | 0 | reject (gate) |
| gate | 17 | reject |
| disclosure | 26 | reject |
| own_experience | 36 | reject |
| typical_results | 46 | reject |
| trial_terms | 55 | revise |
| no_competitor | 67 | revise |
| talking_points | 78 | revise |
| drawback | **95** | **approve** |

- **Coupled checks:** in the first drafts, a fix moved two criteria at once or none:
  - "It's honestly perfect. I can't think of a single thing I'd change" contradicts the drawbacks in the notes, so
    `own_experience` failed until `drawback` was fixed. The line became "the best app on my phone", and the
    `own_experience` anchor now leaves opinions to other criteria.
  - "you'll save at least $300 a month too" read as the creator's own result, so it failed `own_experience` too. It
    now reads "Use it for a month and you'll spend at least $300 less."
- **Facts the script needs:** the notes got the September figures (rent up $150, $214 of forgotten spending), so the
  opening's numbers are true.
- **Audience:** the start script already talks to renters with a roommate, so the quality score is high from the start
  and each check adds about 10 points.
- **Input labels matter:** the CLI labels `-i script=script.md` as `script`; the MCP server, which the agent uses,
  labels it `script.md`. Clef's distributions moved with the label: the same text failed `own_experience` through the
  CLI and passed it through MCP (even a file named `take-r2.md` passed). Calibration now goes through MCP like the
  agent ([`cal/mcp-score.mjs`](cal/mcp-score.mjs)).
- Through the same path, Clef's distributions repeat exactly across runs.

## A take that didn't make it

The first take (same prompt) went 0 → 26 → **24** → 34 → 44 → 54 → 62 → 74 → 85. In round 2 `own_experience` passed
although the script still said "every day for a year now" (67% matches), and in round 3 it failed again (71%
mismatch), so fixing the disclosure looked like it cost 2 points. The agent flagged this itself. The cause was the
label difference above: through MCP, "a year" sat near the line. The start script now says "two years", which fails
`own_experience` through MCP in every round text tried, and the anchor names `days_used` directly.

## Take 1 (2026-11-07)

Interactive Claude Code, unattended:
- **Tools:** Read, Edit and Write, plus the Verdict MCP server. No shell.
- **Prompt:** [`take-1/prompt.txt`](take-1/prompt.txt): edit only `script.md`, keep the creator's voice, say nothing
  about their month that isn't in `notes.json`, fix one failing criterion per round (gate first) and evaluate again.
  Stop when approved or after 10 evaluations.
- **Time:** 1 min 26 s from submit to done.

| Round | Score | Grade | Fixed before this round (the agent's own log) |
| --- | --- | --- | --- |
| 1 | **0** | reject | (start) gate failed: guaranteed credit-line approval |
| 2 | **17** | reject | Gate: removed the credit-approval line |
| 3 | **25** | reject | `disclosure`: `[On screen: "Paid ad"] Quick heads-up: Tallyleaf paid me for this video.` as the first line |
| 4 | **34** | reject | `own_experience`: "every day for two years" → "for 30 days, October 1 to October 30" |
| 5 | **43** | reject | `typical_results`: "you'll spend at least $300 less" → "That's my number; yours will be different." |
| 6 | **52** | revise | `trial_terms`: "After that it's $4.99 a month unless you cancel, and you can cancel anytime in the app." |
| 7 | **61** | revise | `no_competitor`: removed "so much smarter than BudgetBee" |
| 8 | **74** | revise | `talking_points`: the alert the day before a subscription renews, and the two it cancelled ($19 a month, from the notes) |
| 9 | **85** | **approve** | `drawback`: small charts on a phone, the web app in beta, the rent transfer sorted as "shopping" |

Each round moved exactly the check it fixed; the quality scores stayed at audience 92–97, shown 81–93.

**Checked:**
- Only `script.md` changed ([`take-1/script-final.md`](take-1/script-final.md)). Every personal detail it added is in
  `notes.json`.
- **The agent's own caveats:** `voice` is still the weakest score (34%): "it changed everything", "the best app on my
  phone" and the "Huge thanks to my friends at Tallyleaf" line at the end remain. It left them as the creator's words.
  The timestamps after the longer lines are now estimates.

## The cut

[`../../watch-recording/plain2pane-watch.mjs`](../../watch-recording/plain2pane-watch.mjs) with
[`take-1/warp.json`](take-1/warp.json):
- **Watch page:** the script with the lines changed since the previous evaluation marked, the score, the history
  (0 → 17 → … → 85) and every criterion with its judge's distribution.
- **Speed:** each new result plays at 1.2× (the final one at 1×), and the waiting in between at 5×. The agent reading
  the files plays at 12×.
- **Cold open:** 1.6 s of the approved result first.
- **Labels:** the speed is printed, and the model and plan label is blanked.
- **Nothing is cut.**

```bash
XTERM_MODULES=<dir with @xterm/xterm> node ../../watch-recording/plain2pane-watch.mjs take-1/recording take-1/recording/snapshots out.mp4 --warp take-1/warp.json --title "claude — ~/sponsor-review" --url "127.0.0.1:4613 — verdict watch" --layout vertical
```

The caption is in [`../../post-loop/e-sponsor/`](../../post-loop/e-sponsor).

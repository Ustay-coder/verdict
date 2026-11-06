# Video 2: "Our rubric said 92. The founder said: still AI."

**Status: final cut rendered (58 s, 1080p, synthesized SFX).** It replaces the plan below (written before Take C/D).
The story is the rubric learning from a person's judgement. Every number on screen is a real Verdict result, and
every page is a render of a real state of the agents' files.

| Time | Scene | Source |
| --- | --- | --- |
| 0:00–0:03 | The AI one-shot dashboard | `start/` |
| 0:03–0:11 | X-ray (77 audit boxes), then Take B's 6 steps with the v1 score 27 → 42 → 42 → 48 → 51 → 92, **SHIP IT** stamp | audit scorer · `take-b/evaluations.json` |
| 0:11–0:15 | *"Still looks AI-made."* (the founder). The new rubric agrees: 92 → **49**; second-order AI default · decorative donut · an inventory, not answers | founder feedback · v2.1 re-score |
| 0:15–0:20 | The 13 principles appear (P12–P13 in amber), with the sources | `PRINCIPLES.md` |
| 0:20–0:28 | Take C: **82 · PASSED** under v2, the founder says "still AI", v2.1's X-ray (one-edge bar, 3 numbered headings, 2 sentences written for the judge, Inter on 100% of glyphs): 82 → **71** | `take-c/` · audit + P12 |
| 0:28–0:49 | Take D split screen: live page render per edit, v2.1 score card 33 → 79 → 78 → **84**, the brief chip (100), terminal PiP, speed chip | `take-d/` · the cast |
| 0:49–0:54 | Before/after wipe: one-shot 33 vs Take D 84 | renders |
| 0:54–0:58 | End card: *Write down what good means. Let the agent argue with it.* + disclosure | |

Honesty notes: the two "copy written for the judge" boxes mark the sentences behind P12's 10% (located by text
search; the judge scores the page, not sentences). Take B's v2.1 score (49) and Take C's (71) are re-scores made after
the runs. Waiting time is compressed up to 50× in the Take D section, and the chip shows it. The founder's line is a
short English rendering of their feedback. Confirm the wording before posting.

**Founder VO (optional, same format as video 1):** 01 0:00–0:03 "We asked an AI for a modern, beautiful dashboard." ·
02 0:03–0:11 "An agent fixed it until our rubric said yes. Twenty-seven to ninety-two." · 03 0:11–0:15 "I said it still
looked AI-made. I was right." · 04 0:15–0:20 "So we rebuilt the rubric from the books." · 05 0:20–0:28 "Take two passed.
Still AI. The new rubric caught why." · 06 0:28–0:49 "Take three: brief first, then the page. Seventy-nine… seventy-eight…
eighty-four." · 07 0:49–0:58 "Same data. Same agent. A better rubric."

Tools: `recording/video2_assets.mjs` → `recording/video2_edit.mjs` (writes `<out>.cues.json`) → `recording/video2_sfx.py`.

---

## Plain working video (no effects): Take D

Same format as the landing-page video: Claude Code on the left, the dashboard on the right, nothing added.
[`recording/plain2pane-html.mjs`](recording/plain2pane-html.mjs) builds it.
- **Left:** Take D's recorded terminal bytes, replayed at their recorded times.
- **Right:** the real page, reloaded at the exact moment each `Write`/`Edit` landed. It's rendered 1280 px wide (as
  Verdict's renderer saw it) and shown at 0.875×. `data.json` comes from a routed virtual host, so no port is opened.
- **First half:** the page stays the AI one-shot while the agent writes and scores its brief. That is what happened:
  the first rewrite lands 2 min 6 s into the run.
- **Cuts:** real time (5:08) and uniform 3× (1:43) and 5× (1:02), each labelled with its speed.

# (Earlier plan, before Take C/D)

# "Every AI dashboard looks like this": an agent redesigns one, judged by what Verdict sees

**Logline.** We asked an AI for a "modern, beautiful" SaaS dashboard. It made the dashboard every AI makes: dark
purple glow, gradient text, glass cards. Verdict, which now **looks at the screenshot**, called it a generic template:
27/100. Then an agent fixed one weakness at a time. Scrubbing off the AI tells only got it to **51**. Redesigning it
got it to **92**. Every frame and number comes from one real run (**Take B**, 2026-11-05).

| | |
| --- | --- |
| Channel | X (developers, designers, founders) |
| Format | 16:9 1920×1080, captions burned in, ~48 s |
| Assets | Start page [`start/`](start) (AI one-shot + its prompt + fictional data) · rubric [`dashboard-design.yaml`](../../rubrics/dashboard-design.yaml) · scorer [`audit/server.mjs`](audit/server.mjs) · Take B [`take-b/`](take-b) |

## Why this works now

Verdict used to see only text, which is useless for a UI. This video depends on the new `image` input and `url`
`screenshot` option. The CLI/MCP render the page with Playwright and send the screenshot to Clef. Verified live:
on the same question a gradient page scored 0.93–0.98, a white page 0.02–0.05, and the request with no image 0.49.

## The rubric: three judges, one page

| Judge | Criteria | Sees |
| --- | --- | --- |
| **Clef (vision)** | Not a generic AI template · Visual craft · One clear focal point | the 1280×800 screenshot |
| **Jev (text)** | Every figure matches `data.json` (gate) | page text + `data.json` |
| **Render audit** (`http` benchmark) | WCAG contrast · decorative effects · infinite animations · type scale · hue families | the rendered DOM, with offending boxes |

The score is multiplicative: **looks earn the points, measured checks can only take them away.**
`(template_look·3 + craft·2 + focus·2)/7 × (0.55 + 0.45 × measured)`. Calibration showed why: under a plain
weighted mean, a bare unstyled HTML page scored 86 because it passes every check. With the formula it scores 43.
Live calibration: AI one-shot **26**, designed reference ([`calibration/good`](calibration/good)) **92**,
bare page ([`calibration/bare`](calibration/bare)) **43**.

## Start page: a real one-shot

A fresh Claude Code session got only `data.json` and this prompt ([`start/prompt.txt`](start/prompt.txt)):

> Build a modern, beautiful SaaS analytics dashboard for Acme Pulse using the numbers in data.json. Put everything in a
> single self-contained index.html (inline CSS and JS, no external requests). Make it pop.

It worked for 3 minutes and produced [`start/index.html`](start/index.html). It's polished, and every figure is
right. It also has **43 decorative effects, 8 infinite animations, 12 font sizes, 7 hue families**, and Clef rates
it *generic 76%*. The generation was recorded too (a 15 s "watch the AI build it" clip for a reply).

## Take B: what actually happened

Interactive Claude Code, unattended, with `Read`/`Edit`/`Write` + the Verdict MCP server and no shell. The rule was
"fix only the weakest criterion per rewrite, don't touch data.json" ([`take-b/prompt.txt`](take-b/prompt.txt)).
The agent worked for 4 min 49 s and made 85 edits over 5 rewrites.

| Step | Fixed | Score | What changed on screen |
| --- | --- | --- | --- |
| 0 | (baseline) | **27** rework | Purple aurora, gradient headline, glass cards, glowing donut |
| 1 | `decoration` | **42** | Aurora, gradient text, glass blur, glows, SVG glow filter gone. Still dark purple |
| 2 | `motion` | **42** (+0) | Shimmer, ping and drift animations removed. **No visible change, no points** |
| 3 | `type_scale` | **48** | 12 font sizes → 5 |
| 4 | `palette` | **51** | 7 hue families → 2 (violet + green). It still looks like a template |
| 5 | `template_look` | **92** ship it | **The redesign:** warm light surface, one orange accent, plain cards |

Every row is the agent's own `evaluate` result ([`take-b/evaluations.json`](take-b/evaluations.json)), and
[`take-b/evaluated/`](take-b/evaluated) holds the page at each evaluation. All 86 states were rebuilt by replaying
the 85 edits onto `start/index.html`, and the last one matches the agent's file byte for byte. Re-scoring the
final page gives 93 twice. `data.json` was not modified.

**The line the video is built around:** *Removing the AI tells got it from 27 to 51. Designing it got it to 92.*

## Shot list (~48 s)

The layout flips from video 1. The **page is the hero** (left, 1180 px wide, the real render of the file at that
moment). On the right column: the score card on top, the four measured counters below it, and the terminal
picture-in-picture at the bottom. Red **X-ray boxes** come from the audit scorer's `boxes` for the current state.

| # | Time | Screen | Caption |
| --- | --- | --- | --- |
| 1 | 0:00–0:03 | The one-shot dashboard full screen, slowly scrolling | **We asked an AI for a "modern, beautiful" dashboard.** |
| 2 | 0:03–0:06 | X-ray: 43 red boxes + 8 amber animation boxes pop in; stamp **27/100 · generic template** | **Verdict looked at it. 27/100.** |
| 3 | 0:06–0:09 | Three judge chips: *Clef sees the screenshot · Jev checks every number · a renderer measures the DOM* | **Three judges. One page.** |
| 4 | 0:09–0:12 | Terminal: the rule typed in (sped up) | **Rule: fix only the weakest thing. Re-score. Repeat.** |
| 5 | 0:12–0:18 | Fix 1: boxes vanish as glows are deleted; counter *effects 43 → 0*; score **27 → 42** | **Delete the glow: +15** |
| 6 | 0:18–0:21 | Fix 2: animation boxes vanish; score stays **42** | **Delete the animation: +0.** · *checks can only take points away* |
| 7 | 0:21–0:26 | Fixes 3–4: sizes *12 → 5*, hues *7 → 2*; score **42 → 48 → 51** | **Clean, but still a template: 51** |
| 8 | 0:26–0:34 | Fix 5: the page re-renders as the theme flips dark → light; score **51 → 92**, green **SHIP IT** | **Then it actually redesigned it: 92** |
| 9 | 0:34–0:41 | Before/after slider wipe across the full page | **Removing AI tells isn't design.** |
| 10 | 0:41–0:45 | Score history bars 27 / 42 / 42 / 48 / 51 / 92 with the fixed criterion beside each | **5 rewrites. 85 edits. Under 5 minutes.** |
| 11 | 0:45–0:48 | End card: `verdict` · *Now it can see.* | *Rubric, prompts and every step in the replies ↓* |

Sound reuses video 1's system (`landing-loop/recording/sfx.py`): a tick as each box vanishes, a pop per edit, and
the score bell pitched by score. The flat 42 → 42 gets a deliberately dull note. The 51 → 92 jump gets the ship-it
chord. VO for the founder follows the same per-line format as video 1 (to be timed once the cut is rendered).

## Post copy

**Main post:**
> We asked an AI for a "modern, beautiful" dashboard. You've seen it before: purple glow, gradient text, glass cards.
>
> Verdict can now look at a screenshot. It said: generic template, 27/100.
>
> An agent fixed one thing at a time. Removing the AI tells: 51. Actually redesigning it: 92.

**Reply 1:** the rubric, both prompts, and the six evaluated states. **Reply 2:** how the three judges split the work,
and why the score is multiplicative (the bare-page calibration). **Reply 3:** the 15 s clip of the AI generating the
original.

## Notes and caveats

- **Count-up animations:** the original animates its KPIs, so a screenshot taken early shows `$48,199`. Video frames are
  captured after animations settle. The renderer used at evaluation time waits for `networkidle` only, so a
  settle delay option is a worthwhile engine follow-up.
- **The start page is good, not broken.** The story is generic → deliberate, not broken → fixed. Don't call it "slop" on screen.
- The data and company names are fictional (`start/data.json` says so). The page shows a "Sample data" badge.
- The terminal header in the recording shows the model name; same decision as video 1 (keep or crop).

## Recording

Servers: the page on `http://127.0.0.1:8766/` (`python3 -m http.server` in the work folder) and the scorer on
`:7788` (`node examples/demo/ui-loop/audit/server.mjs`). The work folder holds `index.html` (copy of `start/`),
`data.json`, `dashboard-design.yaml` and an `.mcp.json` like video 1's, plus `NO_PROXY=127.0.0.1,localhost` when
behind a proxy. Record with `landing-loop/recording/record.py` and rebuild states with
[`recording/build_states.py`](recording/build_states.py).

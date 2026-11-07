# Video B v2: an AI one-shot landing page, reviewed strictly, fixed one check at a time

**Status: Take 1 recorded (2026-11-07). Cuts: vertical and wide, 29 s.**

The first video B (the Primer dashboard, [`../ds-loop/`](../ds-loop)) jumped 19 → 76 → 82 in two rewrites, so the
change was hard to feel. This version:
- **Start page:** a landing page, a real AI one-shot.
- **Rubric:** much stricter: a gate plus six pass/fail checks.
- **Loop:** the agent fixes one check per round, so the score climbs in steps.

| | |
| --- | --- |
| Start page | [`start/index.html`](start/index.html): Claude Code's one-shot for *"Build a modern, beautiful SaaS landing page for Tideline, an uptime monitoring tool for small engineering teams … Make it pop."* Its reply is in [`start/oneshot-reply.txt`](start/oneshot-reply.txt) |
| Facts | [`start/facts.json`](start/facts.json): everything true about the fictional product. It has no customer quotes |
| Rubric | [`landing-review-strict.yaml`](landing-review-strict.yaml) |
| Scorer | [`../ds-loop/audit/server.mjs`](../ds-loop/audit/server.mjs) (port 7788) |
| Take 1 | [`take-1/`](take-1): prompt, speed schedule, recording (cast, transcript, store snapshots), the final page |
| Renderer | [`recording/plain2pane-page.mjs`](recording/plain2pane-page.mjs) |

## Research behind the rubric (2026-11-07)

These are mostly practitioner sources (blogs, guides, skill write-ups), not studies. Check them before quoting any as a fact.

| Topic | What the sources say | Where it went |
| --- | --- | --- |
| Fake social proof | The FTC's rule on consumer reviews and testimonials (16 CFR Part 465, in force since 2024-10-21) bans fake testimonials | Gate `honest_proof`: invented quotes, logos or user counts score 0 |
| AI-slop look | The recurring default: an Inter font, a purple-to-indigo gradient, glows and glass, a centred hero, identical rounded cards ([prg.sh](https://prg.sh/ramblings/Why-Your-AI-Keeps-Building-the-Same-Purple-Gradient-Website), [925studios](https://www.925studios.co/blog/ai-slop-design-tells), [capitalandcompute](https://capitalandcompute.net/blog/fix-ai-slop-design/)). Anthropic's [frontend-design skill](https://github.com/anthropics/skills) lists the same traits plus template chrome: ALL-CAPS eyebrow labels, one accented headline word, numbered markers on non-sequences, a near-black background with one bright accent, and scattered ambient motion | `decoration`, `motion`, `template_chrome`, and the vision criterion `look` |
| Copy | AI copy sells instead of describing ("unlock", "seamless", slogans), and adjective claims come without proof ([Landing Doctor](https://landingdoctors.com/guides/chatgpt-prompts-for-landing-page-copy)). The frontend-design skill says: "describe what something is or does in plain terms rather than selling it" | `plain_copy` |
| First screen | Users spend most of their time above the fold and only scroll if it promises enough. It has to state the value proposition (NN/g findings, via [CXL](https://cxl.com/blog/above-the-fold/)). One primary action, with proof next to it ([SaaS Hero](https://saashero.net/content/effective-saas-landing-page-structure/)) | `clarity` (×3) and `focus` |
| Readability | WCAG 2.2 AA: 4.5:1 for body text, 3:1 for large text | `contrast` |
| Invented numbers | AI one-shots fill stats and dashboards with plausible figures | `facts_true`: every figure on the page must come from facts.json |

## The rubric

```
honest_proof < 0.5 ? 0 : quality × (1 + checks passed) / 7
quality = (clarity × 3 + look × 2 + focus) / 6        (Clef reads the first-screen screenshot and the page text)
checks  = facts_true, decoration, motion, template_chrome, contrast (measured: count only at 100%), plain_copy (Clef)
```

- Invented proof scores 0.
- Past the gate, the page earns 1/7 of its quality score, plus 1/7 for each check it passes.
- A half-done fix earns nothing, so each check is worth one visible step.
- Grades: ship it ≥ 85, almost ≥ 60, rework.

**Calibration:**
- **Start page:** 0, twice. Every check fails.
- **Dry run** (headless, same prompt; reply in [`cal/dry-run-reply.md`](cal/dry-run-reply.md)): 0 → 10 → 21 → 37 → 35 → 49 →
  65 → 65 → 78 → 79. It hit the 10-evaluation limit at 79 because of two scorer problems, both fixed:
  1. **Contrast:** buttons were measured against their parent's background, not their own. Seven teal buttons with
     dark text counted as 1.0:1. Fixed in the scorer; the dry run's final page re-scores **93**
     ([`cal/dry-final.html`](cal/dry-final.html)).
  2. **Silent rationales:** contrast didn't say which text failed. The rationales of `contrast`, `decoration`, `motion`
     and `template_chrome` now name up to 8 offending elements (tag, class, start of the text, and colours for
     contrast).
- **facts.json:** the numbers check only reads numbers, so "2 to 20 engineers" now has a numeric twin.
- The Primer rubric uses the same scorer, so its contrast numbers would shift slightly too. That take is already recorded.

## Take 1 (2026-11-07)

Interactive Claude Code, unattended:
- **Tools:** Read, Edit and Write, plus the Verdict MCP server. No shell.
- **Prompt:** [`take-1/prompt.txt`](take-1/prompt.txt): fix one failing criterion per round, gate first; stop when it
  passes or after 10 evaluations.
- **Time:** 7 min 50 s from submit to done, with 110 edits.

| Eval | Score | Grade | Fixed before this evaluation (the agent's own log) |
| --- | --- | --- | --- |
| 1 | **0** | rework | (start) gate failed: made-up testimonials, star ratings, a logo marquee, "Used by 2,400+" |
| 2 | **10** | rework | Gate: removed the logo strip and the testimonials |
| 3 | **20** | rework | `motion`: removed every infinite animation (orbs, shimmer, pings, map arcs, waves) and timer loops |
| 4 | **23** | rework | `decoration`, part 1: flat colours instead of gradients, glass and glows (29 effects → 3, still failing) |
| 5 | **33** | rework | `decoration`: the last 3 ring shadows became plain borders |
| 6 | **34** | rework | `template_chrome`, part 1: eyebrows, gradient headline words, icon tiles, 01/02/03 markers (21 → 3) |
| 7 | **49** | rework | `template_chrome`: the logo's tile box, and Inter out of the font stack |
| 8 | **58** | rework | `facts_true`: 6 regions, Free $0 / Team $19, 14-day trial; removed the stats strip, Scale plan, uptime % and latencies |
| 9 | **71** | almost | `contrast`: lighter muted grey and darker status colours; 156/156 text elements pass |
| 10 | **93** | ship it | `plain_copy`: headings and buttons became descriptions. The H1 is now "Uptime and cron-job monitoring for small engineering teams" |

Quality went from 0.76 / 0.48 / 0.90 (clarity / look / focus) to 0.97 / 0.85 / 0.95.

**Checked:**
- [`build_states.py`](../ds-loop/recording/build_states.py) replays the agent's 110 edits from the transcript. It now
  skips refused edits. The last state matches the agent's file except for one blank line (line 212).
- Every score in the table is the agent's own `evaluate` result.

**What the rubric doesn't catch** (the agent flagged these itself):
- Claims without numbers that aren't in facts.json: monitors as code (CLI, Terraform), a REST API, CSV import.
- The dashboard mock says "All systems operational" while its toast reports a missed ping.
- The final page is still dark navy with a teal accent, which is one of the defaults the frontend-design skill lists.
  `look` gave it 0.85.

## The cut

[`recording/plain2pane-page.mjs`](recording/plain2pane-page.mjs) `<take-dir> <states-dir> out.mp4 --warp take-1/warp.json [--layout vertical]`:
- **Terminal:** the recorded bytes, with the model and plan label blanked.
- **Page:** the real page, reloaded at each edit. Beside it is a strip of the whole page (a full-page screenshot of
  each state), so changes below the fold show too.
- **Score:** the agent's own evaluate results: the score counts up, the history grows, and the seven checks are pills
  that turn green, the one that just flipped outlined.
- **Speed:** each new score plays at 1.2–2×, and the waiting in between at 20–80×. The current speed is printed. A
  1.6 s cold open shows the finished state first. Nothing is cut.

```bash
python3 ../ds-loop/recording/build_states.py take-1/recording start/index.html index.html take-1/states
XTERM_MODULES=<dir with @xterm/xterm> node recording/plain2pane-page.mjs take-1/recording take-1/states out.mp4 --warp take-1/warp.json --layout vertical
```

The caption is in [`../post-loop/b-landing/`](../post-loop/b-landing).

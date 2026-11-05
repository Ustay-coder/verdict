# "15 → 98": an agent rewrites our landing page until Verdict passes it

**Logline.** We wrote down what a good dev-tool landing page is, as a YAML rubric. Then we let Claude Code rewrite
our own landing page until Verdict scored it 90+. It went 15 → 45 → 64 → 98, and every number on screen is real.

| | |
| --- | --- |
| Channel | X (developers, founders, AI-eng) |
| Format | 16:9 1920×1080, safe for a 1:1 center crop. Captions burned in; works muted (X autoplays silent) |
| Length | 45 s (hard cap 60 s) |
| Tone | Terminal-native, dry, no hype. The page's sin is buzzwords, so the video can't have any |
| Assets | [`examples/rubrics/landing-page.yaml`](../../rubrics/landing-page.yaml), drafts [`v1.md`](v1.md)…[`v4.md`](v4.md), [`scoreboard.mjs`](scoreboard.mjs) |

## The numbers (live run, 2026-11-05, Jev 1.14.0 + Clef-flash)

Reproduce with `node examples/demo/landing-loop/scoreboard.mjs`. The scores repeat across runs; v2 sits at
44.7–44.9 because Clef has slight jitter, so show it as 45.

| Criterion (weight) | v1 | v2 | v3 | v4 |
| --- | --- | --- | --- | --- |
| **Total / grade** | **15** rewrite | **45** rewrite | **64** rewrite | **98** ship it |
| Five-second test (3) | 32% (`category` 74%) | 87% | **71%** ↓ | 100% (`sharp` 98%) |
| Shows, doesn't tell (2) | 4% | 7% | 51% | 97% |
| Time to first result (2) | 3% | 27% | 56% | 96% |
| No buzzword bingo, Jev+Clef panel (1.5) | 15% | 58% | 84% | 91–93% |
| One obvious next step (1.5) | no 86% | no 67% | no 58%, **conf 0.16** | **yes 96%** |
| Has an install command (1) | ✗ | ✗ | ✓ | ✓ |
| No banned buzzwords (1) | ✗ (12 hits) | ✓ | ✓ | ✓ |

What each rewrite did, which is also the story of the video:
- **v1 → v2:** deleted 12 buzzwords and said what it actually is. That's +30.
- **v2 → v3:** added a real rubric snippet and a `curl`. Proof went 7% → 51%. The headline got *worse*
  (87% → 71%), and we keep that in the video because it's honest and people will screenshot it.
- **v3 → v4:** four competing buttons became one command, and real measured numbers went in. +34, and it ships.

## Shot list

| # | Time | Screen | On-screen text (burned-in caption) | Notes |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:02 | v1 rendered as a web page. A red **15/100** stamp slams in | **Our landing page scored 15/100.** | The hook. No logo intro. The stamp lands on frame 1 |
| 2 | 0:02–0:05 | Fast scroll of v1 with the 12 buzzwords highlighted yellow one by one (*revolutionary, seamless, unlock…*) | **12 buzzwords. 0 lines of code.** | Highlight timing on a beat, ~0.2 s each |
| 3 | 0:05–0:09 | `landing-page.yaml` in an editor. Zoom on the `value_prop` levels `fog → category → what → what_who → sharp` | **So we wrote down what "good" means. In YAML.** | Let the level names be readable for 1 s. They're the joke |
| 4 | 0:09–0:12 | Claude Code terminal. The prompt (below) types in at 4× speed | **Then we told an agent: rewrite it until it scores 90.** | Real recording. Hide env/keys |
| 5 | 0:12–0:15 | First `evaluate` result, zoomed on `fog=2% category=74% what=16%` | **It doesn't just say "bad". It says *how sure* it is.** | Probability bars animate in from the JSON (see "Graphics") |
| 6 | 0:15–0:20 | Side-by-side diff v1→v2, buzzwords struck through red. Counter rolls **15 → 45** | **Delete the hype: +30** | Counter roll ≈ 0.6 s, ease-out |
| 7 | 0:20–0:26 | Diff v2→v3, code blocks slide in. Counter **45 → 64**. Then a red tick: *Five-second test 87% → 71%* | **Add real code: +19.** then **…and the headline got worse.** | Pause 0.5 s on the red number. It's the human moment |
| 8 | 0:26–0:30 | Zoom on v3's CTA row: `no=58% yes=42%  [conf 0.16]` | **4 buttons. The judge can't decide which one is "the" CTA. Neither can a visitor.** | Shortest caption that works. Trim if it runs long |
| 9 | 0:30–0:36 | Diff v3→v4: four buttons collapse into one command line. Counter **64 → 98**, stamp turns green **SHIP IT** | **One command. Real numbers. 98.** | The payoff. Hold the green stamp 1 s |
| 10 | 0:36–0:41 | `scoreboard.mjs` output, the four bars printing in sequence | **4 drafts. ~1 s each. Same rubric, every time.** | The real terminal output, full width |
| 11 | 0:41–0:45 | End card on black: `verdict` wordmark and a one-line YAML snippet | **Your taste, as YAML. Your agent, as the editor.** · *Rubric + drafts in the replies ↓* | No URL on the card; the link goes in reply 1 |

### Agent prompt (shot 4, typed verbatim)

```text
Rewrite landing.md until Verdict scores it 90 or higher.
Use the verdict MCP: create_rubric from examples/rubrics/landing-page.yaml, then evaluate landing.md
(type file) after every rewrite. Fix the weakest criterion first. Don't invent numbers. Only cite
measurements that are in this repo. Stop at 90+ and print the score history.
```

## Recording guide

**Setup (local machine, not a cloud session):**

```bash
pnpm i && pnpm build
cp examples/demo/landing-loop/v1.md landing.md
```

`.mcp.json` at the repo root (keys come from your shell; never paste them on screen):

```json
{ "mcpServers": { "verdict": { "command": "node", "args": ["packages/cli/dist/bin.js", "mcp"],
  "env": { "TYPESAFE_API_KEY": "${TYPESAFE_API_KEY}", "CLOUDFLARE_ACCOUNT_ID": "${CLOUDFLARE_ACCOUNT_ID}", "CLOUDFLARE_API_TOKEN": "${CLOUDFLARE_API_TOKEN}" } } } }
```

Rehearse with `node examples/demo/landing-loop/scoreboard.mjs --mock` (no API calls; the decision scores are fake).

**Two ways to shoot it. Pick one and caption it truthfully:**
- **A, preferred: a real agent run.** Start from `v1.md` and record the whole loop. The agent's drafts and
  scores will differ from the table above. Use *its* numbers for shots 6–10, and redo the captions to match
  what it actually fixed.
- **B: the drafts in this folder.** `v2.md`–`v4.md` were written against the rubric in a scripted session, not
  recorded as an agent loop. Every score above is a real Verdict run, but if you use these drafts, don't show
  shot 4 as if it produced them. Re-caption shot 4 as **"We rewrote it against the rubric"**. Developers will
  ask for the transcript.

**Terminal look:** dark theme, 20–22 pt mono, 100 columns, prompt trimmed to `$`. Record at 2× resolution and
crop, rather than zooming in post. Cut the `UNDICI-EHPA` warning line if it appears.

**Graphics (shots 5, 6, 9):** don't hand-type the bars or the counters. Drive them from the evaluation JSON
(`node packages/cli/dist/bin.js eval -r examples/rubrics/landing-page.yaml -i <draft> --json`):
`aggregate.score` for the counter, and `criteria[].ratings[].probabilities` for the bars. That keeps the edit
consistent with the numbers people can reproduce.

## Post copy

**Main post (with video):**
> Our landing page scored 15/100.
>
> So we wrote "good landing page" down as a rubric (YAML), and let an agent rewrite the page until it passed.
>
> 15 → 45 → 64 → 98. One edit made it worse. Every number is a real run.

**Reply 1:** Link to the rubric and drafts, plus the command to reproduce:
`node examples/demo/landing-loop/scoreboard.mjs`

**Reply 2:** How it scores: "No chat model writes a review. Each criterion is a typed question to a decision model (Jev,
Clef) that returns a probability per level. That's why it can say `fog 2% / category 74%` instead of a
paragraph. The buzzword and install checks are plain regex."

**Reply 3 (engagement, optional):** "Reply with your dev-tool landing page URL and we'll run the same rubric on
the first 20." Score them with `-i https://…` and reply with a screenshot of the scoreboard line. Only score
pages people post themselves.

**Prepared answers:**
- *"It just overfit your rubric."* → "Yes. That's the point. The rubric is the spec; the agent passed the spec.
  Disagree with the spec? It's 100 lines of YAML. Fork it and change it." Then link `landing-page.yaml`.
- *"Why not ask GPT/Claude to grade it?"* → "You'd get a paragraph and a number you have to parse. This gives a
  distribution per criterion, a confidence, and the same score on the same input."
- *"What's 0.4 s?"* → "One Clef-flash call. This rubric makes 4 decision calls per draft (pre-screen, Jev batch,
  Jev+Clef panel), so ~1 s per draft end to end."

## Pre-flight checklist

- [ ] **The repo is private.** v4's "try it in one command" (`git clone https://github.com/Ustay-coder/verdict …`)
      and Reply 1's link only work for viewers once the repo is public. Otherwise change the CTA in v4 and in
      Reply 1 (rescore v4 after any edit).
- [ ] Rerun `scoreboard.mjs` on shoot day and update the table if the model versions changed (`jev-latest` floats).
- [ ] Nothing on screen shows an API key, a tenant id or a private URL.
- [ ] Captions match the take you're using (path A or B).

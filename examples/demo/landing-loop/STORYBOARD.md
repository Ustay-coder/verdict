# "15 → 94": an agent rewrites our landing page, one criterion at a time

**Logline.** We wrote down what a good dev-tool landing page is as a YAML rubric, then gave Claude Code our worst
landing page and one rule: fix only the weakest criterion, re-score, repeat. Six rewrites took it from 15 to 94.
Every frame and every number comes from one real, uncut agent run (**Take A**, recorded 2026-11-05).

| | |
| --- | --- |
| Channel | X (developers, founders, AI-eng) |
| Format | 16:9 1920×1080, safe for a 1:1 center crop. Captions burned in, so it works muted (X autoplays silent) |
| Length | ~50 s (hard cap 60 s) |
| Tone | Terminal-native, dry, no hype. The page's sin is buzzwords, so the video can't have any |
| Assets | Rubric [`landing-page.yaml`](../../rubrics/landing-page.yaml) · start page [`v1.md`](v1.md) · Take A: [`take-a/`](take-a) · tools: [`recording/`](recording) |

## Take A: what actually happened

The agent ran unattended in interactive Claude Code. It had only `Read`/`Edit`/`Write` and the Verdict MCP server,
with no shell and no web access. Its working folder held `landing.md` (a copy of `v1.md`), the rubric, `README.md`
and `PROVIDERS.md`. The prompt, typed in on camera, is [`take-a/prompt.txt`](take-a/prompt.txt). The run took
2 min 19 s of wall time and ended the first time the score reached 90+.

| Step | Fixed | Score | Five-sec | Proof | Time-to-value | Specificity | CTA | Install | No-hype |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | (baseline) | **15** rewrite | 35% | 4% | 4% | 15% | ✗ | ✗ | ✗ |
| 1 | `cta`: four buttons → one GitHub link | **29** | 31% | 4% | 18% | 17% | ✓ | ✗ | ✗ |
| 2 | `install_cmd`: added `git clone … && pnpm install && pnpm build` | **46** | 30% | 26% | 52% | 19% | ✓ | ✓ | ✗ |
| 3 | `hype_free`: removed all 12 banned buzzwords | **58** | 31% | 26% | 54% | 46% | ✓ | ✓ | ✓ |
| 4 | `proof`: fake testimonial → rubric snippet + real Clef-flash response | **78** almost | 58% | 98% | 53% | 69% | ✓ | ✓ | ✓ |
| 5 | `time_to_value`: one command from clone to first (offline) score | **88** ship it | 66% | 98% | 98% | 78% | ✓ | ✓ | ✓ |
| 6 | `value_prop`: new headline and opening | **94** ship it | 98% | 97% | 96% | **66%** ↓ | ✓ | ✓ | ✓ |

Each row is the agent's own `evaluate` call ([`take-a/evaluations.json`](take-a/evaluations.json)). The drafts in
[`take-a/drafts/`](take-a/drafts) are rebuilt by replaying the agent's edits from its session transcript onto
`v1.md`, and `step6.md` matches the file it left on disk byte for byte. Re-scoring the drafts with the CLI lands
within ±2 of the agent's numbers (two reruns: 15–16 / 29 / 48 / 59 / 79–80 / 89 / 94–95), which is the jitter Clef
shows on repeat runs:

```bash
node examples/demo/landing-loop/scoreboard.mjs examples/demo/landing-loop/take-a/drafts/step*.md
```

Things in the run worth keeping on screen (people will screenshot them):
- **Step 6 got worse on one axis.** The new headline raised the five-second test 66% → 98%, but specificity fell 78% → 66%.
- **The agent flagged two problems itself in its final message.** (1) It never touched the "Why Verdict?" list beyond
  deleting buzzwords, so the page still says *"Our proprietary AI understands your content like never before"*.
  That's vague, and wrong too: Verdict calls third-party decision models. (2) It never ran the quick-start command.
- **The rubric let a false claim reach 94.** That's honest content and a ready follow-up post (see "Prepared answers").

**Do not ship `step6.md` as the real landing page.** It's the agent's output for this video, "proprietary AI" line included.

## Shot list

Timecodes in brackets refer to the raw Take A render (`render.mjs`, `--fast 6`, 40.5 s, see "Recording"). The editor
cuts and retimes it; captions and overlay numbers come from `take-a/evaluations.json`, never typed by hand.

| # | Time | Screen | On-screen text (burned-in caption) | Notes |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:02 | `v1.md` rendered as a web page. A red **15/100** stamp slams in | **Our landing page scored 15/100.** | The hook. No logo intro. The stamp lands on frame 1 |
| 2 | 0:02–0:05 | Fast scroll of v1 with the 12 buzzwords highlighted yellow one by one | **12 buzzwords. 0 lines of code.** | Highlight timing on a beat, ~0.2 s each |
| 3 | 0:05–0:08 | `landing-page.yaml`, zoom on the `value_prop` levels `fog → category → what → what_who → sharp` | **So we wrote down what "good" means. In YAML.** | Let the level names be readable for 1 s. They're the joke |
| 4 | 0:08–0:12 | Take A [0:03.7–0:12] prompt typing in, sped up 3× | **Then we gave an agent one rule: fix only the weakest thing. Re-score. Repeat.** | Real keystrokes. Keep the "Each rewrite may fix only…" sentence readable |
| 5 | 0:12–0:15 | Take A [0:18.4] *"Baseline: 15. Three criteria sit at 0…"* plus overlay of the step-0 probability bars (`value_prop`: category 67%) | **It doesn't just say "bad". It says how sure it is.** | Bars come from `evaluations.json` step 0 |
| 6 | 0:15–0:19 | Take A [0:18.6–0:20.1] the diff deleting `[Join the waitlist] [Book a demo] [Contact sales] [Learn more]`. Counter **15 → 29** | **4 buttons → 1 link: +14** | Counter roll ≈ 0.6 s, ease-out |
| 7 | 0:19–0:22 | Take A [0:20.4–0:22.4] install-command diff. Counter **29 → 46** | **Add a way to try it: +17** | |
| 8 | 0:22–0:25 | Take A [0:22.8–0:24.6] buzzwords struck out in red. Counter **46 → 58** | **Delete the hype: +12** | |
| 9 | 0:25–0:30 | Take A [~0:27–0:30.8] proof diff: real JSON response slides in. Counter **58 → 78** | **Show real output: +20** | The biggest jump. Hold it |
| 10 | 0:30–0:34 | Take A [0:30.8–0:33.5] *"Score 88, which passes but is below the 90 target."* | **88. Passes. Not good enough.** | |
| 11 | 0:34–0:39 | Take A [0:35.8–0:38.4] headline rewrite. Counter **88 → 94**, stamp turns green **SHIP IT**, then a small red tick *specificity 78% → 66%* | **New headline: 94. (One score went down.)** | The payoff, then the honest beat |
| 12 | 0:39–0:45 | Scoreboard card: seven bars 15 / 29 / 46 / 58 / 78 / 88 / 94 with the fixed criterion beside each | **6 rewrites. 1 criterion each. ~2 minutes.** | Graphic built from `evaluations.json` |
| 13 | 0:45–0:50 | End card on black: `verdict` wordmark and a one-line YAML snippet | **Your taste, as YAML. Your agent, as the editor.** · *Rubric, drafts and transcript in the replies ↓* | No URL on the card; the link goes in reply 1 |

**Alternate 15-second cut:** an earlier take used the same prompt but without the one-criterion rule. The agent
rewrote the whole page in one go, **15 → 97 in 94 s**. That works as a short "one prompt, one rewrite" reply
clip. Its recording was kept outside the repo along with Take A's video.

## Final edit (rendered, 50 s)

The shipped cut follows the shot list above, but shots 4–11 became one **split screen**. On the left is the
recorded terminal. On the right is a **live preview of `landing.md`, rendered from the file exactly as it was at
that moment**, with a score card above it. When the agent's `Edit` lands, the terminal shows the diff and the
preview strikes the removed blocks in red, then fades the added ones in green. When its `evaluate` returns, the
score counts up and the criterion bars move. The amber "▸ next" bar marks the criterion the agent fixed next.

| Video | Scene | Source |
| --- | --- | --- |
| 0:00–0:05 | v1 page, **15/100** stamp, the 12 buzzwords highlighted | `v1.md` + the rubric's own buzzword regex |
| 0:05–0:08 | `value_prop` levels `fog → … → sharp` | `landing-page.yaml` |
| 0:08–0:40 | Split screen: prompt typed in, baseline 15, fixes 1–6, 94 | cast bytes, 8 file states, 7 evaluations |
| 0:40–0:46 | Score history bars 15 → 94 | evaluations |
| 0:46–0:50 | End card + disclosure line ("real, unattended run · waiting time sped up") | |

Timing is honest by construction. Each page state and score sits at its real moment, from the transcript aligned
to the recording (within 0.1 s). Moments around edits and scores play at ~1.35×, and waiting is compressed up to
12×. A "▶▶ N×" chip shows on screen whenever playback runs faster than 1.5×. It's a silent track: add music in
the editor if you want it.

Rebuild it from a take folder holding `landing.cast`, `landing.cast.markers` and the session `session.jsonl`:

```bash
cd examples/demo/landing-loop/recording && npm i @xterm/xterm@5.5.0 marked@12.0.2
python3 build_edit_data.py <take-dir> ../v1.md ../../../rubrics/landing-page.yaml data.json
node edit.mjs data.json final.mp4            # --still <sec> frame.png to check one frame
```

The cast, transcript and MP4 are not in the repo: the TUI header in them shows the model name.

## Recording

What Take A used, in order to reshoot or record a new take:

```bash
pnpm i && pnpm build
mkdir -p ~/verdict-landing && cp examples/demo/landing-loop/v1.md ~/verdict-landing/landing.md
cp examples/rubrics/landing-page.yaml README.md docs/PROVIDERS.md ~/verdict-landing/
```

`~/verdict-landing/.mcp.json` (keys are expanded from your shell and never appear on screen):

```json
{ "mcpServers": { "verdict": { "command": "node", "args": ["<repo>/packages/cli/dist/bin.js", "mcp"],
  "env": { "TYPESAFE_API_KEY": "${TYPESAFE_API_KEY}", "CLOUDFLARE_ACCOUNT_ID": "${CLOUDFLARE_ACCOUNT_ID}", "CLOUDFLARE_API_TOKEN": "${CLOUDFLARE_API_TOKEN}" } } } }
```

Then record the real TUI and render it. [`recording/record.py`](recording/record.py) runs interactive Claude Code in
a 100×30 pty, types the prompt after the MCP server connects, and writes an asciicast v2 file.
[`recording/render.mjs`](recording/render.mjs) replays those bytes through xterm.js into a 1080p MP4: busy
stretches play at 1×, spinner-only stretches at 6×, and no gap is longer than 1 s. Nothing is added or reordered.

```bash
python3 examples/demo/landing-loop/recording/record.py ~/verdict-landing take.cast examples/demo/landing-loop/take-a/prompt.txt 100 30
node examples/demo/landing-loop/recording/render.mjs take.cast take.mp4 --fast 6 --to <done-marker-seconds + 2>
```

Notes from recording Take A:
- Run `record.py` with a separate `CLAUDE_CONFIG_DIR` whose `.claude.json` has onboarding done and the folder
  trusted. Otherwise the first-run theme picker and the trust dialog end up in the recording.
- The TUI only draws what fits in its 30 rows, so an agent's final message longer than that never appears in full.
  The score table is an overlay (shot 12) for that reason.
- The TUI header shows the Claude Code version and the model name. Decide before posting whether that stays in frame.

## Post copy

**Main post (with video):**
> Our landing page scored 15/100.
>
> We wrote "good landing page" down as a YAML rubric and gave an agent one rule: fix only the weakest thing, re-score, repeat.
>
> 15 → 29 → 46 → 58 → 78 → 88 → 94. One real, unattended run.

**Reply 1:** The link to the rubric, the seven drafts and the scores, plus the command to reproduce:
`node examples/demo/landing-loop/scoreboard.mjs examples/demo/landing-loop/take-a/drafts/step*.md`

**Reply 2:** How it scores: "No chat model writes a review. Each criterion is a typed question to a decision model (Jev,
Clef) that returns a probability per level. That's why it can say `category 67% / sharp 0%` instead of a paragraph.
The buzzword and install checks are plain regex."

**Reply 3 (engagement, optional):** "Reply with your dev-tool landing page URL and we'll run the same rubric on the
first 20." Only score pages people post themselves.

**Prepared answers:**
- *"It just overfit your rubric."* → "Yes, and it found a hole: the final page still says 'proprietary AI', which is
  false, and scored 94 anyway. The rubric is the spec. A spec with a hole gets gamed, so we're adding a
  claims-match-the-docs criterion." That's an honest follow-up post with its own before/after.
- *"Why not ask GPT/Claude to grade it?"* → "You'd get a paragraph and a number you have to parse. This gives a
  distribution per criterion, a confidence, and the same score on the same input (±2 here)."
- *"What's 0.4 s?"* → "One Clef-flash call. This rubric makes 4 decision calls per draft (pre-screen, Jev batch,
  Jev+Clef panel), so ~1 s per evaluation end to end."

## Scripted reference drafts (not Take A)

[`v2.md`](v2.md)–[`v4.md`](v4.md) (15 → 45 → 64 → 98 with v1) were written by hand against the rubric before Take A.
They're useful for rehearsing (`node examples/demo/landing-loop/scoreboard.mjs [--mock]`) but they are **not**
agent output. Don't put them in the video.

## Pre-flight checklist

- [ ] **The repo is private.** The page's quick-start (`git clone https://github.com/Ustay-coder/verdict …`) and
      Reply 1's link only work for viewers once the repo is public. Otherwise change the CTA in the post.
- [ ] Decide whether the TUI header (version and model name) stays in frame, or crop it.
- [ ] Overlay numbers match `take-a/evaluations.json`.
- [ ] Nothing on screen shows an API key, a tenant id or a private URL.
- [ ] Don't present `take-a/drafts/step6.md` as our real landing page.

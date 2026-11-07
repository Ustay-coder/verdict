# Videos C, E and F: Claude Code + `verdict watch`

Same format as the Primer video:
- **Left:** a real, unattended Claude Code run.
- **Right:** the live `verdict watch` page over the run's evaluation store.
- **Added:** only the speed label above the terminal, and a cold open that shows the finished state first.

| Video | Folder | Hook | What happens | Cut |
| --- | --- | --- | --- | --- |
| **C** | [`../ranking-loop/`](../ranking-loop) | *Same five entries, judged once. The winner changes three times.* | `compare` judges five fictional hackathon entries. `reaggregate` re-ranks the same evaluations twice, with no judge calls. Weighted mean: **Receipt Run 66**. Weakest link (min): **Common Room 48.5**, and Receipt Run drops to last with 0. Impact + originality: **Tidewatch 89.3**. The rows move on screen. | 18 s |
| **E** | [`../sponsor-loop/`](../sponsor-loop) | *Quality 100%, fit 86%. Total: 0.* | A fictional sponsored script fails the brand-safety gate (**0, reject**). The agent deletes the one sentence the rationale names (struck through on the right), and the script scores **94, approve**. | 16 s |
| **F** | [`../post-loop/`](../post-loop) | *This post was scored before we posted it.* | The agent writes three drafts of the launch post. It rewrites the lowest one each round, and they're compared again. Draft A goes 80 → 84 → 90 → **91**, last to first. The run stops after 4 rounds as the prompt says; B never reached 90. | 21 s |

**E v2** ([`../sponsor-loop/v2/`](../sponsor-loop/v2)) replaces the one-sentence fix: a script that breaks eight rules from FTC, ASA and FDIC guidance and the brand's brief climbs 0 → 17 → 25 → 34 → 43 → 52 → 61 → 74 → **85, approve**, one rule per review (31 s).

**F v2** ([`../post-loop/v2/`](../post-loop/v2)) replaces the three-draft comparison: our own launch post, in its first
AI-written form, climbs 0 → 10 → 20 → 30 → 40 → 51 → 61 → 70 → 80 → **88, post it**, one check per review (34 s).
The rules come from X's help pages and spam policy, HN guidelines, FTC case law and accessibility guides; three of the
eight checks are regex judges.

## How a take is recorded

[`take.sh`](take.sh) `<work-dir> <out> <prompt> <done-marker> <port>` does three things:
1. Starts `verdict watch` on the work folder's store. The MCP server writes there because `.mcp.json` sets
   `VERDICT_DATA_DIR`.
2. Starts [`snapshot.py`](snapshot.py), which keeps every version of every evaluation file. Re-aggregation overwrites in
   place, so the snapshots are needed to replay the moments when rows move.
3. Records the run with `landing-loop/recording/record.py`. The tools are Read/Edit/Write plus the verdict MCP, with no
   shell.

## How a cut is rendered

[`plain2pane-watch.mjs`](plain2pane-watch.mjs) builds the right pane:
- It serves the CLI's own watch page (`packages/cli/dist/watch.js`).
- It answers `/api/state` with `watchState()` over the store, as it was at each moment of the cast. Snapshots are
  aligned through the transcript's prompt time.
- The page's own row animations play in real time.

Each take folder has the prompt, the speed schedule (`warp.json`) and the recording (cast, transcript, store snapshots),
so the cut can be rebuilt:

```bash
XTERM_MODULES=<dir with @xterm/xterm> node plain2pane-watch.mjs ../ranking-loop/take-1/recording ../ranking-loop/take-1/recording/snapshots out.mp4 --warp ../ranking-loop/take-1/warp.json --title "claude — ~/hackathon" --url "127.0.0.1:4602 — verdict watch"
```

## Calibration before recording

- **C:** two judging runs gave the same three winners. Two entries were reworded once so that each aggregation has a
  different winner. The judges themselves were not changed.
- **E:** the original script scored 0 twice. With the sentence rewritten instead of deleted, it scored 92–93.
- **F:**
  - A hype draft scored 12, and plain drafts scored 86–95.
  - The overclaim and hype gates run on Clef. Jev was a coin flip on fact-grounding (0.43–0.57); Clef separates true
    drafts (0.8–0.92) from an overclaiming one (0.36).

## Takes that didn't make it

- **C, first take:** without a shell, the agent couldn't list `entries/` and stopped. The prompt now names the files.
- **F, first take:** the first draft already scored 90, so there was no loop to show. The prompt now iterates until
  every draft passes, with at most 4 rounds.

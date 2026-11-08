# Caption for video C v2 (hackathon write-up, 5th to 1st)

> **Superseded:** the posts for videos B–F were written again with a stricter rubric that passes at 90; see
> [`../captions/`](../captions).

Same loop as the other posts, with [`post-review.yaml`](../post-review.yaml) and this folder's [`brief.md`](brief.md):
- Three drafts: an announcement (A), a story (B) and a question (C).
- Each round rewrites only the lowest draft (a failed gate first), then all three are compared again.
- At most 4 rounds. Every round's drafts are in `rounds/N/`.

The video is in [`../../ranking-loop/v2/`](../../ranking-loop/v2).

| Round | A | B | C | Rewritten (weakest criterion) |
| --- | --- | --- | --- | --- |
| 1 | 83 | 80 | **90** | B (reply 45) |
| 2 | 84 | 82 | **90** | B (clear 60) |
| 3 | 84 | **92** | 90 | A (reply 58) |
| 4 | 89 **gate failed** | **91** | 90 | (stop: 4-round limit) |

**Pick: Draft B, 91** ([`drafts/b.md`](drafts/b.md)). It led rounds 3 and 4 with the same text (92, then 91).

**Round 4, draft A:** the rewrite shortened the score history to "0 → 22 → 43 → 67 → 91". That skips four rounds, so the
`true_to_brief` gate failed it (0), and rightly: a history with steps left out isn't the history.

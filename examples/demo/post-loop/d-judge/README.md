# Caption for video D (does the AI judge agree with people?)

Same loop as the other posts, with [`post-review.yaml`](../post-review.yaml) and this folder's [`brief.md`](brief.md):
- Three drafts: an announcement (A), a story (B) and a question (C).
- Each round rewrites only the lowest draft, then all three are compared again.
- At most 4 rounds. Every round's drafts are in `rounds/N/`.

The video is in [`../../judge-loop/`](../../judge-loop).

| Round | A | B | C | Rewritten next (weakest criterion) |
| --- | --- | --- | --- | --- |
| 1 | 79 | 81 | **82** | A (clear 60) |
| 2 | **89** | 80 | 82 | B (clear 34) |
| 3 | **89** | 88 | 82 | C (clear 56) |
| 4 | 87 | **91** | 89 | (stop: 4-round limit) |

**Pick: Draft B, 91** ([`drafts/b.md`](drafts/b.md)):

> Our AI commit reviewer agreed with human reviewers 57% of the time.
>
> So the agent changed one rule at a time and measured again. Judging what and why instead of style took it to 78%. After that, nothing moved it. On 96 commits it hadn't seen: 76%.
>
> What agreement would you need before trusting it?

"Judging what and why instead of style took it to 78%" folds two changes into one sentence (64%, then 78%); the
brief has both and the gate passed it.

# Caption for video F v2 (our launch post, 0 to "post it")

> **Superseded:** the posts for videos B–F were written again with a stricter rubric that passes at 90; see
> [`../captions/`](../captions).

Same loop as the other posts, with [`post-review.yaml`](../post-review.yaml) and this folder's [`brief.md`](brief.md):
- Three drafts: the false claim as the hook (A), "we scored our own post" (B) and the score climb (C).
- Each round rewrites only the lowest draft, then all three are compared again.
- At most 4 rounds. Every round's drafts are in `rounds/N/`.

The video is in [`../v2/`](../v2).

| Round | A | B | C | Rewritten next (weakest criterion) |
| --- | --- | --- | --- | --- |
| 1 | **84** | 82 | 82 | C (clear 34) |
| 2 | **85** | 84 | 75 | C (failed `no_hype`) |
| 3 | **85** | 83 | 84 | B (clear 40) |
| 4 | 85 | **87** | 85 | (stop: 4-round limit) |
| 4, fact fix | **87** | **87** | 86 | |

**Fact fix after round 4:** A and B said "then we posted it" and "and we posted it". The brief doesn't say that, and
`true_to_brief` let it through, so both lines were cut and the drafts compared once more. [`drafts/`](drafts) holds the
fixed versions; `rounds/4/` keeps the drafts as round 4 scored them.

**Pick: Draft B, 87** ([`drafts/b.md`](drafts/b.md)), tied with A on score; its hook is higher and it says what the
video is about in the first line:

> We scored our own launch post before posting it. It got 0.
>
> An agent fixed one rule per review, from X's help pages, HN's guidelines and FTC case law. Ten reviews later it scored 88.
>
> Which rule would your last post break?

- **Round 1, Draft C** put "cc @AnthropicAI @github" in the caption itself, which would tag both accounts. It was
  rewritten first.
- **Round 2, Draft C** failed the hype gate on "promised results we never had".
- `clear` stays the weakest criterion for every draft (34–57).

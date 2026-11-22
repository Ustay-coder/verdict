# Predictions (write before launch, don't edit after)

Rank the five topics on the primary metric (views watched to the end per impression), 1 = best. Add a one-line reason.

| Who | Written on | 1 | 2 | 3 | 4 | 5 | Why |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Founder | 2026-11-08 | B | C | D | E | F | (alphabetical: the founder expects B highest, down to F) |
| Claude | 2026-11-08 | B | D | F | E | C | B shows something every developer has seen (an AI page with fake testimonials). D asks a question people argue about (should an AI judge be trusted). F is about the post itself. E and C serve narrower groups (creators, hackathon entrants) |
| Caption rubric (post score) | 2026-11-08 | B 93 | D 92.5 | C 91.5 | E 90.5 | F 89.7 | Scores how well each post is written, not the topic |

After both rounds, add the real ranking here, and how far each prediction was from it (Spearman's rank correlation, five
points).

| Real ranking | | | | | | |
| --- | --- | --- | --- | --- | --- | --- |
| Pooled, both rounds (2026-11-22) | E 7.9% | B 4.6% | D 3.6% | F 2.4% | C 0.0% | **Not a result.** About 32 impressions and 1 completed view per post; every 95% interval overlaps the others. No winner by the decision rule |

Spearman's ρ against that order, for the record only:

| Prediction | ρ |
| --- | --- |
| Founder (B, C, D, E, F) | 0.0 |
| Claude (B, D, F, E, C) | 0.4 |
| Caption scores, both rounds (B, D, C, F, E) | −0.1 |

With these counts, none of the three can be called right or wrong.

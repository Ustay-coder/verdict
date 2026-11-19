# Predictions, written before the run

Committed before `verdict run` was called on these cases. The rubric is the frozen one
(`../landing-page.yaml`, `rv_69b523a910c1078e63a3`); it is not changed for this experiment.

The question: the round-6 page scored 80 and passed. If one defect a person would block is planted in it, does the
rubric still pass it?

`expected` in [cases.jsonl](cases.jsonl) is what a person checking the page would decide for each gate. "Caught" means
the planted gate came out `fail`, so the page scores 0.

| Case | Planted defect | Gate that should fail | Prediction | Why |
| --- | --- | --- | --- | --- |
| v0 | none | — | passes, 80 | It is the round-6 page. |
| v1 | invented testimonial on the first screen | no_fabrication | caught, not sure | The gate passed the real page at only 58%. |
| v2 | "Trusted by 1,200+ engineering teams" | no_fabrication | caught | facts.md says there are no user counts. |
| v3 | the real run's best result inflated, 73/80 (91%) → 79/80 (99%) | no_fabrication | **missed** | The number is plausible and buried in a table. |
| v4 | wrong package in every install command | cta_real | **missed** | The rule passes if the install command *or* the repository link is there; the link still is. |
| v5 | every repository link to a repository that does not exist | cta_real | **missed** | The install command is still there, and `…/verdict-cli` contains `…/verdict` anyway. |
| v6 | first-screen install command and button drawn in the background colour | cta_visible | not sure | The nav still shows "Docs" and "GitHub". The gate's own words ("a button to the code or docs") would accept those, so a pass is defensible by the rubric and wrong by a person. |
| v7 | page 960px wide on a phone | mobile_ok | caught | The phone screenshot is visibly cut off. |
| v8 | `[Insert demo GIF here]` on the first screen | no_placeholder | **missed** | The rule's pattern does not list that shape, and no model gate looks for it. |
| v9 | none a person would block: logo `href="#"` | — | **wrongly blocked** | The known false positive from round 0. |

Predicted: 3 caught (v1, v2, v7), 4 missed (v3, v4, v5, v8), v6 unsure, v9 wrongly blocked, v0 passes.

Run with Clef and Clef-flash: `verdict run -r ../landing-page.yaml -d cases.jsonl --models clef,clef-flash`.

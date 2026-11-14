# The trap of a high score

The round-6 page in [../rounds](../rounds) scored 80 and passed. This experiment plants one defect a person would
block (or none) in that page, ten times, and puts every copy to the same frozen rubric
([../landing-page.yaml](../landing-page.yaml), `rv_69b523a910c1078e63a3`) on Clef and Clef-flash.

```bash
node make-variants.mjs                       # the ten pages, their screenshots and cases.jsonl (needs Playwright)
verdict run -r ../landing-page.yaml -d cases.jsonl --models clef,clef-flash --lock ../verdict.lock
```

The defects are planted by [make-variants.mjs](make-variants.mjs), as exact text edits, not by a model. Each case's
`expected` is what a person checking the page would decide. The variants, the cases and
[PREDICTIONS.md](PREDICTIONS.md) were committed before the run. The whole output is in
[run-2026-11-14.txt](run-2026-11-14.txt); every answer and probability is in [results.json](results.json).

## The run (2026-11-14)

| Case | Planted defect | Predicted | Clef | Clef-flash |
| --- | --- | --- | --- | --- |
| v0 | none | passes | **90, pass** | 0: invented content |
| v1 | invented testimonial | caught | 0: invented content | 0: invented content |
| v2 | invented user count | caught | 0: invented content | 0: invented content |
| v3 | real result inflated, 73/80 → 79/80 | missed | 0: invented content | 0: invented content |
| v4 | wrong package in every install command | missed | 0: invented content (the rule passed it) | 0: invented content |
| v5 | every repository link to a repository that does not exist | missed | 0: invented content (the rule passed it) | 0: invented content |
| v6 | first-screen install command invisible | not sure | 0: no next step | 0: no next step, invented content |
| v7 | page overflows sideways on a phone | caught | 0: phone | 0: invented content (passed the phone) |
| v8 | `[Insert demo GIF here]` on the first screen | missed | **90, pass** | 0: invented content |
| v9 | none a person would block (logo `href="#"`) | wrongly blocked | 0: placeholder rule | 0: placeholder rule, invented content |

## What it shows

- **Clef caught seven of the eight defects and passed the eighth at 90**, higher than the real page ever scored.
  An empty `[Insert demo GIF here]` box on the first screen is not something any gate asks about. The placeholder
  rule lists `lorem ipsum`, `TODO` and the like, not that.
- **Two of the catches came from the wrong gate.** The wrong package name and the dead repository link passed the
  rule written for them: it passes if the install command *or* the repository link is there, and
  `github.com/Ustay-coder/verdict-cli` contains `github.com/Ustay-coder/verdict`. They were blocked because they
  contradicted `facts.md`, which the "nothing invented" gate reads.
- **I predicted three catches; Clef made seven.** Wrong on v3, v4, v5 and v6. Right on v8 (missed) and v9 (the
  known false positive).
- **Clef-flash blocked every page, including the clean one.** It failed "nothing invented" on all ten, at
  0.68 to 0.80 for fail. Its probability on the clean page (0.76) sits inside the range it gave the pages with a
  planted fake (0.68 to 0.79), so it did not tell them apart. A judge that blocks everything catches every defect and
  is no use. On v7 it passed the overflowing phone screenshot.
- **The same page scored 80 in round 6 and 90 here** (v0). One criterion, "shows real output", went from 2 to 3. Its
  most likely level was "real" both times (62% then 71%). The expected level moved past the midpoint and was rounded
  up. Only the file names and screenshots around the same HTML changed.
- **Clef-flash did not repeat itself.** Run twice on the same cases, its probabilities moved by up to 0.29, and one
  criterion changed level (v6, "shows real output", 2 to 1). No page's pass or fail changed. Clef's answers were
  identical both times.

A high score means the page passed the questions the rubric asks. It says nothing about the ones it does not ask.

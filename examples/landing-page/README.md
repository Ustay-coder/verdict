# Ship or not: an AI-made landing page, scored round by round

Claude Code was asked for a landing page for Verdict ([prompt.md](prompt.md), with only the README to go on). Each
round, the page was screenshotted (desktop 1280×800 and phone 390×844, first screen) and scored with
[landing-page.yaml](landing-page.yaml) on Clef. What Verdict reported was handed back ([feedback.md](feedback.md)),
in the same Claude session, until the page passed.

```bash
npm install -g @verdict-ai/cli
node run.mjs --rounds 9            # needs the claude CLI, Playwright, CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN
```

To score your own page with the same rubric, screenshot it and pass the pieces (put your product's facts in `facts.md`):

```bash
verdict eval -r landing-page.yaml -i desktop=desktop.png -i mobile=mobile.png \
  -i page=index.html -i source=index.html.txt -i facts=facts.md
```

## The rubric came first

The rubric, [facts.md](facts.md) (what is true about Verdict; anything beyond it counts as invented), the prompt and
the feedback template were committed and frozen (`verdict.lock`, `rv_69b523a910c1078e63a3`) before the first page was
generated. Six **gates** decide whether the page may ship at all; if any fails the score is 0. Four **criteria**
score it out of 100 once it may; 80 passes.

| Gate | Judged by |
| --- | --- |
| The first screen says what it is | Clef, desktop screenshot |
| A next step on the first screen | Clef, desktop screenshot |
| The next step leads somewhere real (install command or repository link) | rule |
| Nothing invented (testimonials, logos, counts, pricing, features) | Clef, page text against facts.md |
| No placeholders left (`lorem ipsum`, `href="#"`, `example.com`, `TODO`, …) | rule |
| Readable on a phone | Clef, phone screenshot |

## The run (2026-11-14)

| Round | Score | What happened |
| --- | --- | --- |
| 0 | 0 | Every gate but one passed. The page links its logo to `href="#"` in the nav and the footer, and the placeholder rule blocks that. |
| 1 | 0 | The feedback said only "No placeholders left (fail, rule)". Claude replaced eleven things that looked like placeholders (`run_…`, `…`), not the logo links. |
| 2 | 73 | Claude guessed `href="#"`. The gate passed; the four criteria gave 73. |
| 3–5 | 73 | **The script's fault.** It listed only criteria below 2 of 3; none were, so Claude was sent an empty list three times. It changed nothing and said why each time ([r03/claude.json](rounds/r03/claude.json)). |
| 6 | 80 | With every criterion short of full marks listed, Claude added a "Built for" line and three problem statements. Who it is for went from 2 to 3. Pass. |

Every round's page, screenshots, the message Claude was sent, its reply and the evaluation are in [rounds/](rounds).

## What to take from it

- **A gate is only as right as its rule.** `href="#"` on a logo is a common way to link back to the top, not a
  forgotten placeholder. The rule could not tell the two apart, and it set a page that passed everything else to 0.
- **A rule that fails should say what it matched.** "(rule) failed" cost a round: Claude changed eleven things to
  fix one. The regex judge reports how many times it matched, not where.
- **Feedback that lists nothing changes nothing.** Three rounds at 73 were a threshold in the script, not a ceiling
  in the page.
- **Close calls stay close.** "Nothing invented" passed in every round at 55% to 63% for pass. Those are the answers to read
  yourself before trusting the score.

# A hundred receipt photos, four decision models

Photos nobody here took or labelled, put to the four decision models that take pictures: Clef, Clef-flash, OpenAI's
and Gemini's. Three closed questions of three kinds: which of two ways the customer paid, how many items were
bought, and whether the total is 100,000 rupiah or more.

```bash
npm install -g @verdict-ai/cli
node fetch.mjs
verdict run -r receipts.yaml -d cases.jsonl --models clef,clef-flash,openai,gemini
```

`fetch.mjs` downloads the photos (about 15 MB) into `images/`; they are not kept in this repository. Each model
answers with your key for its service ([which keys](https://docs.verdict-ai.dev/reference/models)); leave out the
ones you have no key for. A model that takes no pictures can be named too: its row says `0/100` under "pictures
sent", and its answers are guesses.

## The run

A real run, 2026-11-12. The whole output is in [run-2026-11-12.txt](run-2026-11-12.txt).

```
Receipt facts × cases.jsonl: 100 case(s), 4 model(s), the same questions to each
  model        answered by                agreed with labels   failed   asked a human   pictures sent   input tokens   calls   time
  clef         cloudflare/clef            264/276 (96%)        0        0               100/100         141,828        100     17.7 s
  clef-flash   cloudflare/clef-flash      269/276 (97%)        0        0               100/100         141,828        100     19.1 s
  openai       openai/gpt-6-luna          266/276 (96%)        0        0               100/100         278,632        100     16.5 s
  gemini       gemini/gemini-decision-1   268/276 (97%)        0        0               100/100         159,820        100     125.5 s
the models gave one answer on 265 of 300 question(s) they all answered; they differ on 35:
```

Of the 276 answers the annotations settle: the payment on 81 receipts, the number of items on 100, the total on 95.

| | Payment (81) | Items (100) | Total (95) |
| --- | --- | --- | --- |
| Clef | 81 | 88 | 95 |
| Clef-flash | 81 | 93 | 95 |
| OpenAI | 80 | 91 | 95 |
| Gemini | 81 | 92 | 95 |

## The question about items was written three times

The first rubric, [receipts-first.yaml](receipts-first.yaml), said "Count lines, not quantities", and asked for a
level on a scale: one, two, three, four or more. Its run is [run-2026-11-12-first.txt](run-2026-11-12-first.txt).

| Items (100) | First | Wording corrected | Asked as a choice |
| --- | --- | --- | --- |
| Clef | 86 | 87 | 88 |
| Clef-flash | 87 | 85 | 93 |
| OpenAI | 84 | 87 | 91 |
| Gemini | 87 | 91 | 92 |

- **The models did what the first wording said.** Six receipts were "wrong" for all four models, and all six print
  an add-on on a line of its own: a milk tea, and under it the coconut jelly that went in it. The annotation counts
  one item, the receipt itself prints `TOTAL ITEMS 1`, and the models counted two lines, as told. Seventeen of the
  hundred receipts have such a line; on those the models agreed with the labels on 7 to 9.
- **[receipts-second.yaml](receipts-second.yaml) says an add-on belongs to its item.** On the seventeen, Gemini went
  from 8 to 16; the other three to 10 or 11. The sentence moved other answers too: on the other 83 receipts three
  of the four models lost 2 to 5.
- **A scale is answered with an average, and a count is not a scale.** For a level on a scale Verdict takes the
  probability-weighted mean of the levels. Clef gave one receipt 0.69 for "one", 0.11 for "two", 0.11 for "three"
  and 0.09 for "four or more"; the mean is 1.6, so the answer was "two". That is right for "poor to excellent" and
  wrong for counting. [receipts.yaml](receipts.yaml) asks the same question as a choice among four options, where
  the answer is the option the model gave most to.

Every correction was made after seeing the answers to these hundred receipts, so the last column is how well the
question now fits these receipts. It is not a measure on receipts the question has not seen.

## How to read it

- **Sent twice, the same answers.** The first rubric was run twice; for all four models every probability of all
  300 questions was the same in both runs.
- **A free tier meters pictures by the minute.** A receipt costs 1,400 to 2,800 input tokens, depending on the
  model. Gemini's free tier allows 50,000 a minute; a run from the command line waits when a service says to and
  asks again, which is why Gemini's row took two minutes.
- **"Agreed with labels" is agreement with these annotations.** The one receipt all four models still miss lists a
  second line, `PLASTIK 25`, at a price of 0. The annotation counts it as an item; the models do not.

## Where the photos come from

**CORD** (Consolidated Receipt Dataset) by NAVER CLOVA: photos of receipts from shops and restaurants in Indonesia,
with what is printed on each annotated field by field
([repository](https://github.com/clovaai/cord), Park et al., 2019,
[CORD: A Consolidated Receipt Dataset for Post-OCR Parsing](https://openreview.net/pdf?id=SJl3z659UH);
[the data](https://huggingface.co/datasets/naver-clova-ix/cord-v2)). The dataset is licensed under
[Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/), and so is
`cases.jsonl`, whose answers are read from its annotations.

What was changed: nothing in the photos. All 100 receipts of the test split are used, in order.
[build-cases.mjs](build-cases.mjs) rebuilds `cases.jsonl` from the annotations, and shows where each answer comes
from:

```bash
node fetch.mjs
node build-cases.mjs annotations.json > cases.jsonl
```

- **Payment**: `cash` where the annotation has a cash amount and no card amount, `card` the other way round. No
  answer where it has both or neither (19 receipts).
- **Items**: the number of entries in the annotation's `menu`. An add-on is part of its entry.
- **Total**: the annotated total, read as rupiah whatever separators it is printed with, against 100,000. No answer
  where no total is annotated (5 receipts).

The dataset is public, so the models may have seen it.

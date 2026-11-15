# Change tests

A change test answers one question about a rubric edit: **did the judgement of the same documents move the way you meant it to?** You name a baseline version and a candidate, pick a set of documents, write down beforehand what you expect of each one, and Verdict evaluates the documents under both versions and checks the result against what you wrote, with the reasons and the evidence beside it.

A change in points is neither good nor bad. A drop you intended is correct; a rise where the score should have held is a problem. So the screen never colours a drop red or a rise green: direction is shown with a sign and a pattern, and whether **your expectation held** is a separate mark. "Met" means the test's expectation held. It does not mean a document passed, or that the rubric is right.

Everything runs on the local engine. Documents, rubrics and results stay in `.verdict/` on your machine.

## See it first

```bash
verdict change-test demo     # two tests from invented documents and a scripted mock judge; no model is called
verdict watch                # http://127.0.0.1:4600/change-tests
```

The demo scores one criterion, *customer validation*, out of 10. Version 1 gives 10 points for three or more customers. Version 2 gives 10 only for three or more **paying** customers, 6 when there are three customers and fewer than three are known to pay, and asks instead of scoring when the document does not say who pays.

| Document | Baseline | Candidate | Change | Expected | Verification |
| --- | --- | --- | --- | --- | --- |
| A: three paying customers | 10 / 10 | 10 / 10 | 0 | holds | ✓ Met |
| B: three free pilots | 10 / 10 | 6 / 10 | −4 | drops ≥ 4, and is 6 | ✓ Met |
| C: three customers, payment not stated | 10 / 10 | needs information | — | asks for `customer_payment_status` | ✓ Met |

C has no new score and no change: not 0, and not −10. The second demo test has the script answer wrongly on purpose, so you can see a mismatch (B stays at 10), a question that was not asked (C scored 0), a failed judge call, a document without expectations, a quote that is not in the document, and a stored result that contradicts itself.

## What a change test shows, and what it does not

| Question | This release shows | Needs a separate test |
| --- | --- | --- |
| What should hold when something changes? | Whether documents the rubric change should not touch kept their result | Whether a result holds when the document is reworded, reformatted or reordered |
| What should change? | Whether documents the change is aimed at moved the intended way | How the rubric reacts when a fact in a document changes |
| When should it hold back or ask? | Whether existing documents that lack a fact are left open with a question | Whether the rubric asks only when the fact is really needed |

The right-hand column needs the document varied while the rubric stays fixed. That is designed (`docs/design/change-tests.md` §11) and not built.

## A score that cannot be decided

To let a judge say "the document does not tell me", give the criterion a choice for it and mark that choice `unresolved`:

```yaml
criteria:
  - id: customer_validation
    name: Customer validation
    scale: { type: numeric, min: 0, max: 10 }
    choices:
      paid_3_or_more: Three or more paying customers
      customers_3_paid_under_3: Three or more customers, and fewer than three are stated to pay
      total_under_3: Fewer than three customers
      undetermined: The document does not say which of these applies
    values: { paid_3_or_more: 10, customers_3_paid_under_3: 6, total_under_3: 0 }
    unresolved:
      undetermined:
        state: needs_info          # or: abstain, with a reason
        requests:
          - field: customer_payment_status
            question: How many of the customers have a paid contract, and how many are free pilots?
```

An unresolved choice has no value. When a judge picks it the criterion has **no score** (never a zero), the result says what is open and what to ask, and the total is marked provisional. The rubric's `aggregation.missing` policy still decides what the provisional total is computed from; a change test never compares it. A criterion handed to a person because the model's confidence was low (`onLowConfidence: human`) reads as *abstained*.

A decision model answers such a criterion as a `choice` question. Use an `llm` judge for it when you also want the judge's reason and quotes.

## Write a test

```bash
verdict version freeze rubrics/v1.yaml
verdict version freeze rubrics/v2.yaml
verdict change-test create --base rubrics/v1.yaml --head rubrics/v2.yaml -d documents.jsonl --expect expect.yaml --name "Tell paying customers apart"
```

`documents.jsonl` holds one document per line, `{ "id": "B", "name": "…", "inputs": [{ "type": "file", "path": "b.pdf" }] }`. Labels are not needed. `expect.yaml`:

```yaml
intent: Tell paying customers from free pilots; ask when the document does not say.
cases:
  A: [{ type: hold, criterion: customer_validation }]
  B:
    - { type: decrease, criterion: customer_validation, by: 4 }
    - { type: range, criterion: customer_validation, min: 6, max: 6 }
  C:
    - { type: asks_for, criterion: customer_validation, fields: [customer_payment_status] }
    - { type: state, criterion: customer_validation, state: needs_info }
```

| Expectation | Settings | Met when (Δ = candidate − baseline) |
| --- | --- | --- |
| `hold` | `tolerance` (default 0) | \|Δ\| ≤ tolerance |
| `increase` | `by` (default: any rise) | Δ > 0 and Δ ≥ by |
| `decrease` | `by` (default: any drop) | −Δ > 0 and −Δ ≥ by |
| `not_lower` | `tolerance` (default 0) | Δ ≥ −tolerance |
| `not_higher` | `tolerance` (default 0) | Δ ≤ tolerance |
| `range` | `min`, `max` | min ≤ candidate score ≤ max |
| `state` | `scored`, `needs_info` or `abstained` | the candidate's judgment state is that one |
| `asks_for` | `criterion`, `fields` | the candidate leaves the score open and asks for every field, with the rubric's question for it |

Leave `criterion` out to mean the total. Scores are compared as stored, before any rounding for display. A document can carry several expectations; each is judged on its own, and the document is met only when all of them are.

The same can be done in `verdict watch`: **New test**, then the expectation editor. `intent` is for people; no judge and no check reads it.

## Run it and read the result

```bash
verdict change-test run "Tell paying customers apart"                      # the candidate the test was written with
verdict change-test run "Tell paying customers apart" --head rubrics/v3.yaml --fail-on unmet
```

The judge is given the rubric and the document, and nothing else: not the expectations, not the other version's result. Verification happens afterwards, in code, on the stored evaluations.

The result keeps three things apart, and counts them separately:

- **Execution**: did the evaluation run? A failed call or a stored result that contradicts itself (for example "needs information" together with a final score) is an execution problem. It is never turned into a score.
- **Judgment**: what could be decided — scored, needs information, or abstained.
- **Verification**: did your expectation hold — met, not met, needs review, not comparable, or not verified (no expectation written).

A rate is always shown with its denominator: "2 of 4 verifiable cases met; 7 in all, left out: 2 not comparable, 1 without expectations".

A difference is taken only when it means something. There is none across an open score, a failed evaluation, a criterion that exists in one version only, or a scale that changed (10 points out of 10 and 12 out of 20 are shown side by side, not subtracted). Criteria are matched by id; a criterion whose id changed needs `mapping: { new_id: old_id }` in the test, and a same-named criterion under another id is reported as *needs review* rather than assumed to be the same.

The page says whether the two sides ran under the same conditions. If the judges' provider, model or options differ between the versions, a provider did not name the model that answered, or the extracted text of a document differs, it says so and does not call the result the rubric's doing.

Quotes a judge gives are tied to the document only when the text occurs in it; otherwise they are shown as "not found in the document". Decision models return probabilities and no quotes.

## Keep it for the next version

A test is kept. Changes in points are always measured from the test's **baseline**, whichever candidate is run: "drops by at least 4 from v1" means the same for v2 and for v3. The baseline's stored results are shown again instead of evaluated again (`--rerun-baseline` to evaluate them).

- Changing what you expect saves a **new revision**; earlier revisions and their verifications stay. `verdict change-test reverify <trial>` reads a stored trial against the newest revision without calling a judge.
- Moving the baseline (`verdict change-test expect <test> --file expect.yaml --base rubrics/v2.yaml`) is a revision of its own, and the expectations have to be given again in full.
- A retry or a re-run is a new trial. A finished trial is never changed, and results shown again from an earlier trial are marked as reused.
- A mismatch can be kept for follow-up from the page. That keeps a note with the test; it changes no rubric and no score.

One run shows one outcome. Running again can give another answer from the same model; Verdict does not estimate how much from a single run.

## The page

`verdict watch` writes only from this machine: the change-test pages can create tests and start trials when the server is bound to `127.0.0.1` (the default), and are read-only otherwise or with `--read-only`. A judge whose key is not set is shown as not connected before you run.

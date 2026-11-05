# Verdict

## Score documents, URLs and videos against your own rubric in one API call

Verdict is an open-source evaluation API for developers whose product has a grading step (hiring screens,
pitch reviews, content checks, model evals). You write the rubric in YAML, and Verdict sends the whole rubric to a
decision model (Jev, Clef) as **one request**. You get back a score, a grade, pass/fail and per-level probabilities
for every criterion, with no chat-model prose to parse and no spreadsheet to add it up in.

Use it from the REST API, the `verdict` CLI, the MCP server or the TypeScript SDK.

### Why Verdict?

- **Accuracy.** Our proprietary AI understands your content like never before.
- **Integration.** Works with the tools you already love.
- **Enterprise-grade.** Built for scale, security and peace of mind.
- **A new approach.** Evaluation, reimagined for the AI era.

### What it looks like

A rubric criterion is a typed question:

```yaml
criteria:
  - id: problem
    name: Problem clarity
    weight: 2
    anchors:
      "1": No clear problem
      "3": Stated but vague
      "5": "Specific, painful, quantified"
```

Verdict sends the whole rubric to a decision model in one request. Below is the actual response from a live
Clef-flash call (`packages/core/test/fixtures/cloudflare-clef-flash-response.json`). Each criterion comes back
with a probability per level, not prose you have to parse:

```json
{ "result": { "model": "clef-flash",
    "answers": { "urgency": { "type": "score", "score": 2.916, "probabilities": { "0": 0.0062, "1": 0.0055, "2": 0.0545, "3": 0.9338 }, "confidence": 0.8335 },
                 "needs_engineer": { "type": "noul", "noul": 0.843 },
                 "team": { "type": "choice", "choice": "engineering", "probabilities": { "support": 0.0179, "engineering": 0.9722, "billing": 0.0099 }, "confidence": 0.9183 } },
    "usage": { "input_tokens": 370, "output_tokens": 0 } }, "success": true }
```

Measured on that call: **0.40 s**, HTTP 200, 370 input tokens, 0 output tokens. Clef-flash costs
**$0.038 per million input tokens**, with no charge for output.

### Get started

Verdict is open source (MIT). Get the code on GitHub:

**[github.com/Ustay-coder/verdict →](https://github.com/Ustay-coder/verdict)**

One command takes you from clone to your first scored evaluation. No account and no API key are needed,
because this example rubric uses deterministic benchmarks only:

```bash
git clone https://github.com/Ustay-coder/verdict && cd verdict && pnpm install && pnpm build && \
  pnpm verdict eval -r examples/rubrics/offline-benchmark.yaml -i ci=examples/inputs/ci.json -i examples/inputs/CHANGELOG.md
```

When you're ready for decision models, set `TYPESAFE_API_KEY` (Jev) or `CLOUDFLARE_*` (Clef), or pass `--mock`.

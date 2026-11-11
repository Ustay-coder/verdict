# Sponsorship fit

Engineers building a sponsorship review queue use this rubric to compare a creator’s transcript with a brand brief and budget. The result supports a shortlist decision using text evidence; it does not assess video frames.

## Save the rubric

Save as `youtube-content.yaml`:

```yaml
name: Sponsorship fit
scale: { type: numeric, min: 0, max: 10, step: 0.5 }
judges:
  jev:  { type: decision, provider: typesafe, model: jev-latest }
  clef: { type: decision, provider: cloudflare, model: "@cf/cloudflare/clef-flash" }
defaultJudge: { type: ref, ref: jev }
criteria:
  - id: relevance
    name: Audience relevance to brand
    weight: 3
    inputs: [video, brief]
    anchors: { "0": Audience has nothing to do with the brand, "5": Partial overlap, "10": Audience is exactly the brand's buyer }
  - id: production
    name: Production quality (from transcript & description)
    weight: 1
    judge: { type: panel, combine: median, judges: [{ type: ref, ref: jev }, { type: ref, ref: clef }] }
  - id: safety
    name: Brand safe
    weight: 2
    scale: { type: binary, labels: [unsafe, safe] }
    anchors: { unsafe: "Profanity, political content, gambling or unsafe stunts", safe: Advertiser-friendly throughout }
    judge:
      type: panel
      combine: min
      judges:
        - { type: ref, ref: jev }
        - { type: benchmark, method: regex, pattern: "\\b(nsfw|gambling|crypto giveaway)\\b", flags: i, negate: true }
  - id: budget_fit
    name: Rate within budget
    weight: 1
    judge: { type: benchmark, method: formula, expression: "clamp(brief.budget_usd / creator.rate_usd, 0, 1)" }
aggregation:
  method: formula
  formula: "safety_n < 0.5 ? 0 : (relevance_n * 0.5 + production_n * 0.2 + budget_fit_n * 0.3)"
  normalize: [0, 100]
  passThreshold: 65
```

## Run an evaluation

Set `TYPESAFE_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_API_TOKEN`. Jev scores relevance and safety; Clef-flash supplies the second production rating. The formula reads JSON inputs tagged `brief` and `creator`; relevance reads tags `video` and `brief`.

```bash
export TYPESAFE_API_KEY="your-typesafe-key"
export CLOUDFLARE_ACCOUNT_ID="your-account-id"
export CLOUDFLARE_API_TOKEN="your-workers-ai-token"
printf '%s\n' 'A transcript about budgeting for freelance designers. No sponsorship disclosures or unsafe stunts.' > transcript.txt
printf '%s\n' '{"budget_usd":2000,"audience":"freelance designers"}' > brief.json
printf '%s\n' '{"rate_usd":1500}' > creator.json
npx @verdict-ai/cli eval -r youtube-content.yaml \
  -i video=transcript.txt -i brief=brief.json -i creator=creator.json
```

## What to change

Increase the relevance multiplier in `formula` and reduce another multiplier to keep their sum at 1. Raise `passThreshold` from 65 to 75. Replace the production panel with Jev alone to remove the Cloudflare credential requirement.

Validate your edited YAML with `npx @verdict-ai/cli rubric validate youtube-content.yaml`. See the [rubric reference](/reference/rubric) for field definitions.

# Providers

Choose an adapter below, set its environment variables in the process running Verdict, and copy its `defaultJudge` into your rubric. Remote clients configure credentials on the API server, not in the client. Never put secret values in YAML.

## TypeSafe Jev

The default provider has a live-verified contract. Set `TYPESAFE_API_KEY`:

```bash
export TYPESAFE_API_KEY="your-typesafe-key"
```

```yaml
defaultJudge: { type: decision, provider: typesafe, model: jev-latest }
```

## Cloudflare Clef-flash

For REST inference, set both account ID and a token with Workers AI Read permission:

```bash
export CLOUDFLARE_ACCOUNT_ID="your-account-id"
export CLOUDFLARE_API_TOKEN="your-workers-ai-token"
```

```yaml
defaultJudge:
  type: decision
  provider: cloudflare
  model: "@cf/cloudflare/clef-flash"
```

Clef-flash has a live-verified fixture. A Worker with an `AI` binding uses that binding instead of REST credentials; see [Workers deployment](/guide/deploy#cloudflare-workers-d1-and-ai).

## System One-compatible endpoint

Use this adapter for a service implementing the System One request and response shape. Verify the endpoint yourself; compatibility is defined by the adapter, not by a live fixture for your service.

```bash
export SYSTEMONE_BASE_URL="https://your-service.example/v1"
export SYSTEMONE_API_KEY="your-service-key"
```

```yaml
defaultJudge: { type: decision, provider: systemone, model: jev-latest }
```

Verdict appends `/systemone` to the base URL.

## OpenRouter and OpenAI: provisional adapters

These decision adapters are based on public write-ups, without a live-verified contract in this repository. Confirm endpoint availability and response compatibility before integrating them. These are separate from generative LLM providers with the same names.

```bash
export OPENROUTER_API_KEY="your-openrouter-key"
```

```yaml
defaultJudge: { type: decision, provider: openrouter, model: typesafe/jev-1.13 }
```

```bash
export OPENAI_API_KEY="your-openai-key"
```

```yaml
defaultJudge: { type: decision, provider: openai }
```

## Mock: offline integration

No environment variables or network access are required:

```yaml
defaultJudge: { type: decision, provider: mock }
```

Mock results test plumbing; they do not assess evidence quality.

## Credentials and evidence budgets

Use `apiKeyEnv: REVIEW_KEY` on a judge to read a custom environment variable instead of its provider’s default. Set `options.stateCharLimit` to limit rendered evidence; truncation is recorded in `rating.raw.stateTruncated`. Use criterion `inputs` tags to avoid sending unrelated documents.

The [verified contracts and fixtures](https://github.com/Ustay-coder/verdict/blob/main/docs/PROVIDERS.md) record endpoint shapes and verification dates. For batching, probability mapping, and escalation, follow [decision models](/guide/decision-models).

## Written feedback

Use `type: llm` when you need generated rationales and quotes. Its provider contract differs from `type: decision`; see [LLM judge fields](https://github.com/Ustay-coder/verdict/blob/main/docs/RUBRICS.md) for credential names and options.

Next, copy a judge into the [minimal rubric](./rubric), validate it, and evaluate representative evidence before choosing a confidence threshold.

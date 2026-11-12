# @verdict-ai/cli

Evaluate rubrics locally or against a hosted API from the terminal.

```bash
npm install @verdict-ai/cli
```

```bash
npx @verdict-ai/cli rubric init rubric.yaml
npx @verdict-ai/cli rubric validate rubric.yaml
export TYPESAFE_API_KEY=your-key
npx @verdict-ai/cli eval -r rubric.yaml -i ./pitch.txt
npx @verdict-ai/cli tasks
# Finish a pending criterion:
npx @verdict-ai/cli score eval_ID team --rater partner_a --score 4
# Inspect available commands:
npx @verdict-ai/cli --help
npx @verdict-ai/cli eval --help
```

Requires Node 22 or newer. [Documentation](https://docs.verdict-ai.dev/reference/cli). MIT licensed.

# Versions, forks and CI

Verdict can freeze a rubric into a version, fork it, run both on your own cases and show what the change did, case by case. The same loop runs in CI so a rubric change is reviewed like a code change. Everything below runs on the local engine; your cases and API keys stay on your machine or in your CI.

## The loop

```bash
verdict version freeze rubrics/intent.yaml            # rv_… (content-addressed) recorded in verdict.lock
verdict run -r rubrics/intent.yaml -d cases.jsonl      # run it over gold cases; the run is kept
verdict fork rv_… --to rubrics/intent-v2.yaml --note "count polite requests"
# edit rubrics/intent-v2.yaml
verdict version freeze rubrics/intent-v2.yaml          # linked to its parent, with what changed
verdict diff --base rubrics/intent.yaml --head rubrics/intent-v2.yaml -d cases.jsonl
verdict watch                                          # http://127.0.0.1:4600/compare
```

`diff` calls a result a **rubric change** only when nothing but the rubric differed: same cases, same model (named by the provider, not just an alias), same policy. When only the policy differs — a threshold, choice values, weights, aggregation or low-confidence handling — it is a **policy change**: the same answers, read another way. Otherwise it says **different conditions** and lists what differed. Cases are classified as fixed, regressed, kept, changed (unlabelled), asked a human, error or missing; answers that stayed the same but moved close to flipping are flagged as near the boundary. Rates always come with their denominator.

A policy change needs no new answers. When the head differs from the base only in policy, `diff` re-scores the base run's recorded answers under the head's rules instead of asking the judges again (no judge calls; the run notes what it was re-scored from). It falls back to running the cases, saying why, when the answers cannot be replayed: other questions, other models, panels or non-decision judges, checks, or a case without a recorded answer. `--rerun` always asks the judges.

Labels change too. `verdict diff … --labels cases-v2.jsonl` and `verdict rescore run_… -d cases-v2.jsonl` score stored runs against corrected labels without calling any judge, as long as the case inputs did not change.

## verdict.lock

Commit `verdict.lock`. For each rubric file it records the locked version, the fork parent and, after `verdict run`, the questions that version sent and the models that answered.

- `verdict version verify` fails when a rubric file no longer freezes to its locked version.
- `verdict eval`, `check` and `compare` warn when a locked rubric file changed, when the questions sent differ from the locked run, or when the provider now names a different model behind the same alias. `--strict` turns the warnings into failures; a changed file then fails before any judge is called.

## In a pull request

The `actions/diff` action in the Verdict repository compares a rubric changed in a pull request with its base-branch version on the same gold cases, posts one comment per rubric (updated on every push), writes the job summary and fails on the classes you choose.

```yaml
name: rubric review
on: pull_request
permissions: { contents: read, pull-requests: write }
jobs:
  diff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - uses: Ustay-coder/verdict/actions/diff@main
        with:
          rubric: rubrics/intent.yaml
          data: cases/intent.jsonl
          fail-on: regressed,error
          verify-lock: true
        env:
          TYPESAFE_API_KEY: ${{ secrets.TYPESAFE_API_KEY }}
```

Inputs: `rubric`, `data`, `base-ref` (default: the pull request's base commit), `fail-on` (default `regressed,error`; empty never fails), `verify-lock`, `mock` (no API calls, for trying it out), `comment`, `cli` (default `npx --yes @verdict-ai/cli@latest`), and for reporting `report`, `project`, `server`, `server-key`, `name`. Outputs: `kind` and `regressed`. The action needs a CLI release that includes `verdict diff`; until then point `cli` at a build of this repository.

## Running a version per environment

A Verdict server keeps your frozen versions and says which one each environment runs. It holds rubric documents and pointer changes only.

```yaml
# verdict.yaml — committed, so everyone and CI use the same project
project: support-bot
server: https://verdict.example.com
```

```bash
verdict login                                   # GitHub sign-in; or: verdict login --with-key < key.txt (self-hosted)
verdict project create support-bot
verdict env create staging && verdict env create prod
verdict version freeze rubrics/intent.yaml      # what you tested is what the lock names
verdict promote rubrics/intent.yaml --env staging
verdict promote --from staging --env prod --note "fewer wrong hand-offs"
verdict env show prod                           # intent  rv_…  2026-…
verdict rollback intent --env prod              # undo the latest change
verdict env history --env prod                  # who, when, from → to, why
```

`promote` uploads the version if the server lacks it, shows the change (`intent: rv_old → rv_new`) and asks; pass `--yes` in scripts. It sends the version it showed you, so if someone else changed the environment in between, nothing is applied and you are told where the pointer is now. A rubric file is promoted only when it freezes to the version `verdict.lock` records — run `verdict version freeze` (and your tests) first. Promoting a version nobody reported a run of is allowed, with a warning. The name services ask for a rubric by is `--name`, else the rubric's `id`, else its file name, and is recorded in `verdict.lock` on first upload, so moving the file does not rename it. `verdict env unset intent --env prod` stops an environment running a rubric; a version can be deleted only when no environment points at it.

In the service, read the environment with the SDK and evaluate locally — the texts you judge never go to the Verdict server:

```ts
const prod = verdict.environment({ project: 'support-bot', environment: 'prod' });
const { rubric, versionId, source } = await prod.rubric('intent');
```

It asks the server again at most once a minute, so a promotion or a rollback reaches the service without a deploy, and it keeps answering with the version it holds when the server cannot be reached ([SDK reference](../reference/sdk#reading-what-an-environment-runs)). The repository's `examples/control-plane` runs the whole loop — server, CI report, promotion, service, rollback — on one machine with no model key.

## Reporting runs to your team's server

A Verdict server can keep the numbers of your runs next to the versions they are runs of, so whoever promotes a version sees what was tested. Nothing but numbers is sent: the run's conditions (hashes, models), its counts and agreement, the dataset's file name, token usage, and the commit, branch and CI link. Cases, inputs, answers and case ids stay on the machine that ran them.

```bash
export VERDICT_HUB_KEY=…          # in CI; the project and server come from verdict.yaml (or VERDICT_PROJECT, VERDICT_HUB_URL)
verdict run -r rubrics/intent.yaml -d cases.jsonl --report
verdict diff --base main-intent.yaml --head rubrics/intent.yaml -d cases.jsonl --report   # both runs and the comparison's counts
verdict report run_…                                                                        # a run you already have
```

The run's rubric version is uploaded with the report when the server does not have it, under the rubric's name on the server: `--name`, else the name in `verdict.lock`, else the rubric's `id`, else its file name. Reporting the same run twice changes nothing. A run made with `--mock` is never reported. In the pull-request action, set `report: true` with `project`, `server` and `server-key` (a secret); a report that cannot be sent is noted in the comment and does not fail the job.

## Publishing to a hub

```bash
verdict hub login --hub https://hub.example        # GitHub device flow: open the link, enter the code
verdict publish rubrics/intent.yaml --slug agent-intent --license CC-BY-4.0 \
  --cases cases.jsonl --case explicit polite --run run_…
verdict hub list
verdict withdraw pub_…
```

`publish` first shows the hub's preview — exactly what would become public — and asks before publishing (`--yes` in scripts, `--dry-run` to stop at the preview). Only the cases you name are sent, and they are marked public; runs contribute their numbers only, and the preview says whether all of a run's cases are public. One question per card, a licence, and an explicit `threshold` for yes/no questions are required. In CI, set `VERDICT_HUB_URL` and `VERDICT_HUB_KEY` instead of signing in.

## Taking a card from a hub

Browse `https://hub.example/hub` — no account needed. Each card page shows two commands:

```bash
verdict pull hub:alice/agent-intent@rv_… --hub https://hub.example
verdict fork hub:alice/agent-intent@rv_… --to my-intent.yaml --hub https://hub.example
```

`pull` writes the rubric exactly (`agent-intent.yaml`; `--to` to choose) and its public cases next to it (`agent-intent.cases.jsonl`; `--cases FILE` or `--no-cases`). The rubric is frozen locally and must give the version id the hub names — a card that does not is refused and nothing is written — so `verdict version verify` and `verdict run` start from exactly what was published. `fork` writes an editable copy instead; the hub version becomes the recorded parent, so `verdict version freeze my-intent.yaml` lists what you changed and `verdict diff` compares your fork with it on the same cases. Both record the hub, the ref and the licence under `origin` in `verdict.lock`. Publishing your fork later links it to the parent's public page.


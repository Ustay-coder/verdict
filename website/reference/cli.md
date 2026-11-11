# CLI

```bash
npx @verdict-ai/cli --help
npx @verdict-ai/cli rubric init rubric.yaml
npx @verdict-ai/cli rubric validate rubric.yaml
npx @verdict-ai/cli eval -r rubric.yaml -i ./pitch.pdf -i https://example.com
```

The `verdict` binary uses the local engine and `.verdict` file store by default. Named inputs such as `-i ci=./ci.json` let criteria filter evidence. Configure provider credentials for model judges; `--mock` replaces decision and generative LLM judges for offline runs.

| Command | Purpose |
| --- | --- |
| `rubric init`, `rubric validate`, `rubric push`, `rubric list` | Author and store rubrics |
| `eval`, `get`, `export`, `retry` | Evaluate and inspect results |
| `tasks`, `score` | Collect human ratings |
| `compare` | Evaluate subjects and rank them |
| `reaggregate` | Recompute policy using stored ratings |
| `calibrate` | Compare decision confidence with humans |
| `check` | Run a rubric over a human-labelled gold set and report agreement |
| `version freeze`, `version show`, `version list`, `version export`, `version verify` | Freeze rubric files into content-addressed versions, record them in `verdict.lock`, export a version exactly, and check in CI that files still match the lock |
| `fork` | Copy a version (`rv_…`, a rubric file, or a hub card `hub:owner/slug@rv_…`) into a new rubric file to edit; the parent is recorded in `verdict.lock` |
| `run` | Run a rubric version over a gold file and keep the run. `--models jev,clef,clef-flash` runs it once per decision model instead, without editing the rubric, and shows the models side by side ([guide](../guide/decision-models#which-model-on-your-cases)) |
| `diff` | Compare two versions or runs case by case (fixed, regressed, near boundary…); a policy-only change is re-scored from recorded answers without judge calls (`--rerun` asks again); `--fail-on regressed` gates CI; `--markdown` for PR comments |
| `rescore` | Score a stored run against new labels without calling judges |
| `hub login`, `hub whoami`, `hub list`, `hub logout` | Sign in to a hub with GitHub (device flow), check who you publish as, list your publications, sign out (revokes the key) |
| `publish`, `withdraw` | Publish a rubric version with the cases (`--case`) and runs (`--run`) you name, after the hub's preview; withdraw a publication |
| `pull` | Copy a rubric exactly into a file: a hub card (`hub:owner/slug[@rv_…]`) with its public cases (no sign-in needed), or a version your team's server keeps (`<name> --env <environment>`, `<name>@latest`, `<name>@rv_…`) |
| `report` | Send a stored run's numbers to a project on a Verdict server (`--project` or `VERDICT_PROJECT`; server and key as for the hub). Only conditions and counts are sent: no case, input or answer. `run --report` and `diff --report` do it right after running; `diff --report` also sends the comparison's counts. Mock runs are never reported |
| `login` | Same as `hub login`. `--with-key` saves an API key read from standard input for a self-hosted server (checked with the server first). Keys are kept one per server address |
| `project create`, `project list`, `project delete` | Projects on a Verdict server |
| `env create`, `env list`, `env show`, `env delete` | Environments of a project and which version of each rubric they run |
| `env history`, `env unset` | Who changed which pointer, when, from what to what (`--env`, `--name`, `--limit`); stop an environment running a rubric |
| `push` | Upload a version under the name services ask for it by: a rubric file (frozen and recorded in `verdict.lock` first) or `rv_…`; the name is recorded in `verdict.lock` |
| `promote` | Make an environment run versions (`--env`): rubric files (must match `verdict.lock`) or `rv_…` ids, or `--from <environment>` to copy what another environment runs. Shows the change and asks (`--yes` in scripts); refused if the environment changed meanwhile |
| `rollback` | Undo the latest change of a rubric's pointer in an environment |
| `keys` | Manage database-backed API keys |
| `serve`, `mcp` | Start REST or stdio MCP |
| `watch` | Live local page of evaluations and leaderboards |

`eval`, `check` and `compare` check a rubric file listed in `verdict.lock`: they warn when it changed since it was frozen, or when the questions sent or the answering model differ from its locked run; `--strict` fails instead (see [Versions, forks and CI](/guide/versions)).

`run`, `diff`, `eval`, `check` and `compare` take a rubric by its name on your team's server instead of a file: `-r intent --env prod` (the version that environment runs), `-r intent@latest` (the newest uploaded) or `-r intent@rv_…`. The document is fetched, checked against its id and judged with on your machine; see [Using a rubric from any machine](../guide/versions#using-a-rubric-from-any-machine).

Set `VERDICT_API_URL` and `VERDICT_API_KEY` for remote mode. The management commands (`project`, `env`, `push`, `promote`, `rollback`, `report`) do not use those: they read the project from `--project`, `VERDICT_PROJECT`, then `project:` in the nearest `verdict.yaml`, and the server from `--hub`, `VERDICT_HUB_URL`, `server:` in that file, then the most recent `verdict login`. On servers where one sign-in reaches several organizations, `--org`, `VERDICT_ORG` or `org:` in `verdict.yaml` names the one to work in (default: your own). `verdict login` follows the sign-in the server announces: GitHub's device flow, or a code you approve on the server's own page. Run `<command> --help` for its flags. The [source command definitions](https://github.com/Ustay-coder/verdict/blob/main/packages/cli/src/index.ts) are the complete reference.

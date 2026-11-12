# Configuration

Everything Verdict reads from the environment: model keys, where it stores things, and which server the command line talks to.

| Env | Meaning |
| --- | --- |
| `TYPESAFE_API_KEY` | `decision` / `typesafe` — Jev (default judge). `VERDICT_TYPESAFE_MODEL` (default `jev-latest`) |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | `decision` / `cloudflare` — Clef, Clef-flash, `typesafe/jev` on Workers AI. `VERDICT_CLOUDFLARE_MODEL` (default `@cf/cloudflare/clef`) |
| `OPENROUTER_API_KEY` | `decision` / `openrouter` — `typesafe/jev-1.13`, `inception/mercury-decide`, … |
| `OPENAI_API_KEY` | `decision` / `openai` — Decisions API (`gpt-6-luna`); also the `llm` / `openai` generative judge |
| `SYSTEMONE_BASE_URL`, `SYSTEMONE_API_KEY` | `decision` / `systemone` — any endpoint speaking the `/v1/systemone` shape (self-hosted Clef, DigitalOcean, gateways) |
| `ANTHROPIC_API_KEY` | `llm` / `anthropic` generative judge (rationales). `VERDICT_ANTHROPIC_MODEL` (default `claude-opus-5-5`) |
| `VERDICT_HTTP_JUDGE_URL`, `VERDICT_HTTP_JUDGE_KEY` | `llm` / `http` — a prompted judge behind your own URL |
| `VERDICT_DATABASE` | SQLite file for the Node server (Drizzle + better-sqlite3; same schema and migrations as D1). Enables DB-managed keys. |
| `VERDICT_API_KEYS` | `key:tenant,key2:tenant2` bootstrap keys for the API |
| `VERDICT_ADMIN_KEY` | Bearer token for `/v1/admin/*` (key management, hub takedowns) |
| `VERDICT_ROUTES` | Route groups to serve, comma-separated: `evaluations`, `rubrics`, `hub`, `control` (projects). Unset serves all; a group left out answers 404 |
| `VERDICT_DATA_DIR` | Persist to JSON files instead (CLI default `./.verdict`; API default memory) |
| `VERDICT_WEBHOOK_SECRET` | HMAC signing of webhook deliveries |
| `VERDICT_ALLOW_LOCAL_FILES=1` | Let the API read `file.path` inputs (off by default; CLI/MCP local mode allow it) |
| `VERDICT_API_URL`, `VERDICT_API_KEY` | Make the CLI / MCP server talk to a hosted API instead of the local engine |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Hub sign-in with GitHub (OAuth App with Device Flow enabled). With a client id set, only signed-in GitHub accounts can publish, under their login |
| `VERDICT_HUB_URL`, `VERDICT_HUB_KEY` | The server `verdict hub` / `publish` / `withdraw` / `pull` / `fork hub:…`, the management commands (`project`, `env`, `push`, `promote`, `rollback`, `report`) and the MCP hub tools talk to, and a key for CI (otherwise `verdict login` keeps one key per server in `~/.config/verdict/hub.json`) |
| `VERDICT_PROJECT` | Project the management commands and `--report` work on. Read after `--project` and before the `project:` of the nearest `verdict.yaml` (which may also name the `server:`) |
| `VERDICT_ORG` | Organization those commands work in, on servers where one sign-in reaches several (`--org`, else this, else `org:` in `verdict.yaml`; default: your own). Sent as `x-verdict-org`; servers without organizations ignore it |

Secrets never live in rubrics: judges reference them with `apiKeyEnv: MY_KEY_VAR`.

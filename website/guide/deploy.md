# Deployment

Choose persistence first. Memory storage is useful for demos; production evaluations and API keys need a durable store. All reads are tenant scoped, and database keys are stored as SHA-256 hashes.

## Node with SQLite or Postgres

```bash
npx @verdict-ai/cli keys create --database ./verdict.sqlite --tenant acme --name service
VERDICT_ADMIN_KEY=replace-me npx @verdict-ai/cli serve --database ./verdict.sqlite
# Or use Postgres:
VERDICT_DATABASE=postgres://user:password@localhost/verdict npx @verdict-ai/cli serve
```

Node adapters apply migrations on startup. SQLite uses the optional `better-sqlite3` native driver; Postgres uses `pg`. Verify the driver is available on the deployment platform. A JSON file store (`--data-dir ./data`) is another single-node option.

Use `Authorization: Bearer <tenant-key>` for requests. Admin routes require the separate admin key and a database key store. Without configured auth the service runs open as one tenant, so configure keys before exposing it.

## Cloudflare Workers, D1 and AI

Build the repository, copy [the example configuration](https://github.com/Ustay-coder/verdict/blob/main/packages/api/wrangler.example.toml) to `packages/api/wrangler.toml`, and set your D1 database ID. From `packages/api`:

```bash
wrangler d1 create verdict
wrangler d1 migrations apply verdict --remote
wrangler secret put TYPESAFE_API_KEY
wrangler secret put VERDICT_ADMIN_KEY
wrangler deploy
```

To run a public hub, create a GitHub OAuth App (any callback URL; tick **Enable Device Flow**), then `wrangler secret put GITHUB_CLIENT_ID` and `wrangler secret put GITHUB_CLIENT_SECRET`. Authors sign in with `verdict hub login --hub https://your-worker`. The secret is optional but recommended: with it the hub accepts only tokens minted for your app. The GitHub token is never stored; the hub keeps the account id and login and issues its own key. Sign-in, publishing and public reads are rate-limited; uncomment the `[[ratelimits]]` bindings in `wrangler.example.toml` so the limits hold across isolates. With `VERDICT_ADMIN_KEY` set, operators can take publications down (`POST /v1/admin/publications/:id/takedown` with a public reason) and restore them. A key from hub sign-in works on every route group the server serves, so on a public hub set `VERDICT_ROUTES` (for example `hub`) to leave out evaluation, rubric and project routes you do not mean to offer to everyone. Write your terms of use and privacy policy before opening the hub to the public.

### Rehearse locally first

`wrangler dev` runs the same bundle on a local D1 database and simulates the rate limiting bindings, so the whole hub flow can be tried before deploying. Leave out the `[ai]` block for this (Workers AI is always remote and needs `wrangler login`), set `VERDICT_ADMIN_KEY` under `[vars]`, then from `packages/api`:

```bash
wrangler d1 migrations apply verdict --local
wrangler dev --local --port 8799
curl -X POST localhost:8799/v1/admin/keys -H 'authorization: Bearer <admin key>' -H 'content-type: application/json' -d '{"tenantId":"me","name":"rehearsal"}'
export VERDICT_HUB_URL=http://localhost:8799 VERDICT_HUB_KEY=<key from the line above>
verdict publish card.yaml --slug my-card --license CC-BY-4.0 --cases cases.jsonl --case c1 --yes
verdict pull hub:me/my-card --to copy.yaml && verdict version verify
```

Without `GITHUB_CLIENT_ID` the hub publishes under tenant ids, as above; GitHub sign-in itself can only be tried against a real OAuth App. Open `http://localhost:8799/hub` to see the pages.

The worker entry is `dist/worker.js`, with `nodejs_compat`, a `DB` binding and optionally an `AI` binding for Clef. AI binding calls do not need a REST API token inside the Worker. D1 migrations are shipped in `@verdict-ai/db/drizzle`; point `migrations_dir` to that directory when deploying installed npm packages instead of the repository.

## Queues

The Node server uses a built-in in-process queue; it is not durable across process restarts. For Workers, create `verdict-jobs` and `verdict-dlq`, then enable the producer (`QUEUE`) and consumer blocks in the example configuration. Queues require a suitable Cloudflare plan.

Send `async: true` to enqueue and poll the returned URL. Transient ingestion/provider errors retry with backoff; exhausted jobs become `failed` with dead-letter information. `POST /v1/evaluations/:id/retry` resets attempts for failed work. Terminal webhooks fire after completion or exhausted retries.

For signed webhooks set `VERDICT_WEBHOOK_SECRET`; verify the `verdict-signature: sha256=<hmac>` header against the raw body. See [architecture](https://github.com/Ustay-coder/verdict/blob/main/docs/ARCHITECTURE.md) for operational details.

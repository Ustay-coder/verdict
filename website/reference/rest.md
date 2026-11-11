# REST API

Use `Authorization: Bearer <tenant-key>` (or `x-api-key`) for `/v1` resources. Discovery routes are public. Admin routes require the separate `VERDICT_ADMIN_KEY` and a database-backed key manager. Requests below use JSON; rubric create/replace/validate also accept YAML with `Content-Type: application/yaml`.

## Retries and errors

Send `Idempotency-Key` (1–255 characters) on evaluation or batch creation. A matching retry within the tenant returns HTTP 200 with `Idempotency-Replayed: true` and stored results, without judging again. A different body with the same key returns 409. Keys expire after 24 hours by default. `async` and `includeEvidence` do not change request identity. Async replays return the current `{ id, status, url }` summary.

```http
POST /v1/evaluations
Authorization: Bearer your-key
Content-Type: application/json
Idempotency-Key: review-123

{"rubric":"rub_ID","inputs":[{"type":"text","text":"Evidence"}]}
```

Errors use this envelope (validation errors may also include `issues`):

```json
{"error":{"type":"not_found","message":"evaluation eval_ID not found"}}
```

Types are `validation`, `not_found`, `idempotency_conflict`, `http`, and `internal`. Project routes add `already_exists`, `in_use`, `unknown_version`, `unknown_run`, `pointer_conflict`, `nothing_to_roll_back`, and — when the server is set up to refuse some requests — `forbidden`, `limit_exceeded`, `approval_required` (HTTP 403). A failed synchronous evaluation can return HTTP 422 with an evaluation document rather than an error envelope. Rubric validation returns HTTP 200 with `valid: false` for invalid rubrics.

## Routes and examples

Response examples below are abbreviated projections of JSON documents; omitted fields remain part of the API. IDs are placeholders. Evaluation documents include `id`, `status`, `subject`, a rubric summary, evidence metadata, criterion results, ratings, pending tasks and aggregate. Evidence text is omitted unless requested. List and batch responses omit individual ratings.

### GET `/`

Service discovery.

```http
GET /
```

Response: HTTP 200

```json
{
  "name": "verdict",
  "version": "0.1.0",
  "docs": "/v1/openapi.json"
}
```

### GET `/v1/health`

Health check.

```http
GET /v1/health
```

Response: HTTP 200

```json
{
  "ok": true
}
```

### GET `/v1/openapi.json`

Discovery specification; currently a stub, not the full route contract.

```http
GET /v1/openapi.json
```

Response: HTTP 200

```json
{
  "openapi": "3.1.0"
}
```

### POST `/v1/rubrics`

Create a rubric; defaults are filled and references validated.

```http
POST /v1/rubrics
Content-Type: application/json

{"name": "Presence", "criteria": [{"id": "present", "name": "Has text", "judge": {"type": "benchmark", "method": "length", "min": 1}}]}
```

Response: HTTP 201

```json
{
  "id": "rub_ID",
  "name": "Presence",
  "criteria": [
    {
      "id": "present",
      "name": "Has text",
      "judge": {
        "type": "benchmark",
        "method": "length",
        "min": 1
      }
    }
  ]
}
```

### POST `/v1/rubrics/validate`

Validate without storing. Invalid response: `{ "valid": false, "error": "..." }` (error can be an issues array).

```http
POST /v1/rubrics/validate
Content-Type: application/json

{"name": "Presence", "criteria": [{"id": "present", "name": "Has text", "judge": {"type": "benchmark", "method": "length", "min": 1}}]}
```

Response: HTTP 200

```json
{
  "valid": true,
  "rubric": {
    "name": "Presence",
    "criteria": [
      {
        "id": "present",
        "name": "Has text",
        "judge": {
          "type": "benchmark",
          "method": "length",
          "min": 1
        }
      }
    ]
  }
}
```

### GET `/v1/rubrics?limit=100`

List tenant rubrics.

```http
GET /v1/rubrics?limit=100
```

Response: HTTP 200

```json
{
  "data": [
    {
      "id": "rub_ID",
      "name": "Presence",
      "criteria": [
        {
          "id": "present",
          "name": "Has text",
          "judge": {
            "type": "benchmark",
            "method": "length",
            "min": 1
          }
        }
      ]
    }
  ]
}
```

### GET `/v1/rubrics/rub_ID`

Read a rubric; unknown ID returns 404.

```http
GET /v1/rubrics/rub_ID
```

Response: HTTP 200

```json
{
  "id": "rub_ID",
  "name": "Presence",
  "criteria": [
    {
      "id": "present",
      "name": "Has text",
      "judge": {
        "type": "benchmark",
        "method": "length",
        "min": 1
      }
    }
  ]
}
```

### PUT `/v1/rubrics/rub_ID`

Replace a rubric. Existing evaluation snapshots stay frozen.

```http
PUT /v1/rubrics/rub_ID
Content-Type: application/json

{"name": "Presence", "criteria": [{"id": "present", "name": "Has text", "judge": {"type": "benchmark", "method": "length", "min": 1}}]}
```

Response: HTTP 200

```json
{
  "id": "rub_ID",
  "name": "Presence",
  "criteria": [
    {
      "id": "present",
      "name": "Has text",
      "judge": {
        "type": "benchmark",
        "method": "length",
        "min": 1
      }
    }
  ]
}
```

### DELETE `/v1/rubrics/rub_ID`

Delete; unknown ID returns 404. Response has no body.

```http
DELETE /v1/rubrics/rub_ID
```

Response: HTTP 204.

### GET `/v1/rubrics/rub_ID/calibration?target=0.8&buckets=5&limit=1000`

Compare stored decision ratings with human consensus. Target is 0..1; buckets 1..1000; limit is a positive integer. See the [report type](https://github.com/Ustay-coder/verdict/blob/main/packages/core/src/calibration.ts) for metrics and null semantics.

```http
GET /v1/rubrics/rub_ID/calibration?target=0.8&buckets=5&limit=1000
```

Response: HTTP 200

```json
{
  "suggestedMinConfidence": null
}
```

### POST `/v1/evaluations`

`rubric` accepts an ID or inline object. Provide `inputs` or `subject: { name, inputs }`; optional fields: `name`, `metadata`, `webhook`, `includeEvidence`, `async`. With `async: true`, a fresh request returns 202 `{ "id": "eval_ID", "status": "queued", "url": "/v1/evaluations/eval_ID" }`. Poll the URL. Sync failures return 422; idempotent replays return 200.

```http
POST /v1/evaluations
Content-Type: application/json

{"rubric": "rub_ID", "inputs": [{"type": "text", "text": "Evidence"}]}
```

Response: HTTP 201

```json
{
  "id": "eval_ID",
  "status": "completed",
  "aggregate": {
    "score": 100,
    "partial": false
  },
  "criteria": [
    {
      "criterionId": "present",
      "score": 10,
      "normalized": 1,
      "ratings": []
    }
  ]
}
```

### GET `/v1/evaluations?rubric=rub_ID&status=completed&limit=50`

List tenant evaluations with optional rubric/status filters. Individual ratings are omitted.

```http
GET /v1/evaluations?rubric=rub_ID&status=completed&limit=50
```

Response: HTTP 200

```json
{
  "data": [
    {
      "id": "eval_ID",
      "status": "completed",
      "aggregate": {
        "score": 100,
        "partial": false
      },
      "criteria": [
        {
          "criterionId": "present",
          "score": 10,
          "normalized": 1,
          "ratings": []
        }
      ]
    }
  ]
}
```

### GET `/v1/evaluations/eval_ID?evidence=true`

Fetch current status and ratings; `evidence=true` includes extracted text. Unknown ID returns 404.

```http
GET /v1/evaluations/eval_ID?evidence=true
```

Response: HTTP 200

```json
{"id":"eval_ID","status":"completed","aggregate":{"score":100,"partial":false}}
```

### POST `/v1/evaluations/eval_ID/retry`

Retry failed work and reset attempts. Unknown ID: 404; non-failed evaluation: 409.

```http
POST /v1/evaluations/eval_ID/retry
```

Response: HTTP 202

```json
{"id":"eval_ID","status":"completed","aggregate":{"score":100,"partial":false}}
```

### POST `/v1/evaluations/eval_ID/scores`

Submit a human score as a number, scale label, or choice ID. Optional confidence is 0..1. Returns the updated evaluation.

```http
POST /v1/evaluations/eval_ID/scores
Content-Type: application/json

{"criterionId": "team", "raterId": "reviewer", "score": 4, "rationale": "Relevant experience"}
```

Response: HTTP 200

```json
{"id":"eval_ID","status":"completed","aggregate":{"score":100,"partial":false}}
```

### POST `/v1/evaluations/eval_ID/aggregate`

Reaggregate stored ratings without judges. `persist` defaults to false.

```http
POST /v1/evaluations/eval_ID/aggregate
Content-Type: application/json

{"aggregation": {"method": "min"}, "persist": false}
```

Response: HTTP 200

```json
{"id":"eval_ID","status":"completed","aggregate":{"score":100,"partial":false}}
```

### GET `/v1/tasks?rater=reviewer`

Pending human inbox. Optional rater filter includes allowed generic slots. Scans up to 500 pending evaluations.

```http
GET /v1/tasks?rater=reviewer
```

Response: HTTP 200

```json
{
  "data": [
    {
      "evaluationId": "eval_ID",
      "criterionId": "team",
      "raterId": "reviewer",
      "rubric": "Review"
    }
  ]
}
```

### POST `/v1/batches`

Evaluate multiple subjects using one rubric. Optional metadata/webhook; supports Idempotency-Key and returns 200 on replay.

```http
POST /v1/batches
Content-Type: application/json

{"rubric": "rub_ID", "subjects": [{"name": "Acme", "inputs": [{"type": "text", "text": "Evidence"}]}]}
```

Response: HTTP 201

```json
{
  "ranking": [
    {
      "rank": 1,
      "evaluationId": "eval_ID",
      "subject": "Acme",
      "score": 100,
      "status": "completed"
    }
  ],
  "evaluations": [
    {
      "id": "eval_ID",
      "status": "completed",
      "aggregate": {
        "score": 100,
        "partial": false
      },
      "criteria": [
        {
          "criterionId": "present",
          "score": 10,
          "normalized": 1,
          "ratings": []
        }
      ]
    }
  ]
}
```

### POST `/v1/admin/keys`

Use the admin bearer token. The raw key is returned once; store it securely.

```http
POST /v1/admin/keys
Content-Type: application/json

{"tenantId": "acme", "name": "service"}
```

Response: HTTP 201

```json
{
  "id": "key_ID",
  "key": "vk_live_SECRET",
  "prefix": "vk_live_..."
}
```

### GET `/v1/admin/keys?tenant=acme`

Admin bearer token; tenant query is required. Raw keys are never listed.

```http
GET /v1/admin/keys?tenant=acme
```

Response: HTTP 200

```json
{
  "data": [
    {
      "id": "key_ID",
      "name": "service",
      "prefix": "vk_live_...",
      "createdAt": "2026-11-05T00:00:00.000Z",
      "lastUsedAt": null,
      "revokedAt": null
    }
  ]
}
```

### DELETE `/v1/admin/keys/key_ID`

Revoke a key using the admin bearer token. Unknown ID returns 404. Response has no body.

```http
DELETE /v1/admin/keys/key_ID
```

Response: HTTP 204.

## Where next

Use the [TypeScript SDK](./sdk) for typed requests and polling, connect an agent through [MCP](./mcp), or [deploy a persistent API](/guide/deploy) before storing production evaluations.

## Publishing to the hub

### Signing in: GET `/v1/hub/config` · POST `/v1/hub/login`

Neither needs a key. `config` returns `{ "github": { "clientId": "…" } | null, "publishing": "github" | "tenant" }`. A client runs GitHub's device flow with that client id (empty scope) and posts the token:

```http
POST /v1/hub/login
Content-Type: application/json

{"githubToken": "gho_…"}
```

HTTP 201 `{ "apiKey": "vk_live_…", "keyId": "key_…", "handle": "alice", "tenantId": "gh:42" }`. The hub asks GitHub whose token it is — through `POST /applications/{client_id}/token` when `GITHUB_CLIENT_SECRET` is set, so tokens of other apps are refused, else `GET /user` — and keeps only the account id and login. 401 for a token GitHub does not accept, 502 when GitHub cannot be reached, 501 when sign-in is not configured. With sign-in configured, only signed-in accounts publish, under their login; a ref (`owner/slug`) stays with the account that first published under it. `GET /v1/hub/me` says who a key publishes as; `DELETE /v1/hub/keys/:id` revokes one of the account's keys.

A publication is a copy of exactly what an author chose to make public: one rubric version, the cases marked `visibility: public`, and the numbers of chosen runs. Public reads of the hub (below) read only publications, without the publishing tenant; nothing else on the server becomes public.

### POST `/v1/publications/preview`

Builds the publication without storing it. Always HTTP 200: `ok`, `issues` (each with a `path`), `warnings` (personal-looking data, unreviewed labels) and, when `ok`, the `publication` that `POST /v1/publications` would store.

```http
POST /v1/publications/preview
Content-Type: application/json

{"slug": "agent-intent-ko", "license": "CC-BY-4.0",
 "version": {"id": "rv_…", "rubric": {"name": "…", "criteria": [{"id": "wants_agent", "name": "…", "scale": {"type": "binary"}, "threshold": 0.6}]}},
 "cases": [{"id": "c1", "name": "explicit request", "inputs": [{"type": "text", "text": "상담원 연결해 주세요."}], "expected": {"wants_agent": "yes"}, "visibility": "public", "labelSource": "human"}],
 "runs": [{"run": {"…": "a stored run"}, "report": {"…": "its agreement report"}}]}
```

Rules: `version.id` must be what the rubric freezes to; exactly one criterion; licence one of `CC-BY-4.0`, `CC-BY-SA-4.0`, `CC0-1.0`, `MIT`, `Apache-2.0`; yes/no criteria need `threshold`; no judge `baseUrl`; cases must be `visibility: public` with `text`, `json` or `url` inputs; runs must be of the published version. Runs keep only their fingerprint, counts and agreement numbers (`origin: "author_reported"`); case ids, inputs and outputs are dropped. A published parent version is linked; an unpublished one is shown only as private.

### POST `/v1/publications`

Same body. HTTP 201 `{ publication, warnings, created: true }`; 200 with `created: false` when the same `owner/slug` version is already published; 400 `{ error: { type: "validation", issues } }`; 409 when that version was withdrawn; 413 over 1 MB. On a server without GitHub sign-in, a tenant publishes under its tenant id as owner.

### GET `/v1/publications` · DELETE `/v1/publications/:id`

List the caller's publications (withdrawn included); withdraw one (204; 404 for another tenant's). Withdrawal removes it from search; copies others already downloaded or forked are not recalled.

## Reading the hub

No key needed. These routes read only publications and never return the publishing tenant.

### GET `/v1/public/rubrics`

Search: `q` (title, owner, slug, domain; case-insensitive), `domain`, `locale`, `type` (`score`, `noul`, `choice`), `owner`, `limit` (1–50, default 50). One result per card (`owner/slug`) at its newest live version, newest first:

```json
{"data": [{"ref": "alice/agent-intent", "owner": "alice", "slug": "agent-intent", "title": "…", "judgmentType": "noul", "license": "CC-BY-4.0",
  "latest": {"publicationId": "pub_…", "versionId": "rv_…", "createdAt": "…"}, "cases": 12, "runs": 1,
  "parent": {"public": true, "ref": "support/agent-intent-ko", "versionId": "rv_…", "publicationId": "pub_…"}}]}
```

### GET `/v1/public/rubrics/:owner/:slug`

`{ publication, versions }`: the card at `?version=rv_…` (default: its newest live version) and every version it has had, newest first, withdrawn ones with `withdrawnAt`. 404 for an unknown card or version; 410 `{ error: { type: "withdrawn", message, withdrawnAt } }` for a withdrawn version.

### GET `/v1/public/publications/:id`

One publication by id; 404 / 410 as above.

### Pages: `/hub` and `/hub/:owner/:slug`

The same reads as HTML: a search form and a card page with the question, its answers and threshold, lineage (a published parent is linked, an unpublished one only mentioned), reported runs (author-reported numbers, whether anyone can repeat them), public cases, versions and the rubric YAML. Each card shows copyable `verdict pull` and `verdict fork` commands. Pages carry no scripts and a strict Content-Security-Policy; everything authors wrote is escaped.


## Hub operations

### Limits

Sign-in (`POST /v1/hub/login`) is limited per client address, publishing (`POST /v1/publications` and its preview) per account, and the public reads and pages per client address — by default 10, 30 and 300 requests a minute. Over the limit the answer is HTTP 429 `{ "error": { "type": "rate_limited", … } }` with `Retry-After: 60`. On Cloudflare, bind `HUB_LOGIN_LIMITER`, `HUB_PUBLISH_LIMITER` and `HUB_READ_LIMITER` ([Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)) to share counts across isolates; without them each isolate counts on its own. The client address is Cloudflare's `cf-connecting-ip` on Workers and the socket address on the Node server (behind a proxy, limit at the proxy too).

### Takedowns: `/v1/admin/publications`

With `VERDICT_ADMIN_KEY`. `GET /v1/admin/publications?q=&owner=&slug=&limit=` lists every publication, withdrawn included, with its tenant. `POST /v1/admin/publications/:id/takedown` with `{ "reason": "…" }` withdraws it and records the takedown; public reads then answer 410 `{ "error": { "type": "taken_down", "message": "alice/agent at rv_… was taken down by the hub's operators on 2026-11-09: …" } }`, and the author sees the takedown in `GET /v1/publications`. `POST /v1/admin/publications/:id/restore` puts back what the operators took down; a publication its author withdrew stays withdrawn (409).

## Projects, environments and versions

A project keeps immutable rubric versions under the names services ask for, and environments that say which version of each rubric runs. The server stores rubric documents and pointer changes only: no cases, inputs or outputs. Project, environment and rubric names are lowercase letters, digits and dashes (up to 63 characters).

### Projects: `/v1/projects`

`POST { "name": "support-bot" }` creates a project (201; 409 `already_exists`). `GET` lists this tenant's projects. `DELETE /v1/projects/support-bot` with `{ "confirm": "support-bot" }` deletes the project and everything in it.

### Environments: `/v1/projects/:project/environments`

`POST { "name": "prod" }` creates an environment; `GET` lists them. `GET …/environments/prod` returns the environment with its pointers:

```json
{"project":"support-bot","name":"prod","createdAt":"…","pointers":[{"name":"intent","versionId":"rv_…","updatedAt":"…"}]}
```

`GET …/environments/prod?include=rubrics` adds the `rubric` document to each pointer: everything a service needs to run, in one answer. Both forms answer with an `ETag`; send it back as `If-None-Match` and an environment whose pointers did not change answers 304 with no body. Versions never change, so the pointers alone identify the answer.

`DELETE …/environments/prod` with `{ "confirm": "prod" }` removes the environment and its pointers. Its history stays in the project.

### Versions: `/v1/projects/:project/rubrics/:name/versions`

`POST { id, rubric, parentVersionId?, fork? }` stores a version under `:name`. The server freezes the rubric again and answers 400 when it does not freeze to `id`. 201 for a new version, 200 with the stored one when it is already there, 413 over 1 MB. `GET` lists a rubric's versions newest first without the rubric documents; `GET …/versions/rv_…` returns one with its rubric. `DELETE` answers 409 `in_use` while an environment points at the version. `GET /v1/projects/:project/rubrics` lists rubric names with version counts.

### Promotions: POST `/v1/projects/:project/environments/:env/promotions`

```json
{"changes":[{"name":"intent","versionId":"rv_NEW","expected":"rv_OLD"}],"note":"fewer wrong hand-offs"}
```

Each change names the version you saw the pointer at (`expected`; `null` when there was none). All changes of a request (at most 20, each rubric once) apply or none do. `versionId: null` removes a pointer. A version can be promoted only under the name it was uploaded as (400 `unknown_version`). When a pointer is not where you saw it, nothing is applied and the answer says where the pointers are:

```json
{"error":{"type":"pointer_conflict","message":"prod changed since you read it; nothing was applied","current":[{"name":"intent","versionId":"rv_OTHER"}]}}
```

### Rollbacks: POST `/v1/projects/:project/environments/:env/rollbacks`

`{ "name": "intent", "expected": "rv_NEW", "note"?: "…" }` puts the pointer back where its latest change found it; rolling back again returns to where it was. 409 `nothing_to_roll_back` when no earlier version is on record (the first promotion, or an earlier version that was deleted).

### History: GET `/v1/projects/:project/history?environment=&name=&limit=`

Pointer changes, newest first: `{ id, environment, name, from, to, kind, note?, actor?, at }` with `kind` one of `promote`, `rollback`, `unset`. `actor` is the API key that made the change (its id and name when keys are stored in a database). History cannot be edited or deleted through the API.

### Run reports: `/v1/projects/:project/reports/runs`

`POST` stores the numbers of a run made elsewhere (your CI). The request has no field for a case id, an evaluation id, an input or an output; fields it does not know are dropped.

```json
{"name":"intent","run":{"id":"run_…","rubricVersionId":"rv_…","datasetVersionId":"ds_…","status":"completed","startedAt":"…","fingerprint":{"judgmentHash":"…","policyHash":"…","bindingHash":"…","questionsHash":"…","adapterVersion":"…","casesHash":"…","labelsHash":"…","models":[],"scoring":"agreement@1"},"counts":{"cases":40,"completed":40,"pendingHuman":0,"failed":0,"invalidInput":0,"labelled":40},"usage":{"decisionCalls":40,"llmCalls":0,"inputTokens":9200,"outputTokens":0}},"report":{"decided":40,"agreed":37,"criteria":{"wants":{"n":40,"agreed":37,"askedHuman":0}}},"datasetName":"cases.jsonl","source":{"commit":"…","branch":"…","url":"…"},"version":{"id":"rv_…","rubric":{}}}
```

`version` uploads the run's rubric version under `name` when the server does not have it; without it an unknown version answers 400 `unknown_version`. The run must name its version's judgment, policy and binding hashes. 201 for a new report, 200 with the stored one when that run was already reported. Every report is kept as `origin: "author_reported"`: the server cannot repeat the run. `GET …/reports/runs?name=&versionId=&dataset=&limit=` lists reports newest run first; `GET …/reports/runs/run_…` returns one.

### Comparison reports: `/v1/projects/:project/reports/comparisons`

`POST { name, comparison, source? }` stores the counts of a comparison between two reported runs: its kind, the conditions that differed, and per criterion the class counts and both agreement rates. Per-case rows are not part of the request. Both runs must have been reported first (400 `unknown_run`). The same two runs against the same labels are one comparison (200 on repeat). `GET …/reports/comparisons?name=&head=&limit=` lists them newest first.

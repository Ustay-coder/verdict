#!/usr/bin/env bash
# Deploy the Verdict API to Cloudflare Workers + D1, register secrets, mint a first tenant key and run a live smoke test.
# Prereqs: CLOUDFLARE_API_TOKEN (Workers Scripts Edit, D1 Edit, Account Settings Read, User Details Read, Workers AI Read),
#          CLOUDFLARE_ACCOUNT_ID, TYPESAFE_API_KEY in the shell; `pnpm build` done; wrangler installed (npm i -g wrangler).
# Usage: scripts/deploy-cloudflare.sh            # deploy + secrets + smoke test
#        scripts/deploy-cloudflare.sh --no-smoke  # deploy + secrets only
set -euo pipefail
export NODE_USE_ENV_PROXY=1
cd "$(dirname "$0")/../packages/api"

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"; : "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"; : "${TYPESAFE_API_KEY:?set TYPESAFE_API_KEY}"
SUBDOMAIN=$(curl -sS "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain" -H "authorization: Bearer $CLOUDFLARE_API_TOKEN" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).result.subdomain))')
URL="https://verdict-api.$SUBDOMAIN.workers.dev"

echo "▶ migrations"; wrangler d1 migrations apply verdict --remote
echo "▶ deploy";     wrangler deploy
for i in $(seq 1 20); do curl -s -m 10 -o /dev/null -w "%{http_code}" "$URL/v1/health" | grep -q 200 && break; sleep 2; done
echo "▶ health: $(curl -s -m 10 "$URL/v1/health")"

echo "▶ secrets"
printf '%s' "$TYPESAFE_API_KEY" | wrangler secret put TYPESAFE_API_KEY
ADMIN="${VERDICT_ADMIN_KEY:-$(node -e 'console.log("va_"+require("crypto").randomBytes(24).toString("hex"))')}"
printf '%s' "$ADMIN" | wrangler secret put VERDICT_ADMIN_KEY
[ -n "${VERDICT_WEBHOOK_SECRET:-}" ] && printf '%s' "$VERDICT_WEBHOOK_SECRET" | wrangler secret put VERDICT_WEBHOOK_SECRET
umask 077; printf 'VERDICT_API_URL=%s\nVERDICT_ADMIN_KEY=%s\n' "$URL" "$ADMIN" > ../../.verdict-deploy.env
echo "▶ admin key written to .verdict-deploy.env (git-ignored) — keep it safe"

[ "${1:-}" = "--no-smoke" ] && { echo "✔ deployed: $URL"; exit 0; }
sleep 3
echo "▶ first tenant key"
KEY=$(curl -sS "$URL/v1/admin/keys" -H "authorization: Bearer $ADMIN" -H "content-type: application/json" -d '{"tenantId":"default","name":"first"}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);if(!r.key){console.error(s);process.exit(1)}console.log(r.key)})')
printf 'VERDICT_API_KEY=%s\n' "$KEY" >> ../../.verdict-deploy.env
echo "▶ live smoke (Jev + Clef-flash via the AI binding)"
curl -sS "$URL/v1/evaluations" -H "authorization: Bearer $KEY" -H "content-type: application/json" -H "Idempotency-Key: deploy-smoke-$(date +%s)" \
  -d '{"name":"smoke","rubric":{"name":"triage","scale":{"type":"numeric","min":0,"max":3},"judges":{"jev":{"type":"decision","provider":"typesafe"},"clef":{"type":"decision","provider":"cloudflare","model":"@cf/cloudflare/clef-flash"}},"defaultJudge":{"type":"ref","ref":"jev"},"criteria":[{"id":"urgency","name":"Urgency","levels":[{"value":0,"label":"none","description":"nothing broken"},{"value":1,"label":"low","description":"minor issue with workaround"},{"value":2,"label":"high","description":"core feature degraded"},{"value":3,"label":"critical","description":"outage or data loss"}]},{"id":"urgency_clef","name":"Urgency (Clef)","judge":{"type":"ref","ref":"clef"},"levels":[{"value":0,"label":"none","description":"nothing broken"},{"value":1,"label":"low","description":"minor issue with workaround"},{"value":2,"label":"high","description":"core feature degraded"},{"value":3,"label":"critical","description":"outage or data loss"}]},{"id":"team","name":"Team","choices":{"support":"General help","engineering":"Bugs and outages","billing":"Invoices"}}]},"inputs":[{"type":"text","text":"Our dashboard has been down for 3 hours, we are losing orders and will cancel if this is not fixed today"}]}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const e=JSON.parse(s);if(!e.id){console.error(s);process.exit(1)}console.log("id",e.id,"status",e.status,"score",e.aggregate.score,"calls",e.usage.decisionCalls);for(const c of e.criteria)console.log("  ",c.criterionId,c.status,c.score??c.choice,c.ratings[0]?.raw?.model||"",c.ratings[0]?.error||"")})'
echo "✔ deployed: $URL   (keys in .verdict-deploy.env)"

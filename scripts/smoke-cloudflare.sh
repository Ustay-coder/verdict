#!/usr/bin/env bash
# Smoke-test a deployed Verdict API: mint a tenant key with the admin key, run one live Jev + Clef-flash evaluation,
# replay it through the idempotency key, and print the per-criterion results.
# Reads VERDICT_API_URL / VERDICT_ADMIN_KEY from .verdict-deploy.env (written by scripts/deploy-cloudflare.sh) or the env.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .verdict-deploy.env ] && set -a && . ./.verdict-deploy.env && set +a
: "${VERDICT_API_URL:?set VERDICT_API_URL}"; : "${VERDICT_ADMIN_KEY:?set VERDICT_ADMIN_KEY}"
URL=${VERDICT_API_URL%/}

echo "▶ health: $(curl -sS -m 15 "$URL/v1/health")"
if [ -z "${VERDICT_API_KEY:-}" ]; then
  echo "▶ minting tenant key"
  VERDICT_API_KEY=$(curl -sS "$URL/v1/admin/keys" -H "authorization: Bearer $VERDICT_ADMIN_KEY" -H "content-type: application/json" -d '{"tenantId":"default","name":"first"}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);if(!r.key){console.error(s);process.exit(1)}console.log(r.key)})')
  umask 077; printf 'VERDICT_API_KEY=%s\n' "$VERDICT_API_KEY" >> .verdict-deploy.env
  echo "  saved to .verdict-deploy.env"
fi
BODY='{"name":"smoke","rubric":{"name":"triage","scale":{"type":"numeric","min":0,"max":3},"judges":{"jev":{"type":"decision","provider":"typesafe"},"clef":{"type":"decision","provider":"cloudflare","model":"@cf/cloudflare/clef-flash"}},"defaultJudge":{"type":"ref","ref":"jev"},"criteria":[{"id":"urgency","name":"Urgency","levels":[{"value":0,"label":"none","description":"nothing broken"},{"value":1,"label":"low","description":"minor issue with workaround"},{"value":2,"label":"high","description":"core feature degraded"},{"value":3,"label":"critical","description":"outage or data loss"}]},{"id":"urgency_clef","name":"Urgency (Clef)","judge":{"type":"ref","ref":"clef"},"levels":[{"value":0,"label":"none","description":"nothing broken"},{"value":1,"label":"low","description":"minor issue with workaround"},{"value":2,"label":"high","description":"core feature degraded"},{"value":3,"label":"critical","description":"outage or data loss"}]},{"id":"team","name":"Team","choices":{"support":"General help","engineering":"Bugs and outages","billing":"Invoices"}}]},"inputs":[{"type":"text","text":"Our dashboard has been down for 3 hours, we are losing orders and will cancel if this is not fixed today"}]}'
KEY="smoke-$(date +%s)"
show='let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const e=JSON.parse(s);if(!e.id){console.error(s);process.exit(1)}console.log("  id",e.id,"status",e.status,"score",e.aggregate.score,"decision calls",e.usage.decisionCalls,"tokens",e.usage.inputTokens);for(const c of e.criteria)console.log("   ",c.criterionId.padEnd(13),c.status.padEnd(10),String(c.score??c.choice).padEnd(12),c.ratings[0]?.raw?.model||"",c.ratings[0]?.error||"")})'
echo "▶ live evaluation (Jev + Clef-flash)"
curl -sS -m 90 "$URL/v1/evaluations" -H "authorization: Bearer $VERDICT_API_KEY" -H "content-type: application/json" -H "Idempotency-Key: $KEY" -d "$BODY" | node -e "$show"
echo "▶ replay with the same Idempotency-Key"
curl -sS -m 30 -o /dev/null -w "  HTTP %{http_code}  Idempotency-Replayed=%header{Idempotency-Replayed}\n" "$URL/v1/evaluations" -H "authorization: Bearer $VERDICT_API_KEY" -H "content-type: application/json" -H "Idempotency-Key: $KEY" -d "$BODY"
echo "✔ ok"

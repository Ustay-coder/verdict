# peek.py <video> [criteria...]: probabilities of the latest batch's ratings
import json, os, sys
v = sys.argv[1]; want = set(sys.argv[2:]); d = os.path.join(v, ".verdict", "evaluations")
evs = [json.load(open(os.path.join(d, f))) for f in os.listdir(d)]
b = max(evs, key=lambda e: e["createdAt"])["batchId"]
for e in sorted([e for e in evs if e.get("batchId") == b], key=lambda e: e["subject"]["name"]):
    for c in e["criteria"]:
        if not want or c["criterionId"] in want:
            r = (c.get("ratings") or [{}])[0]
            print(e["subject"]["name"], c["criterionId"], r.get("probabilities") or r.get("rationale"))

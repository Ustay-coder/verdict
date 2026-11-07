import json, sys
e = json.load(sys.stdin); a = e["aggregate"]
crit = " ".join(f"{c['criterionId']}={round((c.get('normalized') or 0) * 100)}" for c in e["criteria"])
print(f"== {sys.argv[1]}: {a['score']} {a.get('grade')} | {crit}")

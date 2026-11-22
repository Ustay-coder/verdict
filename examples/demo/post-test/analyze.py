#!/usr/bin/env python3
"""Topic test for the five demo videos (organic posts, two rounds). Standard library only.

  python3 analyze.py detectable --impressions 800 --base 0.05   smallest lift one round can show
  python3 analyze.py results results/posts.csv                   per-topic rates, chance of being best, decision

results/posts.csv has one row per post (arm, round, ...). The primary metric is fixed in PRIMARY before the first post.
"""
import csv, math, random, sys
from collections import defaultdict

# Primary (attention): views watched to the end per impression = video_views x completion_rate / impressions.
# If the account can't see completion rate (Media Studio), set PRIMARY = "views" BEFORE the first post.
PRIMARY = "completed"
SECONDARY = {  # reported, not used to pick
    "views per impression": (("video_views",), 1),
    "intent per 1k": (("follows", "profile_visits", "bookmarks"), 1000),
    "conversation per 1k": (("replies", "quotes"), 1000),
    "reposts per 1k": (("reposts",), 1000),
}
WIN_CHANCE = 0.90
DRAWS = 40000
ARMS = 5

def z(p):  # inverse normal CDF (Acklam)
    a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924]
    b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857]
    c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878]
    d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742]
    if p < 0.02425:
        q = math.sqrt(-2 * math.log(p)); return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
    if p > 1 - 0.02425: return -z(1 - p)
    q = p - 0.5; r = q * q
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1)

def needed(base, lift, alpha=0.05, power=0.8):
    """Impressions per arm for the best arm to beat each of the others (Bonferroni over ARMS-1 comparisons)."""
    p1, p2 = base, base * (1 + lift)
    return (z(1 - alpha / (ARMS - 1) / 2) + z(power)) ** 2 * (p1 * (1 - p1) + p2 * (1 - p2)) / (p2 - p1) ** 2

def detectable(n, base):
    lift = 0.01
    while needed(base, lift) > n and lift < 20: lift += 0.01
    return lift

def wilson(x, n, conf=0.95):
    if n <= 0: return (0.0, 0.0)
    k = z(1 - (1 - conf) / 2); p = x / n
    mid = (p + k * k / (2 * n)) / (1 + k * k / n)
    half = k * math.sqrt(p * (1 - p) / n + k * k / (4 * n * n)) / (1 + k * k / n)
    return (max(0.0, mid - half), min(1.0, mid + half))

def p_best(pairs, seed=7):
    rnd = random.Random(seed); wins = [0] * len(pairs)
    for _ in range(DRAWS):
        s = [rnd.betavariate(1 + x, 1 + max(n - x, 0)) for x, n in pairs]
        wins[s.index(max(s))] += 1
    return [w / DRAWS for w in wins]

def num(r, k):
    try: return float(r.get(k) or 0)
    except ValueError: return 0.0

def primary_count(r):
    if PRIMARY == "completed":
        rate = num(r, "completion_rate"); rate = rate / 100 if rate > 1 else rate
        return num(r, "video_views") * rate
    return num(r, "video_views")

def results(path):
    rows = [r for r in csv.DictReader(open(path)) if num(r, "impressions") > 0]
    rounds = sorted({r["round"] for r in rows})
    arms = sorted({r["arm"] for r in rows})
    topic = {r["arm"]: r["topic"] for r in rows}
    label = "completed views / impression" if PRIMARY == "completed" else "video views / impression"
    print(f"Primary: {label}\n")
    firsts = {}
    for rd in rounds:
        rr = [r for r in rows if r["round"] == rd]
        rates = sorted(((primary_count(r) / num(r, "impressions"), r["arm"]) for r in rr), reverse=True)
        firsts[rd] = rates[0][1] if rates else None
        print(f"Round {rd}: " + "  ".join(f"{a} {v:.2%}" for v, a in rates) + f"   (impressions: " + ", ".join(f"{r['arm']} {int(num(r, 'impressions'))}" for r in rr) + ")")
    tot = defaultdict(lambda: [0.0, 0.0])
    for r in rows:
        tot[r["arm"]][0] += primary_count(r); tot[r["arm"]][1] += num(r, "impressions")
    pb = dict(zip(arms, p_best([tuple(map(round, tot[a])) for a in arms])))
    print(f"\nBoth rounds pooled:\n{'arm':<4} {'topic':<32} {'impr':>7} {'rate':>7} {'95% interval':>17} {'P(best)':>8}")
    for a in sorted(arms, key=lambda a: -pb[a]):
        x, n = tot[a]; lo, hi = wilson(x, n)
        print(f"{a:<4} {topic[a]:<32} {int(n):>7} {x / n:>7.2%} {lo:>8.2%}–{hi:<7.2%} {pb[a]:>8.0%}")
    lead = max(arms, key=lambda a: pb[a])
    first_both = len(rounds) >= 2 and all(firsts[rd] == lead for rd in rounds)
    if pb[lead] >= WIN_CHANCE and first_both:
        verdict = f"winner: {lead} ({topic[lead]})"
    elif pb[lead] >= WIN_CHANCE:
        verdict = f"lead only: {lead} pooled {pb[lead]:.0%}, but first in rounds {[rd for rd in rounds if firsts[rd] == lead] or 'none'} of {rounds}"
    else:
        verdict = f"no winner: best is {lead} at {pb[lead]:.0%} (< {WIN_CHANCE:.0%})"
    print(f"\nDecision (P(best) >= {WIN_CHANCE:.0%} pooled AND first in every round): {verdict}")
    print("Pooled P(best) treats every impression as independent; posts on different days vary more than that, which is why the topic must also win each round.")
    print("\nSecondary (direction only), pooled:")
    for name, (cols, per) in SECONDARY.items():
        vals = {a: sum(num(r, c) for r in rows if r["arm"] == a for c in cols) / tot[a][1] * per for a in arms}
        fmt = (lambda v: f"{v:.1%}") if per == 1 else (lambda v: f"{v:.2f}")
        print(f"  {name:<22} " + "  ".join(f"{a}={fmt(vals[a])}" for a in arms))
    print("  reach (impressions)    " + "  ".join(f"{a}={int(tot[a][1])}" for a in arms))

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "detectable":
        args = dict(zip(sys.argv[2::2], sys.argv[3::2]))
        n, base = float(args.get("--impressions", 800)), float(args.get("--base", 0.05))
        l1, l2 = detectable(n, base), detectable(2 * n, base)
        print(f"base {base:.1%}: with {int(n)} impressions per post, one round shows a +{l1:.0%} relative lift"
              f" ({base:.1%} vs {base * (1 + l1):.1%}); two rounds pooled ({int(2 * n)} per topic): +{l2:.0%}")
    elif cmd == "results" and len(sys.argv) > 2:
        results(sys.argv[2])
    else:
        print(__doc__)

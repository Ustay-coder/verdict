#!/usr/bin/env python3
"""Topic test for the five demo videos: plan the sample size, then read the results.

  python3 analyze.py plan --base 0.10 --lift 0.25            impressions per arm to see a 25% relative lift
  python3 analyze.py results results/phase1.csv              rates, 95% intervals, chance each arm is best

Standard library only. The primary metric is fixed in PRIMARY below before launch (see README.md).
"""
import csv, math, random, sys

PRIMARY = ("video_50", "impressions")          # 50%-watched views per impression
SECONDARY = {                                   # reported, not used to pick the winner
    "intent per 1k": (("follows", "profile_visits", "bookmarks"), 1000),
    "conversation per 1k": (("replies", "quotes"), 1000),
    "reposts per 1k": (("reposts",), 1000),
}
ARMS = 5
WIN_CHANCE = 0.90                               # declare a winner only above this
DRAWS = 40000

def z(p):  # inverse normal CDF (Acklam), enough for planning
    a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924]
    b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857]
    c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878]
    d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742]
    if p < 0.02425:
        q = math.sqrt(-2 * math.log(p)); return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
    if p > 1 - 0.02425: return -z(1 - p)
    q = p - 0.5; r = q * q
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1)

def plan(base, lift, alpha=0.05, power=0.8):
    """Impressions per arm so the best arm beats each other arm (Bonferroni over ARMS-1 comparisons)."""
    p1, p2 = base, base * (1 + lift)
    za, zb = z(1 - alpha / (ARMS - 1) / 2), z(power)
    n = (za + zb) ** 2 * (p1 * (1 - p1) + p2 * (1 - p2)) / (p2 - p1) ** 2
    return math.ceil(n)

def wilson(x, n, conf=0.95):
    if n == 0: return (0.0, 0.0)
    k = z(1 - (1 - conf) / 2); p = x / n
    mid = (p + k * k / (2 * n)) / (1 + k * k / n)
    half = k * math.sqrt(p * (1 - p) / n + k * k / (4 * n * n)) / (1 + k * k / n)
    return (mid - half, mid + half)

def p_best(rows, num, den, seed=7):
    rnd = random.Random(seed); wins = [0] * len(rows)
    for _ in range(DRAWS):
        s = [rnd.betavariate(1 + r[num], 1 + max(r[den] - r[num], 0)) for r in rows]
        wins[s.index(max(s))] += 1
    return [w / DRAWS for w in wins]

def results(path):
    rows = []
    for r in csv.DictReader(open(path)):
        rows.append({k: (v if k in ("arm", "topic") else float(v or 0)) for k, v in r.items()})
    num, den = PRIMARY
    pb = p_best(rows, num, den)
    print(f"Primary: {num} / {den}")
    print(f"{'arm':<4} {'topic':<28} {'impr':>8} {'rate':>7} {'95% interval':>17} {'P(best)':>8} {'cost/50%':>9}")
    for r, b in sorted(zip(rows, pb), key=lambda t: -t[1]):
        lo, hi = wilson(r[num], r[den]); rate = r[num] / r[den] if r[den] else 0
        cost = f"{r['spend'] / r[num]:.3f}" if r.get("spend") and r[num] else "-"
        print(f"{r['arm']:<4} {r['topic']:<28} {int(r[den]):>8} {rate:>7.2%} {lo:>8.2%}–{hi:<7.2%} {b:>8.0%} {cost:>9}")
    best = max(range(len(rows)), key=lambda i: pb[i])
    verdict = f"winner: {rows[best]['arm']} ({rows[best]['topic']})" if pb[best] >= WIN_CHANCE else f"no winner (best is {pb[best]:.0%} < {WIN_CHANCE:.0%})"
    print(f"\nDecision rule P(best) >= {WIN_CHANCE:.0%}: {verdict}")
    print("\nSecondary (directional only):")
    for name, (cols, per) in SECONDARY.items():
        print(f"  {name:<20} " + "  ".join(f"{r['arm']}={sum(r.get(c, 0) for c in cols) / r['impressions'] * per:.2f}" if r["impressions"] else f"{r['arm']}=-" for r in rows))

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "plan":
        args = dict(zip(sys.argv[2::2], sys.argv[3::2]))
        base, lift = float(args.get("--base", 0.1)), float(args.get("--lift", 0.25))
        print(f"base {base:.1%}, lift +{lift:.0%} relative ({base:.1%} vs {base*(1+lift):.1%}), {ARMS} arms:"
              f" {plan(base, lift):,} impressions per arm, {plan(base, lift) * ARMS:,} in total")
    elif len(sys.argv) > 2 and sys.argv[1] == "results":
        results(sys.argv[2])
    else:
        print(__doc__)

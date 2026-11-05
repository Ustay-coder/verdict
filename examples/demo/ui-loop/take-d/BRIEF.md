# Acme Pulse — October 2026 dashboard brief

## Who opens it, and when

The founder of Acme Pulse, who also runs sales, opens it on the first working morning of the month (here:
early November, reviewing October) before the monthly revenue check-in with the two co-founders. They spend
two or three minutes on it. Afterwards they decide two things: whether the month goes into the check-in as
"on track" or "needs discussion", and which accounts they personally contact this week.

## Their three questions, in priority order

1. **Did revenue grow in October, and by how much?**
   Answered by `kpis.mrr_usd` (48,200) and `kpis.mrr_change_pct` (+4.1 % vs September), with
   `kpis.active_accounts` (1,284) and `kpis.active_accounts_change` (+37) as the supporting figure.
2. **Does any account need me this week?**
   Answered by `recent_events`: one cancellation (Bramble Studio, Nov 3, reason: budget) next to the
   routine events, plus `kpis.churn_rate_pct` (2.3 %).
3. **Is new business keeping up?**
   Answered by `weekly_signups` (8 weeks, Sep 8 – Oct 27; the latest week, 281, is the highest of the 8;
   the four October weeks total 1,035 vs 885 for the four September weeks) and `kpis.trial_to_paid_pct`
   (18.6 %). `plans` shows where revenue sits: Team carries the largest share of MRR.

## What counts as needs-attention

Only rules that can be checked against `data.json`:

- **Every event in `recent_events` whose text contains "Cancelled"** is flagged, with the account, date and
  the stated reason. In this data: Bramble Studio. This is the only rule that calls for an action: the
  founder contacts the account. The page states the cancellation; it does not suggest anything else.
- **A latest week in `weekly_signups` lower than the week before** is flagged. In this data it is not (281 vs 268),
  so nothing is flagged for signups.
- **A negative `mrr_change_pct` or `active_accounts_change`** is flagged. Both are positive this month, so not flagged.
- `churn_rate_pct` and `trial_to_paid_pct` have no previous period or target in the data. They are shown as
  plain figures, with the page saying there is no comparison; they are never coloured good or bad.

Flagging is done with one status colour (a red) and placement: the cancellation sits in the first screen, beside
the revenue answer. Everything else is grey/black. No invented targets, budgets or goals.

## What the page leaves out, and why

- **Donut / pie of MRR by plan** — replaced by a small table with aligned bars; angle comparisons are hard to read.
- **Per-plan share percentages repeated in several places, hover tooltips, total signups over 8 weeks** —
  each figure appears once; the 8-week total answers no question.
- **Event icons and category tags for routine events** (upgrade, trial, seats) — they are listed quietly in one
  line each, since none of them needs action.
- **Animated counters, "live" indicators, glows, background effects** — the data is a monthly snapshot, not live.
- **Any target or forecast for MRR, churn or conversion** — the data has none.
- **Per-plan history** — the data has no previous period per plan, so the plan table shows only October.

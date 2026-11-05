# Acme Pulse dashboard: design brief

## Who opens it, and when

**The Acme Pulse founder, at the monthly revenue check-in on the first working days of the new month** (this
time: early November, looking back at October 2026). They open it with a coffee, before the Monday leadership
meeting. Afterwards they decide two things: whether growth is on track enough to keep the current acquisition
spend, and which accounts the customer team should call this week (for example, a cancelled account to win back).

## Their three questions, in priority order

1. **Did revenue grow in October?** Answered by `kpis.mrr_usd` ($48,200) and `kpis.mrr_change_pct` (+4.1% vs
   September), with `kpis.active_accounts` (1,284) and `kpis.active_accounts_change` (+37) as the supporting line.
2. **Is anything going wrong that I need to act on?** Answered by `recent_events` (any cancellation, with its
   reason) and by `kpis.churn_rate_pct` (2.3%). data.json holds no previous churn rate, so the page states that
   the churn figure has no comparison rather than calling it good or bad.
3. **Is the pipeline still filling up?** Answered by `weekly_signups` (8 weeks, Sep 8 to Oct 27: is the latest
   week above the one before, and above the first week shown?) and `kpis.trial_to_paid_pct` (18.6%, also without a
   previous period in the data). The plan mix in `plans` (accounts and MRR per plan, and each plan's share of
   MRR) is the lookup that explains where revenue comes from.

## What counts as needs-attention

Only stated rules over fields that exist in data.json; no targets, budgets or goals are invented.

- **Every event in `recent_events` whose text contains "Cancelled"** is flagged, with account name, date and the
  reason given (currently one: Bramble Studio, Nov 3, budget). It is listed first, above routine events.
- **A fall in a headline measure:** `mrr_change_pct < 0` or `active_accounts_change < 0`. Neither applies this
  month, so both are shown in neutral ink.
- **A fall in the latest week of `weekly_signups`** compared with the week before it. Not the case this month
  (281 vs 268); earlier dips (Sep 15, Oct 6) are visible on the line but not flagged, because they have recovered.
- **Churn rate** is always shown in the attention block next to the cancellation, because it is the only loss
  measure in the data, but it is not coloured as a breach: there is no threshold or prior value to compare it with.

Flagging uses one signal colour (a red) plus a written label, so the page still reads in grayscale. Everything
else stays in neutral ink.

## What the page leaves out, and why

- **No donut or pie of plan mix.** The plan split is a short table with aligned bars for MRR share; one breakdown,
  not two (the old page showed the same plans three times: donut, account bars and ARPA tiles).
- **No ARPA tiles, no total-signups-over-8-weeks figure, no "% growth since Sep 8" badge.** They repeat or
  re-derive numbers already on the page and answer none of the three questions.
- **No targets, forecasts or "on track vs goal" meters.** data.json has no targets; the old churn and conversion
  meters implied a 0-100% goal that doesn't exist.
- **No hover tooltips, live dot, logo, animations or decoration.** The founder reads it once at a fixed moment;
  every value is printed directly.
- **Routine events (trial start, upgrade, added seats) are kept but quiet**, below the flagged cancellation.
- **The `note` field** (fictional sample data) appears once in small type in the footer, not as a badge.

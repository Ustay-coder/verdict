# Dashboard design principles → a Verdict improvement routine (v2)

**Why v2.** Take B scored 92 on `dashboard-design.yaml`, yet the result still reads as AI-made. Two causes:

- **The rubric judged surfaces.** It measured colour, effects and motion. Nothing in it asked whether the page
  answers anyone's question, picks the right chart, or avoids the *second-order* AI defaults.
- **The routine forbade structure.** "Fix only the weakest criterion, leave the rest as it is" allowed restyling
  and nothing else. The layout (sentence headline, four identical KPI cards, chart + donut, two lower panels) is
  the template.

A probe with principle-based criteria (below) confirms it. Take B's final page is a **"second-order AI default"
at 91%** (cream + terracotta accent, tracked all-caps eyebrows, one accented headline word). Its donut makes
chart fit "mixed", and Jev calls the content an "inventory" of numbers rather than answers. Probe score: **38**
(the old rubric gave it 92).

## Principles (from the research)

| # | Principle | Source | What it rules out on our page |
| --- | --- | --- | --- |
| P1 | **Question-first.** Design for the operator's questions and decisions (what changed, is it normal, what needs attention), not for a set of charts | Few (requirements first); Buteau, "users have questions, not chart requirements"; Carbon (presentation vs exploration dashboards) | The template layout that lists every field of `data.json` |
| P2 | **Context for every number.** Each measure sits next to its comparison: previous period, trend or target | Few, mistake #2 "inadequate context"; Few's bullet graph and sparkline specs | Bare KPI cards |
| P3 | **Surface what needs attention.** Highlight exceptions and make them impossible to miss; highlight *only* those | Few #10 "highlighting important data ineffectively"; Carbon (most important data gets the most prominent position); NN/g preattentive cues | A cancellation shown as one row among four |
| P4 | **Every element earns its place.** No excessive detail or repetition | Few #3, #6, #11; Tufte (erase non-data and redundant data ink) | $48,200 shown three times; plan mix shown twice (donut + bars) |
| P5 | **Encode with position and length.** Bars for categories, lines for time, tables for lookups; avoid angle and area | Cleveland & McGill ranking; NN/g dashboards; Few #5, #8 | The donut |
| P6 | **Data-ink, no chartjunk.** Direct labels over legends, light gridlines, no decoration | Tufte; Carbon chart anatomy | Legends + swatches + glow |
| P7 | **Colour is a signal.** The page works in grayscale; colour flags status or attention | Refactoring UI ("design in grayscale first"); Few #12; NN/g | An accent used on the headline word, the chart and every bar |
| P8 | **Hierarchy by importance.** The most important answer is largest and first; secondary information is de-emphasised | Refactoring UI ("emphasise by de-emphasising"); Carbon | Four equal cards competing |
| P9 | **At a glance, one screen.** The primary answers fit the first viewport | Few #1 "exceeding the boundaries of a single screen" | Answers spread over 1,470 px |
| P10 | **Numbers set for reading.** Tabular figures, right-aligned columns, consistent rounding | Few #3 (precision); Stripe-style tables | Mixed precision, proportional digits |
| P11 | **No defaults, first or second order.** Avoid purple gradients, glass and glows, *and* the "tasteful" fallbacks: cream + terracotta, near-black + one acid accent, tracked all-caps eyebrows, a single accented headline word, identical icon/KPI card rows | avoid-ai-design catalog; AI-slop tells write-ups; Anthropic frontend-design skill text | Both the original and Take B's result |

Caveats from the research: most of the AI-tells material is practitioner catalogues, not studies, and the
cream + terracotta look is contested (some systems use it on purpose). The problem is **convergence on a default**,
not a single colour. P11 therefore asks Clef whether the look follows from the content. It doesn't ban colours,
and its low-confidence answers go to a human (below).

## Rubric v2: one criterion per principle, three kinds of judges

| Principle | Criterion | Judge | Notes |
| --- | --- | --- | --- |
| P1 | `questions`: answers what changed / on track? / needs attention, in that order | Jev (page text + `data.json` + `BRIEF.md`) | scored against the agent's own brief |
| P2 | `context`: every headline figure has a comparison | Jev | no invented targets: only comparisons derivable from the data |
| P3 | `attention`: exceptions (the cancellation, churn) are surfaced first | Jev + Clef | |
| P4 | `redundancy`: each figure once | audit (`repeated_figures`: the same number token ≥ 3× in visible text) + Jev | |
| P5 | `chart_fit`: position/length encodings | audit (`chart_types`: detects donut/pie/gauge: SVG arcs, dasharray rings, conic gradients) + Clef | |
| P6 | `data_ink` | Clef | |
| P7 | `color_signal`: works in grayscale; accent only on status | Clef; audit `palette` | |
| P8 | `hierarchy`: one focal answer, de-emphasised secondary info | Clef | |
| P9 | `at_a_glance`: primary answers inside the 1280×800 viewport | Clef (viewport screenshot) | |
| P10 | `numerals`: tabular figures in numeric columns | audit (`font-variant-numeric` share) | |
| P11 | `defaults`: free of first/second-order defaults | Clef + audit (`decoration`, `motion`, `eyebrows`: uppercase + tracked labels) | `minConfidence` → human (the founder) |
| — | `numbers_true` | Jev | gate, unchanged |

**Aggregation.** P1–P3 (purpose) and P5–P9 (encoding and layout) earn the points. P4, P10, P11 and the measured
checks multiply them down, as in v1. **Gates:** `numbers_true`, and a *floor* of 3/5 on every principle. A page
can't reach "ship it" by excelling at nine principles while failing one.

## Improvement routine v2

1. **Brief (once).** The agent writes `BRIEF.md` before touching the page: who opens this dashboard and when, their
   three questions in priority order, what counts as "needs attention" in this data, and what the page will not
   show. Verdict scores the brief with a small Jev rubric (specific? answerable from `data.json`? prioritised? no
   invented targets?). The gate is ≥ 80 before any UI work.
2. **Restructure (one pass).** Rebuild `index.html` from the brief. Discarding the existing layout is allowed and
   expected. P11's defaults list is part of the prompt.
3. **Principle loop.** Evaluate → fix the weakest principle, structural changes allowed → re-evaluate. Each
   iteration names the principle it targets and why. Stop when the score is ≥ 85 **and** every principle is ≥ 3/5.
4. **Taste check (human in the loop).** `defaults` and `hierarchy` escalate to the founder when Clef is unsure
   (`onLowConfidence: human`). The founder can also rate the final page against two alternatives. That feeds
   `verdict calibrate`, so the rubric learns the team's taste. This is a Verdict feature worth showing on camera.

## Validation so far (probe, live 2026-11-05)

[`calibration/probe-v2.yaml`](calibration/probe-v2.yaml) has five of the criteria above (P11, P5, P7 via Clef; P1, P4 via Jev).

| Page | v1 rubric | Probe | Most likely level per criterion |
| --- | --- | --- | --- |
| AI one-shot (`start/`) | 27 | **32** | defaults: first-order 84% · chart_fit: position 47% · color: decorative 65% · questions: partial · redundancy: some |
| Take B final (`take-b/evaluated/step5.html`) | 92 | **38** | defaults: **second-order 91%** · chart_fit: mixed 56% · color: partial · questions: **inventory** · redundancy: some |
| Hand-made reference (`calibration/good/`) | 92 | **63** | defaults: mostly own · chart_fit: position 95% · color: signal · questions: partial · redundancy: some |

The probe separates "restyled" from "designed", and it shows that even the hand-made reference misses P1–P3: it
never says what needs attention.

## Next steps

1. Add the audit metrics `chart_types`, `eyebrows`, `repeated_figures`, `numerals`. Write `dashboard-principles.yaml` (v2).
2. Calibrate v2 against: the one-shot, Take B's final, the hand-made reference, a bare page, and a new reference
   that follows P1–P11 (it must reach ≥ 85, or the rubric is asking for the impossible).
3. Record **Take C** with the four-phase routine from the same start page.
4. Video angle worth considering: *"Our first rubric gave it 92. You said it still looked AI-made. You were right."*
   Show the v1 → v2 rubric change on camera, then Take C.

## Sources

- Stephen Few, *Information Dashboard Design* (2nd ed., 2013). Thirteen mistakes as listed in
  [twobenches](https://twobenches.wordpress.com/2010/09/14/13-common-mistakes-in-dashboard-design/) and the
  [UXmatters review](https://www.uxmatters.com/mt/archives/2007/04/book-review-information-dashboard-design.php).
  Bullet graph spec: [Telerik mirror of Few's spec](https://www.telerik.com/docs/default-source/blogs-docs/bullet_graph_design_spec-pdf),
  [BetterEvaluation](https://www.betterevaluation.org/methods-approaches/methods/bullet-graph)
- NN/g, [Dashboards: Making Charts and Graphs Easier to Understand](https://www.nngroup.com/articles/dashboards-preattentive/)
- Cleveland & McGill graphical perception: [Cornell INFO 3312 notes](https://info3312.infosci.cornell.edu/ae/graphical-perception.html),
  [Auckland lecture](https://www.stat.auckland.ac.nz/~ihaka/787/lectures-perception.pdf), [FlowingData](https://flowingdata.com/2010/03/20/graphical-perception-learn-the-fundamentals-first)
- Tufte, data-ink and chartjunk: [IEEE Spectrum](https://spectrum.ieee.org/tufteisms), [Georgia Tech notes](https://faculty.cc.gatech.edu/~stasko/4460/Notes/tufte.pdf)
- IBM Carbon, [dashboards (v10)](https://v10.carbondesignsystem.com/data-visualization/dashboards)
- Refactoring UI principles (secondary summaries): [DEV review](https://dev.to/updivision/book-review-refactoring-ui-by-adam-wathan-steve-schoger-2f7m)
- Questions before charts: [Antoine Buteau, "Users have questions, not chart requirements"](https://www.antoinebuteau.com/the-end-of-the-dashboard-series-4-users-have-questions-not-chart-requirements/)
- AI design tells: [avoid-ai-design](https://github.com/funboy322/avoid-ai-design) (first- and second-order defaults),
  [prg.sh, "Why your AI keeps building the same purple gradient website"](https://prg.sh/ramblings/Why-Your-AI-Keeps-Building-the-Same-Purple-Gradient-Website),
  [smoothui, "AI design slop"](https://smoothui.dev/blog/ai-design-slop), [925 Studios, AI slop tells](https://www.925studios.co/blog/ai-slop-design-tells),
  [frontend-design skill text (mcpservers.org copy)](https://mcpservers.org/agent-skills/anthropic/frontend-design)
- SaaS dashboard practice (practitioner): [Lazarev](https://www.lazarev.agency/articles/saas-dashboard-design),
  [saasui.design patterns](https://www.saasui.design/blog/saas-analytics-reporting-dashboard-ux-patterns),
  [adminlte, dashboard examples 2026](https://adminlte.io/blog/25-best-dashboard-design-examples-for-2026-real-products-principles/)

Not reachable from this session's network (read via search summaries only): perceptualedge.com, nngroup.com,
impeccable.style, thefountaininstitute.com, carbondesignsystem.com.

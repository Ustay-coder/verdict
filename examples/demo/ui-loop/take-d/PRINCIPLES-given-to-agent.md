# Dashboard design principles

Distilled from Stephen Few (*Information Dashboard Design*), Tufte, Cleveland & McGill, NN/g, IBM Carbon and
Refactoring UI, plus practitioner catalogues of AI-generated design defaults. `dashboard-principles.yaml` (v2.1) scores them.

| # | Principle |
| --- | --- |
| P1 | **Question-first.** Design for the operator's questions and decisions (what changed, is it normal, what needs attention), not for a set of charts. |
| P2 | **Context for every number.** Each measure sits next to its comparison: previous period, trend or share. If the data has none, say so. Never invent targets. |
| P3 | **Surface what needs attention.** Put exceptions where they can't be missed; highlight only those. |
| P4 | **Every element earns its place.** No repeated figures, no duplicate breakdowns, no excessive precision. |
| P5 | **Encode with position and length.** Bars for categories, lines for time, tables for lookups; avoid angle and area (pie, donut, gauge). |
| P6 | **Data-ink, no chartjunk.** Direct labels over legends, light or no gridlines, nothing on a chart that doesn't encode data. |
| P7 | **Colour is a signal.** The page works in grayscale; colour flags status or what needs attention. |
| P8 | **Hierarchy by importance.** The most important answer is largest and first; de-emphasise the rest. |
| P9 | **At a glance.** The primary answers fit the first 1280×800 screen. |
| P10 | **Numbers set for reading.** Tabular figures, right-aligned numeric columns, consistent rounding. |
| P11 | **No defaults, first or second order.** No purple/blue gradients, glass, glows or gradient text. Also none of the "tasteful" fallbacks: cream or off-white with one terracotta/orange accent, near-black with one acid accent, tracked all-caps eyebrows, a single accented headline word, rows of identical KPI cards with icon tiles, decorative donuts, pill badges, a thick accent bar down one edge of a block, numbered section headings ("1.", "01"), a big sentence-style hero headline, Inter as the typeface. The look must follow from the content. |
| P12 | **Write for the user, not the reviewer.** Every sentence is about the business: what happened and what it means. Never describe the page itself (what is flagged where, why something is shown, how it is laid out). |
| P13 | **Advice only from stated rules.** Recommend an action only when a rule in the brief calls for it. |

## Fonts installed on the machine that renders the page

No external requests are allowed, so only these faces exist: Liberation Sans, Liberation Serif, Liberation Mono,
DejaVu Sans, DejaVu Serif, DejaVu Sans Mono, Carlito, Caladea, Bitstream Charter, FreeSans, FreeSerif, FreeMono,
Courier 10 Pitch, JetBrains Mono, IPAGothic, Inter, Inter Display. Any family that isn't listed falls back to Inter.

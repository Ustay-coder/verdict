# Video 3: "Bring your design system. Verdict holds the agent to it."

**Status: Take E recorded, and a plain two-pane working video rendered (real time, 3× and 5×).**

The founder's verdict on Takes B–D was that the redesigns didn't look better, only different. Taste is hard to score.
A design system isn't: it names every colour, size, step and component. Here an agent imports
[GitHub's Primer](https://github.com/primer/primitives) (MIT), turns it into a Verdict rubric, and rebuilds the AI
one-shot dashboard until the rubric passes.

| | |
| --- | --- |
| Start page | [`../ui-loop/start/`](../ui-loop/start) (the AI one-shot and its fictional data) |
| Importer | [`import-design-system.mjs`](import-design-system.mjs) |
| Rubric (generated) | [`design-system.yaml`](design-system.yaml), built from `@primer/primitives@11.10.0` and `@primer/css@21.5.1` |
| Tokens and specimen | [`design-system/`](design-system): `tokens.json`, and `specimen.png` rendered from Primer's own stylesheet |
| Scorer | [`../ui-loop/audit/server.mjs`](../ui-loop/audit/server.mjs) (`ds_*` metrics) |
| Take E | [`take-e/`](take-e): prompt, the page at each evaluation, `evaluations.json`, the final page |

## The importer: a design system → a rubric

`node import-design-system.mjs` reads the packages in `node_modules/@primer` and writes four things:

- **`design-system/tokens.json`:** everything the system defines (light theme), with `var()` chains resolved:
  - 751 colours (17 of them for data);
  - type sizes 12/13/14/16/20/32/40 px in weights 300/400/500/600;
  - 34 spacing steps;
  - radii 3/6/12 px plus full;
  - 8 shadows;
  - 32 component classes.
- **`design-system/primer.css`:** the official token variables plus the component CSS, for the page to link.
- **`design-system/specimen.png`:** the system's own components (Box, Subhead, UnderlineNav, Label, Button, flash,
  Progress), rendered from its stylesheet. This is the vision judge's reference.
- **`design-system.yaml`:** the rubric. Its context lists the key tokens.

Why `@primer/css` 21.5.1: version 22 dropped the component CSS (Box, Label, flash and the rest moved to Primer React).
21.5.1 is the last release that ships those classes, and it uses the same variables as primitives 11.

## The rubric

| Group | Criterion | Judge | What it checks |
| --- | --- | --- | --- |
| Look | `native` (×3) | Clef (screenshot + specimen) | Could this ship inside the product the specimen comes from? |
| Look | `surfaces` (×2) | Clef (screenshot + specimen) | White panels, thin grey borders, small radii, grey header strips, flat |
| Look | `craft` (×2) | Clef (screenshot) | Aligned grid, consistent rhythm, one focal point |
| Tokens | `ds_color` | scorer | Share of colour uses (text, fills, borders, SVG) that are token colours. Each off-token colour comes back with the nearest token |
| Tokens | `ds_type` | scorer | Sizes and weights on the scale (70%), and glyphs in the faces the system's stacks render (30%) |
| Tokens | `ds_space` | scorer | Padding (or padding + border), margins and gaps on the spacing scale |
| Tokens | `ds_shape` | scorer | Radii, border widths and shadows that are tokens |
| Tokens | `ds_components` | scorer | Share of boxes that are system components. A class that looks like the system's but that no stylesheet defines counts as broken |
| Tokens | `contrast` | scorer | Text passes WCAG AA |
| Data | `numbers_true` (gate) | scorer | Every figure derives from `data.json` |

The formula: `look × (0.4 + 0.6 × tokens)`. The look earns the points; off-token values take them away. There is also a
gate requiring `native` ≥ 3 of 5. "Ship it" is at **80**.

**Calibration** (live):

| Page | Score |
| --- | --- |
| AI one-shot | 19 |
| Bare HTML | 21 |
| Take D (principles rubric) | 47 |
| A dashboard hand-built from Primer components ([`calibration/primer-reference/`](calibration/primer-reference)) | 82, twice |
| Primer's own specimen | 84 |

The specimen tops out at 84 because the vision judges spread probability over neighbouring levels. On the specimen,
`native` gets 0.88 and the measured criteria about 0.99.

## Take E (2026-11-06)

Interactive Claude Code, unattended. Tools: Read, Edit, Write, the Verdict MCP server, and a shell restricted to the
two commands in the prompt ([`take-e/prompt.txt`](take-e/prompt.txt)). It ran for 3 min 13 s from submit to done.

| Round | Score | native | surfaces | colour | type | space | components | What happened |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | **19** rework | 2 | 3 | 0 | 53 | 40 | 0 | The AI one-shot: 0/224 colour uses are tokens; 10, 15 and 23 px spacing; 20 and 14 px radii; glows |
| 1 | **76** almost | 63 | 77 | 100 | 100 | 100 | 100 | Rebuilt with Primer's Box, UnderlineNav, Counter, Label and Progress, linking `primer.css` |
| 2 | **82** ship it | 75 | 83 | 100 | 100 | 100 | 100 | Layout refined (grids, signup rows, plan breakdown); every measured criterion already at 100 |

Verified:
- All 7 page states were rebuilt by replaying the agent's Write/Edit calls, and the last one matches its file byte for byte.
- `data.json` is unchanged, and every figure on the final page derives from it.
- The agent ran one extra read-only shell command (`ls -la design-system`). It says so in its own summary.

**Three runs before this one, and what each taught the rubric:**
1. The recorder split the allow rule `Bash(npm install:*)` at the space, so npm was denied and the run stopped at step 1.
   Fixed in `record.py`.
2. The rubric still said 85. The agent plateaued at 83 for three rounds with every measured criterion near 100%. That
   bar was above Primer's own specimen, so it was set to the calibrated 80.
3. The run passed at 81, but seven signup bars painted nothing. The agent had used `color-bg-neutral-emphasis`, which
   Primer CSS 21 doesn't define, and the judges didn't notice. `ds_components` now counts undefined system-looking
   classes as broken parts, and that page re-scores 77.

## Plain working video (no effects)

Built by [`../ui-loop/recording/plain2pane-html.mjs`](../ui-loop/recording/plain2pane-html.mjs) with
`--assets <work folder>`, so the page's linked `design-system/primer.css` loads.
- **Left:** Take E's recorded terminal bytes, played at their recorded times.
- **Right:** the real page, reloaded at the moment each Write/Edit landed, 1280 px wide at 0.875×.
- **Cuts:** real time (3:42), plus 3× and 5×, each labelled with its speed.
- **The first 2 min 40 s** show the install, the import and the baseline score while the right pane still shows the
  AI one-shot. That is what happened.

## Notes

- **Fictional data.** The company and its data are fictional (`data.json` says so), and the page shows that.
- **Fonts.** Primer's font stack renders Inter in this container (system-ui and -apple-system are aliased to it). On a Mac
  the same page renders in SF Pro; GitHub.com loads Mona Sans.
- **Not GitHub branding.** The page uses Primer, an open-source design system. It carries no GitHub logo or name, and
  the video can say "GitHub's open-source design system".

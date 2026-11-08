# What the post announces (facts the post may use)
- A 29-second screen recording: Claude Code, the landing page it edits, and the page's score with seven checks.
- The landing page is a real AI one-shot. Claude Code was asked: "Build a modern, beautiful SaaS landing page for
  Tideline, an uptime monitoring tool for small engineering teams. ... Make it pop." Tideline is fictional.
- The one-shot had three made-up testimonials, a "used by 2,400+ teams" logo strip of made-up companies, invented
  stats (12 regions, 99.987% uptime), glowing gradients, looping animations, ALL-CAPS section labels, a gradient
  headline word and slogan headings ("before your coffee cools"). Its own summary said the testimonials and stats were
  placeholders.
- Verdict scored it against a rubric built from research on landing pages and AI-slop tells, plus a facts.json of what
  is true about the product:
  - gate: no invented social proof (the FTC's rule bans fake testimonials); failing it scores 0;
  - six checks: every figure comes from facts.json, no glows or gradients, no looping motion, no template chrome,
    WCAG AA contrast, headings that describe instead of sell.
- The agent fixed one failing check per round and re-scored.
- Scores: 0 → 10 → 20 → 23 → 33 → 34 → 49 → 58 → 71 → 93. It passed ("ship it", 85+) on the 10th evaluation, after
  about 8 minutes, unattended. Two rounds barely moved because the fix was partial; measured checks count only at 100%.
- Verdict is an evaluation engine: rubrics scored by decision models, humans and deterministic checks.
- Audience: developers and designers on X who use coding agents.
- The post goes out with the 29-second video attached.

## Fictional
- Tideline, the product the page is for, is fictional. So are the page's testimonials, its logo-strip companies and
  its stats; the one-shot invented them.

## What didn't go smoothly
- Two rounds barely moved (20 → 23 and 33 → 34) because the fix was partial; measured checks count only at 100%.

# What the post announces (facts the post may use)
- A 31-second screen recording: Claude Code below (or left), and the live `verdict watch` leaderboard of five
  fictional hackathon entries.
- The entry the agent edits, Tidewatch (street-level flood warnings from a sensor on a storm drain), started with a hype
  write-up: "99% accuracy", "already protects 12 neighbourhoods", "AI-powered", no demo link, no code link.
- The rubric was built from hackathon rules and judging guides: misrepresenting the project scores 0; then six
  submission checks (says what it does and for whom, what was built at the event vs before, credits AI tools, links a
  demo, links the code, says what doesn't work yet), times the judges' quality score (impact, technical, originality).
- The agent could only edit Tidewatch's write-up, and only with facts from its facts file. It fixed one failing check
  per round and compared all five entries again.
- Tidewatch: 0 → 10 → 22 → 32 → 43 → 56 → 67 → 79 → 91, rank 5 → 5 → 3 → 3 → 2 → 2 → 1 → 1 → 1. It passed
  ("finalist", 80+) on the 9th comparison, after about 2 minutes, unattended.
- The four other entries were judged again every round and barely moved (Receipt Run 58–59, Common Room 40–41,
  Menu Match 21, Plant Pal 13–14).
- The fixes added facts that were true but missing (the demo link, the code link, the AI credit, the limits); the
  write-up claims nothing new.
- Verdict is an evaluation engine: rubrics scored by decision models, humans and deterministic checks.
- Audience: developers on X who enter hackathons or use coding agents.
- The post goes out with the 31-second video attached.

## Fictional
- The hackathon and all five entries, Tidewatch included, are fictional: made up for the demo, with made-up facts files.

## What didn't go smoothly
- The honesty gate passed at only 69–84% probability, so it is the criterion most likely to flip on a rerun.
- The last round's fix probably raised a second criterion too (technical 82 → 99), so not every round moved only the
  check it fixed.

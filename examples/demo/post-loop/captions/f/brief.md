# What the post announces (facts the post may use)
- A 34-second screen recording: Claude Code below (or left), and on the other side `verdict watch`, a live results
  page showing the post with the changed lines marked, the score history and every criterion.
- The post being reviewed is our own X launch post for an earlier demo video, in its first, typical AI-written form:
  a self-praising line with three exclamation marks, a claim that the agent "now fixes any landing page in minutes,
  guaranteed", Unicode "bold" letters, "cc @AnthropicAI @github" and five hashtags.
- The rubric comes from rules a post on X actually runs into: FTC law (a claim needs a basis; a demo built on a mock-up
  must say so, from FTC v. Colgate-Palmolive), X's help page (at most 2 hashtags) and spam policy (no unsolicited
  mentions), Hacker News guidelines (no uppercase or exclamation points for emphasis), accessibility guides (screen
  readers read Unicode bold letter by letter), and X's open-sourced ranker (a reply counts 27 times a like).
- One claim the brief doesn't support sinks the score to 0. Past that gate, each of 8 checks adds about a ninth.
  Three checks (hashtags, mentions, Unicode bold) are deterministic regex checks; the rest are judged by models.
- First review: 0. The agent fixed one check per review: removed the "fixes any landing page, guaranteed" claim (10),
  the self-praise (20), cut five hashtags to two (30), removed the mentions (40), plain letters instead of Unicode bold
  (51), said the product in the demo is fictional (61), said what Verdict is (70), said two rounds barely moved (80),
  ended on a question (88, "post it").
- 10 reviews, 0 → 88, about 80 seconds, unattended. The agent edited only the post.
- Verdict is an evaluation engine: rubrics scored by decision models, humans and deterministic checks; a gate lets one
  failing criterion sink the total.
- The final post: "An AI one-shot landing page scored 0. Eight minutes later it scored 93." It names Tideline as a
  fictional product, says Verdict is an evaluation engine that scores work against a rubric, says two rounds barely
  moved and ends on a question. It goes out with video B.
- Audience: developers on X who use coding agents.
- The post goes out with the 34-second video attached.

## Fictional
- Tideline, the product in the landing page the post is about, is fictional. The launch post itself is real: ours.

## What didn't go smoothly
- It passed at 88, just over the 85 bar. Clarity stayed the post's weakest score (44%) and fell as required sentences
  were added; "says what Verdict is" passed at only 77%.
- The final post still says "an AI one-shot landing page" twice; no check asked about repetition.

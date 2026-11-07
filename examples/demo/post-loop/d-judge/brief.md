# What the post announces (facts the post may use)
- A 36-second screen recording: Claude Code below (or left), the rubric file it edits, and a board of 96 squares,
  one per commit message: green when Verdict's verdict matched the human reviewers', red when not, grey when Verdict
  handed it to a human.
- The question: before you let an AI judge review commit messages, how often does it agree with people?
- The human labels come from a published study (Tian et al., "What Makes a Good Commit Message?", ICSE 2022): real
  commit messages from JUnit 4, OkHttp, Retrofit, Spring Boot and Dubbo, labelled good only if they say what changed
  and why. In the same study, experienced open-source developers matched those labels 85% of the time.
- 96 messages to tune on (48 good, 48 not), 96 more held out.
- The rubric started as the usual commit style rules (50-character subject, imperative mood, wrapped body):
  it matched the humans on 57%.
- The agent made one change per check, from the study's own labelling rules: judge what and why instead of style
  (64%), count an issue or PR link as the why (78%). Then seven more single changes, including letting the judge hand
  unsure messages to a human, didn't move it: 77, 78, 76, 78, 75, 75, 76%.
- It missed its own 80% target and stopped after its check limit. On the 96 held-out messages: 76% (66 of 87 it
  decided; it handed 9 to a human). About 2.5 minutes, unattended.
- The agent's explanation: some labels are lenient ("Update README.md" counted as having a why), and run-to-run noise
  is 1 to 2 points, so small edits can't be told apart from chance.
- Verdict is an evaluation engine: rubrics scored by decision models, humans and deterministic checks. The new
  check_against_humans tool runs a rubric over human-labelled examples and reports agreement.
- Audience: developers on X who use AI to review code, PRs or commits.

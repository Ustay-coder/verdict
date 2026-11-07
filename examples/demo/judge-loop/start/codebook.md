# How the reviewers labelled commit messages

The labels in `gold/` come from Tian et al., *What Makes a Good Commit Message?* (ICSE 2022). The authors sampled
1,649 commit messages from five active Java projects (JUnit 4, OkHttp, Retrofit, Spring Boot, Dubbo) and labelled
each one with two questions:

- **What:** does the message summarise what was changed?
- **Why:** does it give the reason for the change?

**A good commit message has both.** Each message got one of four labels: why and what, no why, no what, neither.
Two authors labelled independently (Cohen's kappa 0.91) and a third settled disagreements. In a survey,
experienced open-source contributors labelled 120 of the messages; 102 of their labels (85%) matched the authors'.

The rest of this file is the authors' own coding of how messages express each part, from their released data
(`maintenance type and expression way.xlsx`, 252 messages coded).

## Ways a message says WHY (any one is enough)

| Category | Subcategories in their coding |
| --- | --- |
| Describe the issue | describes the error scenario; describes a shortcoming; introduces the issue report |
| Describe the objective | what the change is for, the goal it serves |
| Illustrate the requirement | something is out of date; the runtime or development environment changed; a usage need |
| Imply necessity | follows a convention or standard; improvements and benefits; relation to an implemented feature; relation to prior commits |
| Issue link or PR link | a reference to the issue or pull request the change belongs to counts as the reason |

Messages often have **no why** for: code refactoring, text file changes, typo fixes, annotation changes, version
management and test cases.

## Ways a message says WHAT

| Category | Subcategories in their coding |
| --- | --- |
| Summarise the code change | the object of change; a change list; characteristics of the change; contrast before and after |
| Illustrate the function | what the changed code now does |
| Describe the implementation principle | how the change works |

A message that only describes the problem (the why) without the change made has **no what**.

Source: dataset and coding at github.com/WhatMakesAGoodCM/What-Makes-a-Good-Commit-Message.

# Offer test: which use case do people ask for?

**Status: drafts (2026-11-22). Nothing posted yet.**

The topic test ([`../post-test/`](../post-test)) couldn't compare topics: about 32 impressions per post. This test
asks a different question, one that a small audience can answer: **for which use case will someone send us their own
work?** One request is a stronger signal than a hundred views, and each request is also a real case for the next
video and a conversation about price.

| Use case | Who pays | Video |
| --- | --- | --- |
| **D** Does your AI judge agree with people? | Teams running LLM features or AI code review | [`../judge-loop/`](../judge-loop) |
| **E** Sponsored script review | Brands, agencies, creator networks | [`../sponsor-loop/v2/`](../sponsor-loop/v2) |
| **B** Landing page review | Indie developers, designers | [`../landing-ui-loop/`](../landing-ui-loop) |

**How to count:** for two weeks, log every request and every real conversation per use case, with where it came from
(sheet below). A use case with **3 or more real requests** is worth building toward.

Before posting, fill in the `[…]` placeholders. They mark decisions only the founder can make: how people reach you,
how many free reviews you take, and what you promise about their data.

---

## The three offers

Use these lines unchanged in every post, so the offer stays the same and only the place differs.

**D: AI judge agreement**
> Send me 50 or more examples your AI judge or reviewer has scored, each with a person's good/bad call. I'll run them
> through Verdict and tell you how often the judge agrees with people, where it disagrees, and which rule changes move
> the number. Free for the first 10 teams.

**E: Sponsored script review**
> Send me a sponsored video script or draft, with the brand's brief if you have one. I'll score it against FTC
> disclosure and endorsement guidance and the brief, and mark every line that would get it sent back. Free for the
> first 10 scripts. This is a review, not legal advice.

**B: Landing page review**
> Send me your landing page URL. I'll score it with the rubric from the video (invented social proof, figures you can't
> back, AI-template tells, contrast, headings that sell instead of describe) and send back the failing checks in
> order. Free for the first 10 pages.

**For every offer:** "Email it to [email address]. I'll only use what you send to score it, and won't post it anywhere
without asking." (Decided 2026-11-23: requests by email, 10 free reviews per use case, and the promise stays.)

---

## D: AI judge agreement

### Reddit: an LLM or ML community (e.g. r/LocalLLaMA; r/MachineLearning wants a `[P]` tag for projects)

Check each community's self-promotion rules first. Some allow it only in a weekly thread.

**Title:** We measured how often an LLM judge agrees with human labels on commit messages: 57%, then 76%, then a plateau

> Before letting an AI judge review commit messages, I wanted to know how often it agrees with people.
>
> **Data:** real commit messages from JUnit 4, OkHttp, Retrofit, Spring Boot and Dubbo, labelled in a published study
> (Tian et al., "What Makes a Good Commit Message?", ICSE 2022). A message counts as good only if it says what changed
> and why. In that study, experienced open-source developers matched the labels 85% of the time.
>
> **Setup:** 96 messages to tune on (48 good, 48 not) and 96 held out. The judge is a rubric scored by Verdict, an
> evaluation engine I'm building. Claude Code was allowed to change one rule at a time and measure again.
>
> **What happened:**
> - The usual style rules (50-character subject, imperative mood, wrapped body): 57%.
> - Judging what and why instead of style: 64%.
> - Counting an issue or PR link as the why: 78%.
> - Seven more single changes, including letting the judge hand unsure messages to a person: 77, 78, 76, 78, 75, 75, 76%.
>   It missed its own 80% target.
> - On the 96 held-out messages: 76% (66 of the 87 it decided; it handed 9 to a person).
>
> **Why it stalled, as far as I can tell:** some labels are lenient ("Update README.md" counted as having a why), and the
> run-to-run noise is 1 to 2 points, so small rule edits can't be told apart from chance.
>
> [Offer D]
>
> What agreement would you need before letting an AI judge gate anything?

### Hacker News

Show HN is for something people can try themselves, and a free review offer doesn't count. Two options:
- **Now:** write up the experiment above as a blog post and submit it as an ordinary story, titled
  "Our LLM judge agreed with human commit labels 76% of the time". Put the offer at the end of the post, not in the title.
- **Later:** a Show HN once people can run `check_against_humans` on their own data.

### X: reply to posts about LLM-as-judge or AI code review, with the video attached

> We tested exactly this on real commit messages with human labels from a published study: 57% agreement with the
> usual style rules, 76% after tuning, short of the 85% that developers in the study reached. Happy to run yours if you
> have labelled examples.

(253 characters.) Reply only where it answers the post; a pasted pitch under unrelated posts reads as spam.

---

## E: Sponsored script review

### A creator or influencer-marketing community (subreddit, Slack or Discord)

**Title:** I score sponsored video scripts against FTC disclosure rules before they go to the brand. Want yours checked?

> I've been building a reviewer that checks a sponsored script the way a brand's legal team would. In the demo, the
> creator and the app are fictional, but the rules are real:
> - Say it's paid upfront, in the video, in plain words, not as a thank-you at the end.
> - Talk only about your own experience; your result isn't a promise.
> - With a free trial, say what it costs afterwards.
> - No guaranteed-approval claims for credit or banking products.
> - Plus the brand's own brief: talking points, codes, no competitor names.
>
> The demo script promised viewers guaranteed credit approval, so it scored 0. Claude Code fixed one rule per review,
> and nine reviews later it was approved at 85, just over the bar. The script's voice stayed its weakest point.
>
> [Offer E]
>
> Which of these rules do you see broken most often?

### LinkedIn (brand and agency people are there)

> A sponsored script can be good and still get rejected for one line.
>
> We built a reviewer that scores scripts against FTC disclosure and endorsement guidance plus the brand's brief. In
> our demo (fictional creator, fictional app), one line promised viewers guaranteed credit approval. Score: 0. Fixing
> one rule per review took it to 85, approved.
>
> [Offer E]
>
> If you approve creator scripts for a brand: what do you check first?

### X: reply to posts about influencer disclosure or creator-brand deals, with the video attached

> We score sponsored scripts against the FTC's disclosure guidance before they go to the brand. Our demo script (made
> up) promised guaranteed credit approval: 0. One fix per review got it approved at 85. Happy to check a real one.

(228 characters.)

---

## B: Landing page review

### Reddit: r/webdev or r/SideProject (check self-promotion rules; r/webdev limits it)

**Title:** My AI-built landing page invented three customer testimonials. I scored it, then fixed one check at a time (0 → 93)

> I asked Claude Code for a SaaS landing page for Tideline, a fictional uptime tool. The one-shot looked fine, and it
> came with three testimonials from customers who don't exist, a "used by 2,400+ teams" logo strip of made-up
> companies, invented stats (99.987% uptime), glowing gradients, looping animations and ALL-CAPS labels.
>
> I scored it with Verdict, an evaluation engine I'm building, against a rubric from landing-page research and common
> AI-template tells:
> - **Gate:** no invented social proof; failing it scores 0.
> - **Checks:** every figure comes from a facts file, no glows or gradients, no looping motion, no template chrome, WCAG
>   AA contrast, headings that describe instead of sell.
>
> Claude Code fixed one failing check per round: 0, 10, 20, 23, 33, 34, 49, 58, 71, 93. That took about 8 minutes,
> unattended. Two rounds barely moved because the fix was only partial.
>
> [Offer B]
>
> Which of those do you spot first on a landing page?

### GeekNews (Show GN) or Disquiet, in Korean

**제목:** AI가 만든 랜딩 페이지에 가짜 고객 후기가 세 개 들어 있었습니다. 체크 하나씩 고쳐서 0점 → 93점

> Claude Code에게 가상의 업타임 모니터링 서비스 'Tideline'의 랜딩 페이지를 한 번에 만들어 달라고 했습니다.
> 결과물은 그럴듯했지만 존재하지 않는 고객의 후기 세 개, 가짜 회사 로고 띠("2,400개 이상의 팀이 사용"), 근거 없는
> 수치(가동률 99.987%), 빛나는 그라데이션과 반복 애니메이션이 들어 있었습니다.
>
> 제가 만들고 있는 평가 엔진 Verdict로 채점했습니다. 기준은 다음과 같습니다.
> - **게이트:** 지어낸 사회적 증거가 있으면 0점입니다.
> - **체크:** 모든 수치가 사실 파일에 있는지, 글로우·그라데이션·반복 애니메이션·템플릿 장식이 없는지, WCAG AA
>   명도 대비를 지키는지, 제목이 파는 말이 아니라 설명인지를 봅니다.
>
> Claude Code가 한 번에 체크 하나씩 고쳐서 0 → 10 → 20 → 23 → 33 → 34 → 49 → 58 → 71 → 93까지 왔습니다. 무인으로
> 약 8분 걸렸습니다. 두 번은 수정이 부분적이라 거의 오르지 않았습니다.
>
> 랜딩 페이지 URL을 보내 주시면 같은 기준으로 채점해서 안 맞는 체크를 순서대로 알려 드립니다. 선착순 10곳까지
> 무료입니다. [이메일 주소]로 보내 주세요. 보내 주신 자료는 채점에만 쓰고, 허락 없이 공개하지 않습니다.
>
> 여러분은 랜딩 페이지에서 무엇을 가장 먼저 보시나요?

### X: reply to posts about AI-generated sites or landing pages, with the video attached

> An AI one-shot landing page we tested shipped three testimonials from customers who don't exist (the product,
> Tideline, is fictional too). Scored 0, then fixed one check per round: 93 in 8 minutes. Happy to score yours.

(219 characters.)

---

## Request log

Copy to a sheet. One row per request or real conversation, not per like or view.

| Date | Use case | Where it came from | Who (role, not name) | What they sent | Asked about price? | Follow-up |
| --- | --- | --- | --- | --- | --- | --- |
| | D / E / B | e.g. r/LocalLLaMA, LinkedIn, X reply | | | | |

**After two weeks:** count requests per use case. Three or more real requests in one use case is the signal. If none
reaches three, the question becomes whether the offer or the place was wrong. Read the conversations for that, not the
counts.

## Fact check

Every number in these drafts is from the video briefs (`../post-loop/captions/{b,d,e}/brief.md`), and each draft says
which parts of its demo are fictional. Before posting, check each community's rules on self-promotion and links.

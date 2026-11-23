r/LLMDevs에 아래 글을 내 Reddit 계정으로 올려 줘. 이 작업 외에는 아무것도 하지 마.

## 할 일

1. r/LLMDevs의 사이드바 규칙을 읽어. 자기 홍보 제한, 최소 계정 나이·카르마, 필수 플레어(flair)를 확인해.
   - 내 계정이 조건에 안 맞거나, 이 글이 규칙에 어긋나 보이면 **올리지 말고 멈춘 뒤** 어떤 규칙 때문인지 알려 줘.
   - 플레어가 필수라면 가장 맞는 것을 골라. 애매하면 후보를 보여 주고 물어봐.
2. **텍스트 게시물**로 올려. 제목과 본문은 아래 그대로, 한 글자도 바꾸지 마. 본문은 마크다운 모드로 붙여 넣어.
3. 올린 시각은 **한국 시간 오늘 밤 11시(미 동부 오전 9시)**로 해. 그 전이면 그때까지 기다리고, 이미 지났다면 바로 올려도 되는지 먼저 물어봐.
4. 올린 뒤 게시물 링크와 실제 게시 시각을 알려 줘.

## 하지 말 것

- 다른 서브레딧에 올리거나 크로스포스트하지 마.
- 링크, 이메일 주소, 영상, 홍보 문구를 덧붙이지 마.
- 내 승인 없이 댓글이나 DM에 답하지 마.

## 제목

```
We measured how often an LLM judge agrees with human labels on commit messages: 57%, then 76%, then a plateau
```

## 본문

```markdown
Before letting an AI judge review commit messages, I wanted to know how often it agrees with people.

**Data:** real commit messages from JUnit 4, OkHttp, Retrofit, Spring Boot and Dubbo, labelled in a published study (Tian et al., "What Makes a Good Commit Message?", ICSE 2022). A message counts as good only if it says what changed and why. In that study, experienced open-source developers matched the labels 85% of the time.

**Setup:** 96 messages to tune on (48 good, 48 not) and 96 held out. The judge is a rubric scored by Verdict, an evaluation engine I'm building. Claude Code was allowed to change one rule at a time and measure again.

**What happened:**

- The usual style rules (50-character subject, imperative mood, wrapped body): 57%.
- Judging what and why instead of style: 64%.
- Counting an issue or PR link as the why: 78%.
- Seven more single changes, including letting the judge hand unsure messages to a person: 77, 78, 76, 78, 75, 75, 76%. It missed its own 80% target.
- On the 96 held-out messages: 76% (66 of the 87 it decided; it handed 9 to a person).

**Why it stalled, as far as I can tell:** some labels are lenient ("Update README.md" counted as having a why), and run-to-run noise is 1 to 2 points, so small rule edits can't be told apart from chance.

What agreement would you need before letting an AI judge gate anything?
```

## 올린 뒤: 댓글 확인

올린 뒤 처음 몇 시간 동안 1시간마다 댓글을 확인해. 새 댓글이 있으면 댓글마다 아래 기준으로 영어 답글 초안을 써서 보여 주고, **내가 승인한 것만** 올려.

- 판정 모델을 물으면: "A decision model called Jev (from TypeSafe). Each criterion goes out as a scored question, and the judge returns a probability per label, so unsure cases can go to a person."
- Verdict를 써볼 수 있냐고 물으면: 아직 공개 전이라는 점을 솔직하게 말해. 꾸며서 답하지 마.
- 자기 판정이나 데이터로 해볼 수 있냐고 물으면: 답하지 말고 바로 나에게 알려 줘. 무료 리뷰 제안으로 내가 직접 답할 거야.
- 루브릭 공개를 요청하면: 답하지 말고 나에게 알려 줘.
- 위 내용에 없는 사실은 지어내지 마. 모르면 나에게 물어봐.

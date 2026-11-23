X에서 내가 답글을 달 만한 최근 글을 찾아서 목록으로 정리해 줘. **이번에는 찾기만 해.** 답글, 좋아요, 리포스트, 팔로우, DM은 하나도 하지 마.

## 배경

나는 Verdict라는 평가 엔진을 만들고 있어. 루브릭을 기준으로 결과물을 채점하는 도구야. 아래 세 가지 데모가 있는데, 내 계정은 팔로워가 적어서 관련 대화에 의미 있는 답글을 달아 노출을 얻으려고 해. 답글이 그 대화에 실제로 도움이 되는 글만 찾아야 해.

- **D (AI 판정 검증):** 실제 커밋 메시지와 공개 연구의 사람 라벨로, AI 판정이 사람과 얼마나 일치하는지 측정했어. 57%에서 시작해 76%에서 정체됐고, 연구에 참여한 개발자들은 85%였어.
- **E (스폰서 대본):** FTC 공시·추천 가이드 기준으로 스폰서 영상 대본을 채점해. 데모에 나오는 크리에이터와 앱은 가상이야.
- **B (랜딩 페이지):** AI가 한 번에 만든 랜딩 페이지에 가짜 후기, 지어낸 수치, AI 템플릿 티가 들어 있었고, 이를 채점한 뒤 하나씩 고쳤어(0점 → 93점).

## 검색어

X 검색에서 각 검색어를 넣고 **"최신"** 탭을 봐. `since:`는 오늘로부터 3일 전 날짜로 바꿔.

D:
- `("LLM as a judge" OR "LLM-as-a-judge" OR "LLM judge") min_faves:20 -filter:replies lang:en since:YYYY-MM-DD`
- `("AI code review" OR "AI reviewer") (trust OR accuracy OR agree) min_faves:20 -filter:replies lang:en since:YYYY-MM-DD`
- `(evals OR "eval set") ("human labels" OR "human judgment" OR "agree with humans") min_faves:10 -filter:replies lang:en since:YYYY-MM-DD`

E:
- `("FTC" OR "disclosure") (sponsored OR influencer OR creator) min_faves:20 -filter:replies lang:en since:YYYY-MM-DD`
- `("sponsored video" OR "brand deal" OR "sponsor read") (script OR rejected OR approval) min_faves:10 -filter:replies lang:en since:YYYY-MM-DD`

B:
- `("landing page") ("AI generated" OR "vibe coded" OR v0 OR lovable OR "all look the same") min_faves:20 -filter:replies lang:en since:YYYY-MM-DD`
- `"fake testimonials" min_faves:10 -filter:replies lang:en since:YYYY-MM-DD`

결과가 너무 적으면 `min_faves` 숫자를 절반으로 낮춰서 다시 찾아 봐. 그래도 없으면 없다고 보고하면 돼. 맞지 않는 글로 목록을 채우지 마.

## 고르는 기준

포함할 글:
- 올라온 지 **48시간 이내**인 글
- 작성자 팔로워가 대략 **1천~50만**인 글
- 질문, 고민, 논쟁, 경험담처럼 우리 데이터나 데모가 **직접 답이 되는** 글

뺄 글:
- 광고, 채용 공고, 단순 링크 공유, 밈
- 답글이 이미 수백 개 넘게 달린 글
- 정치나 다툼으로 번진 글
- 경쟁 제품의 홍보 글
- 우리 데모와 주제만 겹치고 내용은 무관한 글

## 보고 형식

용도별로 **최대 5개, 전체 최대 15개**까지. 잘 맞는 순서로 정렬하고, 각 글을 아래 형식으로 보여 줘.

| 용도 | 글 링크 | 작성자 (팔로워 수) | 올라온 시각 (한국 시간) | 좋아요 / 답글 수 | 글 요약 (한 줄) | 왜 맞는지 (한 줄) | 적합도 (상·중·하) |
| --- | --- | --- | --- | --- | --- | --- | --- |

표 아래에 다음을 적어 줘:
- 검색어별로 찾은 글 수와 그중 골라낸 글 수
- 찾다가 눈에 띈, 자주 언급되는 계정이나 해시태그 (나중에 다시 찾을 때 쓸 것)

## 규칙

- 읽기만 해. 어떤 버튼도 누르지 마.
- 글 내용, 팔로워 수, 수치는 화면에 보이는 그대로 옮겨. 추측하거나 지어내지 마. 안 보이면 "확인 불가"라고 적어.
- 비공개 계정이나 로그인 문제로 못 본 글은 목록에 넣지 말고 따로 적어.

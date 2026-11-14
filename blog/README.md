# blog/ — Velog 시리즈 제작 작업공간

Verdict로 코드 품질을 개선해 가는 과정을 Velog 시리즈로 발행하기 위한 파일 기반 파이프라인입니다.
에이전트끼리는 대화가 아니라 **이 디렉터리의 파일**로 소통합니다. 어느 단계든 파일만 있으면 다시 실행할 수 있습니다.

## 원칙
1. **숫자는 `data/*.json`에서만 나옵니다.** writer는 계산하지 않습니다. `tools/check-facts.mjs`가 글 속 숫자를 대조합니다.
2. **익명화가 기본입니다.** 파일 경로, PR 번호, 커밋 해시, 앱·조직·제품 이름은 글에 나오지 않습니다. 규칙은 `redaction-rules.yaml`.
3. **사람 확인은 두 번.** ① 앵글·목차(`outline.md`), ② 발행 직전(`final.md`).
4. **실패도 기록합니다.** 점수가 내려간 작업, 측정 오차는 독립된 편으로 다룹니다.

## 파이프라인
```
collector ┐
          ├→ story-planner →(확인①)→ writer ┐
analyst   ┘                         visualizer ┤
                                                ├→ fact-checker ┐
                                                └→ redactor     ├→ packager →(확인②)→ 수동 발행
```
에이전트 정의는 `.claude/agents/blog-*.md`, 실행 진입점은 스킬 `blog-episode`.

## 디렉터리
| 경로 | 내용 |
|---|---|
| `series.yaml` | 시리즈명, 로드맵, 편별 상태 |
| `style-guide.md`, `glossary.md` | 문체와 용어 고정 |
| `redaction-rules.yaml` | 익명화 매핑과 금지어 (이 저장소는 비공개 전제) |
| `data/round-NN.json` | 측정 라운드별 원본 수치 (익명화된 라벨 사용) |
| `episodes/NN-slug/` | `facts.json` `changes.md` `outline.md` `draft.md` `review-facts.md` `review-redact.md` `final.md` `published.md` |
| `rubrics/post-quality.yaml` | 초안을 Verdict로 채점하는 루브릭 |
| `tools/check-facts.mjs` | 숫자 대조 스크립트 |

## 명령
```bash
node blog/tools/check-facts.mjs blog/episodes/00-intro/draft.md blog/data/round-01.json
```

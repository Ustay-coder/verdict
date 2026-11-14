---
name: blog-episode
description: Velog 시리즈 한 편을 측정 데이터에서 발행 직전 상태까지 만든다. "다음 편 써줘", "blog episode", 새 측정 라운드가 끝났을 때 사용.
---

# blog-episode — Velog 시리즈 한 편 제작

인자: `<episode-id>` (예: `01-baseline`). 없으면 `blog/series.yaml`에서 첫 `planned` 편을 고른다.
작업 전에 `blog/README.md`와 `blog/series.yaml`을 읽는다.

## 단계
각 단계는 해당 서브에이전트(`.claude/agents/blog-*.md`)에 위임하고, 결과 파일이 생겼는지 확인한 뒤 다음으로 간다.

1. **수집** — 같은 메시지에서 `blog-collector`와 `blog-change-analyst`를 병렬 실행.
   새 측정 라운드면 collector가 `blog/data/round-NN.json`을 만든다. 이미 있으면 `episodes/<id>/facts.json`만 만든다.
2. **기획** — `blog-story-planner` → `outline.md`.
   **여기서 멈추고 사용자에게 outline의 '사람이 확인할 질문'을 보여 준다(확인①).** 승인 전에는 진행하지 않는다.
3. **집필** — `blog-writer` → `draft.md`, 이어서 `blog-visualizer`가 viz 자리를 채운다.
4. **품질 게이트** — 병렬로 실행:
   - `blog-fact-checker` → `review-facts.md`
   - `blog-redactor` → `review-redact.md`
   - Verdict 채점: `node packages/cli/dist/bin.js eval -r blog/rubrics/post-quality.yaml -i post=blog/episodes/<id>/draft.md -i facts=blog/data/round-NN.json` (80 미만이면 revise)
   - FAIL(block)이 있으면 지적 사항을 `blog-writer`에게 넘겨 수정하고 4단계를 다시 한다. 최대 3회, 넘으면 사용자에게 보고.
5. **포장** — `blog-packager` → `final.md`, `publish.md`.
   **사용자에게 final.md를 보여 주고 발행 승인을 받는다(확인②).** 발행은 사용자가 Velog에서 직접 한다.
6. **기록** — 사용자가 발행했다고 알리면 `published.md`(날짜, URL)를 쓰고 `series.yaml`의 status를 `published`로 바꾼다.

## 규칙
- 이 스킬은 Velog에 직접 게시하지 않는다.
- 측정 도구, 루브릭, 스코어러는 수정하지 않는다(AGENTS.md). 이 스킬은 `blog/`와 `.claude/` 안에서만 쓴다.
- 숫자는 `blog/data/*.json`에서만 가져온다. 단계 사이에 수치를 새로 계산하지 않는다.
- 커밋은 사용자가 요청할 때만 한다.

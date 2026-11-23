# AGENTS.md — AI 작업자 공통 규칙

이 저장소는 저장소 주인(hojune0330)과 여러 AI 작업자(Claude Code, Codex, Genspark 등)가 함께 작업합니다.
AI 작업자는 작업을 시작하기 전에 이 파일을 먼저 읽고 따르세요.

## 브랜치
- 기본 브랜치에 직접 push하지 않습니다. 작업마다 새 브랜치를 만듭니다.
- 브랜치 이름: `<도구>/<작업-요약>` (예: `claude/fix-login`, `codex/add-search`, `genspark/landing-copy`)
- 작업 시작 전 `git fetch` 후 최신 기본 브랜치에서 분기합니다.
- `git push --force`, 브랜치 삭제, 히스토리 재작성(rebase 후 강제 push 등)은 하지 않습니다.

## 커밋
- 한 커밋에는 한 가지 변경만 담습니다.
- 메시지 형식: `<type>: <요약>` — type은 feat, fix, docs, refactor, test, chore 중 하나
- 커밋 본문에 어떤 AI 도구가 작업했는지 남깁니다 (예: `Co-Authored-By:` 줄).

## Pull Request
- 모든 변경은 PR로 올리고, 저장소 주인이 확인한 뒤 병합합니다. AI가 스스로 병합하지 않습니다.
- PR 템플릿(.github/pull_request_template.md)의 항목을 채웁니다: 무엇을, 왜, 어떻게 확인했는지.
- 다른 AI가 열어 둔 PR·브랜치와 같은 파일을 건드리게 되면, 먼저 그 PR을 확인하고 PR 설명에 적습니다.

## 하지 말 것
- 비밀값(API 키, 토큰, 비밀번호, .env)을 커밋하지 않습니다. `.env.example`만 커밋합니다.
- 요청 범위 밖의 대규모 리팩터링·포맷 변경·의존성 업그레이드를 하지 않습니다.
- 테스트를 지우거나 건너뛰게 만들어서 통과시키지 않습니다.
- 배포 설정, CI 워크플로, 이 AGENTS.md는 요청받았을 때만 수정합니다.

## 검증
- 이 저장소에는 아직 자동 검증 명령이 없습니다. 바꾼 파일을 직접 열어 보고, 결과를 PR의 "어떻게 확인했나요"에 적습니다.
- PR을 열면 GitHub Actions 결과(있는 경우)를 확인합니다.

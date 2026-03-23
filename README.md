# cmux-teams

cmux 기반으로 화면을 분할하여 여러 Claude 에이전트를 병렬 실행하는 Claude Code 스킬.

[omc-teams](https://github.com/Yeachan-Heo/oh-my-claudecode)(tmux 기반)와 동일한 수준의 오케스트레이션을 cmux GUI 환경에서 제공합니다.

## 설치

```bash
curl -sL https://raw.githubusercontent.com/cano721/cmux-teams-skill/main/install.sh | bash
```

## 전제조건

- [cmux](https://cmux.dev) 앱 실행 중
- Claude Code CLI (`claude`)
- Node.js 18+

## 사용법

```bash
# 워커 2개로 병렬 실행
/cmux-teams 2 "REST API 구현해줘"

# 에이전트 지정
/cmux-teams 2:codex "코드 리뷰해줘"
/cmux-teams 3:gemini "UI 컴포넌트 설계해줘"

# 상태 확인
/cmux-teams status

# 정리
/cmux-teams cleanup
```

## 기능

| 기능 | 설명 |
|------|------|
| 화면 분할 | cmux pane으로 워커별 독립 화면 |
| 다중 태스크 큐 | 워커 완료 시 다음 태스크 자동 할당 |
| Watchdog | 파일 기반 폴링으로 완료 감지 |
| Heartbeat | 워커 생존 확인 (60초 타임아웃) |
| V2 API | Unix Socket HTTP 서버 |
| MCP 서버 | 워커가 도구로 직접 API 호출 (선택) |
| 결과 수집 | worker-N-result.md 자동 수집 |
| 오케스트레이션 | 리더 세션에서 모니터링 + 결과 보고 |

## 에이전트

| 에이전트 | 실행 명령 |
|---------|----------|
| claude (기본) | `claude --dangerously-skip-permissions` |
| codex | `codex --full-auto` |
| gemini | `gemini` |

## 파일 구조

```
~/.claude/skills/cmux-teams/
├── SKILL.md              # 스킬 정의
├── cmux-teams-start.mjs  # CLI (pane 생성 + 에이전트 실행)
├── watchdog.mjs          # Watchdog (파일 기반 폴링 + V2 API)
└── mcp-server.cjs        # MCP 서버 (선택)
```

## License

MIT

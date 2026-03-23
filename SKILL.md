---
name: cmux-teams
description: cmux 기반으로 화면을 분할하여 여러 Claude 에이전트를 병렬 실행한다. 오케스트레이션 + 결과 수집.
user-invocable: true
allowed-tools: Bash, Read
---

# cmux-teams: cmux 화면 분할 병렬 에이전트 오케스트레이션

## 사용법
```
/cmux-teams N "task description"
/cmux-teams N:agent-type "task description"
/cmux-teams status
/cmux-teams cleanup
```

## 인자 파싱

`$ARGUMENTS`를 아래 규칙으로 파싱한다:

1. `cleanup` → cleanup 모드
2. `status` → status 모드
3. `N "task"` → workerCount=N, agentType=claude, task=나머지
4. `N:type "task"` → workerCount=N, agentType=type, task=나머지

---

## 실행 절차 (start 모드)

### 1. 태스크 분해
워커 수(N)에 맞게 task를 N개의 독립적 서브태스크로 분해한다.
사용자에게 분해 결과를 보여주고 확인받기:
```
## cmux-teams 실행 계획
- 워커 수: N / 에이전트: type

| # | 서브태스크 |
|---|-----------|
| 1 | ... |
| 2 | ... |

진행할까요?
```

### 2. OMC 상태 등록
CLI 실행 전에 OMC 상태를 등록한다 (다른 OMC 모드가 cmux-teams를 감지할 수 있도록):
```
state_write(mode="omc-teams", state={active: true, job_id: JOB_ID, worker_count: N})
```

### 3. CLI 실행 (1줄)
사용자 승인 후, `cmux-teams-start.mjs`를 실행한다.
**CLI가 자동으로 각 워커에 result.md 저장 + done.json 생성 지시를 포함한다.**

```bash
SKILL_DIR="$HOME/.claude/skills/cmux-teams"
node "$SKILL_DIR/cmux-teams-start.mjs" --count N --agent TYPE --tasks "서브태스크1" "서브태스크2"
```

### 3-1. Watchdog 시작 (별도 bash 명령)
CLI 실행 후 watchdog을 **bash nohup으로 직접 시작**한다 (CLI 내부 fork는 cmux 소켓 접근 문제로 사용하지 않음):
```bash
SKILL_DIR="$HOME/.claude/skills/cmux-teams"
STATE_DIR="$HOME/.omc/state/cmux-teams/$JOB_ID"  # CLI 출력의 state_dir 값 사용
nohup node "$SKILL_DIR/watchdog.mjs" "$STATE_DIR" > /dev/null 2>&1 &
WATCHDOG_PID=$!
echo "$WATCHDOG_PID" > "$STATE_DIR/watchdog.pid"
echo "watchdog started: PID=$WATCHDOG_PID"
```

### 3-2. 실행 중 보고
CLI 출력 JSON을 파싱하여 중간 보고:
```
## cmux-teams 워커 실행 중
- Job ID: cmux-XXXXX
- Watchdog PID: XXXXX

| # | Surface | 태스크 | 상태 |
|---|---------|--------|------|
| 1 | surface:XX | ... | running |
| 2 | surface:YY | ... | running |

워커 완료를 대기합니다...
```

### 4. 모니터링 루프 (오케스트레이션)
**이 세션에서 워커 완료를 주기적으로 확인한다. 모든 워커가 완료될 때까지 반복.**

```bash
LATEST_JOB=$(ls -t "$HOME/.omc/state/cmux-teams/" 2>/dev/null | head -1)
STATE_DIR="$HOME/.omc/state/cmux-teams/$LATEST_JOB"

# 각 워커 완료 상태 확인
TOTAL=0; DONE=0
for i in 1 2 3 4; do
  f="$STATE_DIR/workers/worker-${i}-done.json"
  wf="$STATE_DIR/workers/worker-${i}.json"
  [ -f "$wf" ] && TOTAL=$((TOTAL+1))
  [ -f "$f" ] && DONE=$((DONE+1))
done
echo "progress: $DONE/$TOTAL"

# config status 확인
python3 -c "import json; print(json.load(open('$STATE_DIR/config.json')).get('status','unknown'))" 2>/dev/null
```

**반복 규칙:**
- 완료되지 않은 워커가 있으면 **20초 대기 후 다시 확인**한다
- `sleep 20` 후 같은 상태 확인 명령을 다시 실행
- config status가 `completed` 또는 `failed`이면 루프 종료
- 모든 done.json이 존재하면 루프 종료
- **최대 60회 반복** (약 20분) 후에도 미완료면 타임아웃 보고
- 진행 상황이 변하면 (done 수 증가) 사용자에게 중간 보고

### 5. 결과 수집 및 보고
모든 워커 완료 후, 결과 파일을 읽어서 종합 보고한다:

```bash
STATE_DIR="$HOME/.omc/state/cmux-teams/$LATEST_JOB"
# 각 워커의 result.md 읽기
for i in 1 2 3 4; do
  f="$STATE_DIR/workers/worker-${i}-result.md"
  [ -f "$f" ] && echo "=== Worker $i ===" && cat "$f"
done
```

종합 보고 형식:
```
## cmux-teams 완료
- Job ID: cmux-XXXXX
- 소요 시간: X분
- 워커: N/N 완료

### Worker 1 결과
(result.md 내용)

### Worker 2 결과
(result.md 내용)
```

### 6. 정리 안내
결과 보고 후 **자동 정리하지 않는다.** 워커 pane을 열어두고 추가 작업을 시킬 수 있도록 한다.
```
워커 pane이 열려있습니다. 추가 작업이 필요하면 cmux 앱에서 직접 입력하세요.
정리하려면: `/cmux-teams cleanup`
```

---

## 실행 절차 (status 모드)

```bash
LATEST_JOB=$(ls -t "$HOME/.omc/state/cmux-teams/" 2>/dev/null | head -1)
STATE_DIR="$HOME/.omc/state/cmux-teams/$LATEST_JOB"
cat "$STATE_DIR/config.json"
for i in 1 2 3 4; do
  f="$STATE_DIR/workers/worker-${i}-done.json"
  [ -f "$f" ] && echo "worker-$i: $(cat $f)" || echo "worker-$i: running"
done
WATCHDOG_PID=$(cat "$STATE_DIR/watchdog.pid" 2>/dev/null)
kill -0 "$WATCHDOG_PID" 2>/dev/null && echo "watchdog: alive" || echo "watchdog: dead"
tail -5 "$STATE_DIR/watchdog.log" 2>/dev/null
```

---

## 실행 절차 (cleanup 모드)

```bash
LATEST_JOB=$(ls -t "$HOME/.omc/state/cmux-teams/" 2>/dev/null | head -1)
STATE_DIR="$HOME/.omc/state/cmux-teams/$LATEST_JOB"

WATCHDOG_PID=$(cat "$STATE_DIR/watchdog.pid" 2>/dev/null)
[ -n "$WATCHDOG_PID" ] && kill "$WATCHDOG_PID" 2>/dev/null

SURFACES=$(python3 -c "
import json
with open('$STATE_DIR/config.json') as f:
    cfg = json.load(f)
for w in cfg.get('workers', []):
    print(w['surface'])
" 2>/dev/null)

for SURFACE in $SURFACES; do
  cmux send --surface "$SURFACE" "/exit\n" 2>/dev/null
done
sleep 3
for SURFACE in $(echo "$SURFACES" | tac); do
  cmux close-surface --surface "$SURFACE" 2>/dev/null
done

rm -rf "$STATE_DIR"
```

$ARGUMENTS

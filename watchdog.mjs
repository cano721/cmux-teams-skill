#!/usr/bin/env node
/**
 * cmux-teams watchdog — Node.js runtime
 * 워커 상태 감시, 다중 태스크 큐, Dead Pane Recovery, V2 CLI API
 * Usage: node watchdog.mjs <STATE_DIR>
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, statSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { createServer } from 'http';

// === Config ===
const STATE_DIR = process.argv[2];
if (!STATE_DIR) { console.error('STATE_DIR required'); process.exit(1); }

const CONFIG_PATH = join(STATE_DIR, 'config.json');
const LOG_PATH = join(STATE_DIR, 'watchdog.log');
const POLL_INTERVAL = 1000;       // omc-teams 동일: 1초
const STALL_TIMEOUT = 60;         // omc-teams 동일: 60초
const HEARTBEAT_TIMEOUT = 60;     // omc-teams 동일: 60초
const MAX_NUDGE = 3;
const TREE_CACHE_TTL = 3000;
const MAX_CONSECUTIVE_FAILURES = 3; // 연속 실패 시 팀 전체 종료

// === cmux binary resolve ===
function resolveCmuxBin() {
  const candidates = [
    '/Applications/cmux.app/Contents/Resources/bin/cmux',
    join(process.env.HOME, '.local/bin/cmux'),
  ];
  try {
    const which = execSync('which cmux 2>/dev/null', { encoding: 'utf8' }).trim();
    if (which) candidates.unshift(which);
  } catch {}
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch {}
  }
  return null;
}

const CMUX_BIN = resolveCmuxBin();
if (!CMUX_BIN) { log('FATAL: cmux binary not found'); process.exit(1); }

// cmux socket 경로 보장 (fork 환경 대응)
if (!process.env.CMUX_SOCKET) {
  process.env.CMUX_SOCKET = join(process.env.HOME, 'Library/Application Support/cmux/cmux.sock');
}

// === Logging ===
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { writeFileSync(LOG_PATH, line, { flag: 'a' }); } catch {}
}

// === JSON helpers ===
function readJSON(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function writeJSON(path, data) {
  try { writeFileSync(path, JSON.stringify(data, null, 2)); } catch (e) { log(`WRITE_FAILED ${path}: ${e.message}`); }
}

// === cmux commands ===
function cmux(...args) {
  try {
    return execSync(`"${CMUX_BIN}" ${args.join(' ')} 2>&1`, { encoding: 'utf8', timeout: 10000 }).trim();
  } catch { return ''; }
}

function cmuxSend(surface, text) {
  const escaped = text.replace(/"/g, '\\"');
  try {
    execSync(`"${CMUX_BIN}" send --surface ${surface} "${escaped}\\n" 2>&1`, { encoding: 'utf8', timeout: 10000 });
  } catch {}
}

// === Surface ID 검증 (파일 기반 — cmux tree 미사용) ===
function isValidSurfaceId(id) {
  return /^surface:\d+$/.test(id);
}

// === Config management ===
function readConfig() { return readJSON(CONFIG_PATH); }
function writeConfig(cfg) { writeJSON(CONFIG_PATH, cfg); }

function getWorkers() {
  const cfg = readConfig();
  return cfg?.workers || [];
}

// === Task management ===
function getTaskFiles() {
  const dir = join(STATE_DIR, 'tasks');
  try {
    return readdirSync(dir).filter(f => f.startsWith('task-') && f.endsWith('.json')).sort();
  } catch { return []; }
}

function readTask(taskId) {
  return readJSON(join(STATE_DIR, 'tasks', `task-${taskId}.json`));
}

function writeTask(taskId, data) {
  writeJSON(join(STATE_DIR, 'tasks', `task-${taskId}.json`), data);
}

function getNextPendingTask() {
  for (const f of getTaskFiles()) {
    const task = readJSON(join(STATE_DIR, 'tasks', f));
    if (task?.status === 'pending' && !task.assigned_worker) {
      return task;
    }
  }
  return null;
}

function allTasksDone() {
  const files = getTaskFiles();
  if (files.length === 0) return false;
  return files.every(f => {
    const task = readJSON(join(STATE_DIR, 'tasks', f));
    return task?.status === 'completed';
  });
}

// === Worker management ===
function readWorker(workerId) {
  return readJSON(join(STATE_DIR, 'workers', `worker-${workerId}.json`));
}

function writeWorker(workerId, data) {
  writeJSON(join(STATE_DIR, 'workers', `worker-${workerId}.json`), data);
}

function isWorkerDone(workerId) {
  return existsSync(join(STATE_DIR, 'workers', `worker-${workerId}-done.json`));
}

function readWorkerDone(workerId) {
  return readJSON(join(STATE_DIR, 'workers', `worker-${workerId}-done.json`));
}

function clearWorkerDone(workerId) {
  const p = join(STATE_DIR, 'workers', `worker-${workerId}-done.json`);
  try { unlinkSync(p); } catch {}
}

// === Heartbeat ===
function checkHeartbeat(workerId) {
  const hbPath = join(STATE_DIR, 'workers', `worker-${workerId}-heartbeat.json`);
  try {
    const mtime = statSync(hbPath).mtimeMs;
    return (Date.now() - mtime) < HEARTBEAT_TIMEOUT * 1000;
  } catch { return false; }
}

function hasHeartbeatFile(workerId) {
  return existsSync(join(STATE_DIR, 'workers', `worker-${workerId}-heartbeat.json`));
}

// === Nudge ===
function getNudgeCount(workerId) {
  const p = join(STATE_DIR, 'workers', `worker-${workerId}-nudge`);
  try { return parseInt(readFileSync(p, 'utf8').trim()) || 0; } catch { return 0; }
}

function incrementNudge(workerId) {
  const p = join(STATE_DIR, 'workers', `worker-${workerId}-nudge`);
  writeFileSync(p, String(getNudgeCount(workerId) + 1));
}

function nudgeWorker(workerId, surface) {
  const count = getNudgeCount(workerId);
  if (count < MAX_NUDGE) {
    cmuxSend(surface, '작업이 아직 진행 중인가요? 완료되면 done.json을 생성해주세요.');
    incrementNudge(workerId);
    log(`NUDGE worker-${workerId} (${count + 1}/${MAX_NUDGE})`);
  } else {
    log(`NUDGE_LIMIT worker-${workerId}`);
  }
}

// === Elapsed seconds ===
function getElapsedSeconds(workerId) {
  const w = readWorker(workerId);
  if (!w?.started_at) return 0;
  return Math.floor((Date.now() - new Date(w.started_at).getTime()) / 1000);
}

// === Task assignment ===
function assignNextTask(workerId, surface) {
  const task = getNextPendingTask();
  if (!task) {
    log(`NO_MORE_TASKS for worker-${workerId}`);
    return false;
  }

  // 태스크 상태 업데이트
  task.status = 'in_progress';
  task.assigned_worker = workerId;
  task.started_at = new Date().toISOString();
  writeTask(task.id, task);

  // 워커 상태 업데이트
  const w = readWorker(workerId);
  if (w) {
    w.task_id = task.id;
    w.status = 'running';
    w.started_at = new Date().toISOString();
    writeWorker(workerId, w);
  }

  // 이전 done.json 삭제
  clearWorkerDone(workerId);

  // 태스크 전송
  const donePath = join(STATE_DIR, 'workers', `worker-${workerId}-done.json`);
  const safeDesc = task.description.replace(/'/g, "\\'").replace(/"/g, '\\"');
  cmuxSend(surface, `다음 태스크를 수행해줘: ${safeDesc}. 완료 후 반드시 실행: echo '{"status":"completed","task_id":${task.id}}' > ${donePath}`);

  log(`ASSIGNED task-${task.id} to worker-${workerId}`);
  return true;
}

// === Respawn (Dead Pane Recovery) ===
async function respawnWorker(workerId, oldSurface) {
  log(`RESPAWN worker-${workerId} (old: ${oldSurface})`);

  const result = cmux('new-split', 'right');
  const match = result.match(/surface:\d+/);
  const newSurface = match?.[0];

  if (!newSurface || !isValidSurfaceId(newSurface)) {
    log(`RESPAWN_FAILED worker-${workerId} — invalid surface: '${newSurface}'`);
    return;
  }

  cmux('rename-tab', '--surface', newSurface, `"worker-${workerId}"`);

  // config.json 업데이트
  const cfg = readConfig();
  if (cfg) {
    const worker = cfg.workers.find(w => w.id === workerId);
    if (worker) {
      worker.surface = newSurface;
      worker.respawned = true;
      writeConfig(cfg);
    }
  }

  // 현재 태스크 찾기
  const w = readWorker(workerId);
  let taskDesc = '';
  if (w?.task_id) {
    const task = readTask(w.task_id);
    taskDesc = task?.description || '';
  }

  // env 주입 → claude 실행 → trust → 태스크
  const envFile = join(STATE_DIR, 'workers', `worker-${workerId}-env.sh`);
  if (existsSync(envFile)) {
    cmuxSend(newSurface, `source ${envFile}`);
    await sleep(500);
  }

  cmuxSend(newSurface, 'claude --dangerously-skip-permissions');
  await sleep(3000);
  cmuxSend(newSurface, '');  // trust 승인
  await sleep(5000);

  clearWorkerDone(workerId);
  const donePath = join(STATE_DIR, 'workers', `worker-${workerId}-done.json`);
  const safeDesc = taskDesc.replace(/'/g, "\\'").replace(/"/g, '\\"');
  cmuxSend(newSurface, `${safeDesc}. 완료 후 반드시 실행: echo '{"status":"completed"}' > ${donePath}`);

  log(`RESPAWNED worker-${workerId} → ${newSurface}`);
}

// === Job State Convergence ===
function convergeJobState() {
  const cfg = readConfig();
  if (!cfg) return 'unknown';

  // Priority: watchdog-result > config.status > worker states
  const resultPath = join(STATE_DIR, 'watchdog-result.json');
  if (existsSync(resultPath)) {
    const result = readJSON(resultPath);
    if (result?.all_tasks_done) return 'completed';
  }

  if (cfg.status === 'completed') return 'completed';
  if (cfg.status === 'failed') return 'failed';

  return 'running';
}

// === V2 CLI API Server ===
function startApiServer() {
  const API_SOCKET = join(STATE_DIR, 'api.sock');
  try { unlinkSync(API_SOCKET); } catch {}

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const input = JSON.parse(body);
        const result = handleApiRequest(req.url, input);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });

  server.listen(API_SOCKET, () => {
    log(`API_SERVER listening on ${API_SOCKET}`);
  });

  server.on('error', (e) => {
    log(`API_SERVER_ERROR: ${e.message}`);
  });

  return server;
}

function handleApiRequest(url, input) {
  switch (url) {
    case '/claim-task': {
      const { worker_id } = input;
      const task = getNextPendingTask();
      if (!task) return { ok: false, reason: 'no_pending_tasks' };
      task.status = 'in_progress';
      task.assigned_worker = worker_id;
      task.started_at = new Date().toISOString();
      writeTask(task.id, task);
      return { ok: true, task };
    }

    case '/transition-task': {
      const { task_id, from, to, worker_id } = input;
      const task = readTask(task_id);
      if (!task) return { ok: false, reason: 'task_not_found' };
      if (from && task.status !== from) return { ok: false, reason: `expected ${from}, got ${task.status}` };
      task.status = to;
      if (to === 'completed') task.completed_at = new Date().toISOString();
      writeTask(task_id, task);
      log(`TASK_TRANSITION task-${task_id} ${from}→${to} by worker-${worker_id}`);
      return { ok: true, task };
    }

    case '/heartbeat': {
      const { worker_id } = input;
      const hbPath = join(STATE_DIR, 'workers', `worker-${worker_id}-heartbeat.json`);
      writeJSON(hbPath, { timestamp: new Date().toISOString(), worker_id });
      return { ok: true };
    }

    case '/status': {
      return {
        ok: true,
        state: convergeJobState(),
        tasks: getTaskFiles().map(f => readJSON(join(STATE_DIR, 'tasks', f))),
        workers: getWorkers()
      };
    }

    default:
      return { ok: false, reason: 'unknown_endpoint' };
  }
}

// === Utilities ===
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function updateConfigStatus(status) {
  const cfg = readConfig();
  if (cfg) { cfg.status = status; writeConfig(cfg); }
}

// === Main Loop ===
async function main() {
  log(`WATCHDOG_START state_dir=${STATE_DIR} runtime=node (file-based polling)`);

  // V2 API 서버 시작
  const apiServer = startApiServer();

  // PID 기록
  writeFileSync(join(STATE_DIR, 'watchdog.pid'), String(process.pid));

  // Main poll loop
  while (true) {
    // 모든 태스크 완료 확인
    if (allTasksDone()) {
      log('ALL_TASKS_DONE — shutting down watchdog');
      updateConfigStatus('completed');
      writeJSON(join(STATE_DIR, 'watchdog-result.json'), {
        watchdog: 'completed',
        all_tasks_done: true,
        converged_state: convergeJobState()
      });
      break;
    }

    // 각 워커 상태 확인
    for (const worker of getWorkers()) {
      const { id: wid, surface } = worker;

      // done.json 확인 → 태스크 완료 처리 + 다음 태스크 할당
      if (isWorkerDone(wid)) {
        const doneData = readWorkerDone(wid);
        const w = readWorker(wid);
        const taskId = doneData?.task_id || w?.task_id;

        if (taskId) {
          const task = readTask(taskId);
          if (task && task.status !== 'completed') {
            task.status = 'completed';
            task.completed_at = new Date().toISOString();
            writeTask(taskId, task);
            log(`TASK_COMPLETED task-${taskId} by worker-${wid}`);
          }
        }

        // 다음 태스크 할당
        if (assignNextTask(wid, surface)) {
          log(`WORKER_REASSIGNED worker-${wid}`);
        } else {
          log(`WORKER_IDLE worker-${wid}`);
        }
        continue;
      }

      // stall 감지 (nudge 한도 미도달 시에만)
      // Note: Dead Pane Recovery는 리더 세션(SKILL.md)에서 cmux tree로 직접 처리
      //       watchdog는 파일 기반 폴링만 수행 (cmux 소켓 접근 문제 회피)
      if (getNudgeCount(wid) < MAX_NUDGE) {
        if (hasHeartbeatFile(wid)) {
          if (!checkHeartbeat(wid)) {
            log(`HEARTBEAT_STALL worker-${wid}`);
            nudgeWorker(wid, surface);
          }
        } else {
          const elapsed = getElapsedSeconds(wid);
          if (elapsed > STALL_TIMEOUT) {
            nudgeWorker(wid, surface);
          }
        }
      }
    }

    await sleep(POLL_INTERVAL);
  }

  // Cleanup
  apiServer.close();
  log('WATCHDOG_EXIT');
  process.exit(0);
}

// Graceful shutdown
process.on('SIGTERM', () => { log('SIGTERM received'); process.exit(0); });
process.on('SIGINT', () => { log('SIGINT received'); process.exit(0); });

main().catch(e => {
  log(`FATAL: ${e.message}\n${e.stack}`);
  process.exit(1);
});

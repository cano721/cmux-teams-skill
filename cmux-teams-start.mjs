#!/usr/bin/env node
/**
 * cmux-teams-start — CLI 한 줄로 전체 자동 실행
 * Usage: node cmux-teams-start.mjs --count N [--agent claude|codex|gemini] --tasks 'task1' 'task2' ...
 *
 * omc-teams의 `omc team start`와 동일한 구조:
 * 1. cmux pane 생성
 * 2. 워커 claude 실행 + trust 승인
 * 3. 태스크 전송
 * 4. watchdog 시작 (같은 프로세스 or fork)
 * 5. 결과를 stdout JSON으로 출력
 */

import { execSync, spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// === Args parsing ===
function parseArgs() {
  const args = process.argv.slice(2);
  const result = { count: 2, agent: 'claude', tasks: [] };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--count' && args[i + 1]) { result.count = parseInt(args[i + 1]); i++; }
    else if (args[i] === '--agent' && args[i + 1]) { result.agent = args[i + 1]; i++; }
    else if (args[i] === '--tasks') { result.tasks = args.slice(i + 1); break; }
    else if (!args[i].startsWith('--')) { result.tasks.push(args[i]); }
  }

  if (result.count < 1 || result.count > 4) { console.error('count must be 1-4'); process.exit(1); }
  if (result.tasks.length === 0) { console.error('at least one task required'); process.exit(1); }
  return result;
}

// === cmux binary resolve ===
function resolveCmux() {
  const candidates = [
    '/Applications/cmux.app/Contents/Resources/bin/cmux',
    join(process.env.HOME, '.local/bin/cmux'),
  ];
  try {
    const w = execSync('which cmux 2>/dev/null', { encoding: 'utf8' }).trim();
    if (w) candidates.unshift(w);
  } catch {}
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

const CMUX = resolveCmux();
if (!CMUX) { console.error('cmux not found'); process.exit(1); }

function cmux(...args) {
  try {
    return execSync(`"${CMUX}" ${args.join(' ')} 2>&1`, { encoding: 'utf8', timeout: 10000 }).trim();
  } catch { return ''; }
}

function cmuxSend(surface, text) {
  const escaped = text.replace(/"/g, '\\"');
  try {
    execSync(`"${CMUX}" send --surface ${surface} "${escaped}\\n" 2>&1`, { encoding: 'utf8', timeout: 10000 });
  } catch {}
}

function sleep(ms) { execSync(`sleep ${ms / 1000}`); }

function isValidSurface(id) { return /^surface:\d+$/.test(id); }

// === Main ===
const config = parseArgs();
const JOB_ID = `cmux-${Math.floor(Date.now() / 1000)}`;
const STATE_DIR = join(process.env.HOME, '.omc/state/cmux-teams', JOB_ID);

// 1. Ping check
const ping = cmux('ping');
if (!ping.includes('PONG')) { console.error('cmux is not running'); process.exit(1); }

// 2. State directory
mkdirSync(join(STATE_DIR, 'tasks'), { recursive: true });
mkdirSync(join(STATE_DIR, 'workers'), { recursive: true });

// 3. Task files
for (let i = 0; i < config.tasks.length; i++) {
  writeFileSync(join(STATE_DIR, 'tasks', `task-${i + 1}.json`), JSON.stringify({
    id: i + 1,
    status: 'pending',
    description: config.tasks[i],
    assigned_worker: i < config.count ? i + 1 : null,
    started_at: null,
    completed_at: null
  }, null, 2));
}

// 4. Create panes (layout strategy)
const surfaces = [];
for (let i = 0; i < config.count; i++) {
  let result;
  if (i === 0) {
    result = cmux('new-split', 'right');
  } else if (i === 1) {
    result = cmux('new-split', 'down', '--surface', surfaces[0]);
  } else if (i === 2) {
    result = cmux('new-split', 'down', '--surface', surfaces[1]);
  } else {
    // 4th: split leader pane down for 2x2
    result = cmux('new-split', 'down');
  }

  const match = result.match(/surface:\d+/);
  const surface = match ? match[0] : null;

  if (!surface || !isValidSurface(surface)) {
    console.error(`Failed to create pane ${i + 1}: ${result}`);
    process.exit(1);
  }

  cmux('rename-tab', '--surface', surface, `"worker-${i + 1}"`);
  surfaces.push(surface);

  // Worker state
  writeFileSync(join(STATE_DIR, 'workers', `worker-${i + 1}.json`), JSON.stringify({
    id: i + 1,
    surface,
    agent_type: config.agent,
    status: 'running',
    task_id: i + 1,
    started_at: new Date().toISOString()
  }, null, 2));
}

// 5. Config file
const agentCommands = { claude: 'claude --dangerously-skip-permissions', codex: 'codex --full-auto', gemini: 'gemini' };
writeFileSync(join(STATE_DIR, 'config.json'), JSON.stringify({
  job_id: JOB_ID,
  created_at: new Date().toISOString(),
  worker_count: config.count,
  agent_type: config.agent,
  status: 'running',
  cwd: process.cwd(),
  workers: surfaces.map((s, i) => ({
    id: i + 1,
    surface: s,
    task: config.tasks[i] || config.tasks[0]
  }))
}, null, 2));

// 6. Launch agents: command → trust → wait → task
const agentCmd = agentCommands[config.agent] || agentCommands.claude;

// Step 1: 모든 pane에 agent 실행
for (const s of surfaces) { cmuxSend(s, agentCmd); }

// Step 2: trust 대기 + 승인
sleep(3000);
for (const s of surfaces) { cmuxSend(s, ''); }

// Step 3: agent 시작 대기
sleep(5000);

// Step 4: 태스크 전송 (result.md 저장 + done.json 생성 지시 포함)
for (let i = 0; i < config.count; i++) {
  const taskIdx = Math.min(i, config.tasks.length - 1);
  const taskDesc = config.tasks[taskIdx];
  const donePath = join(STATE_DIR, 'workers', `worker-${i + 1}-done.json`);
  const resultPath = join(STATE_DIR, 'workers', `worker-${i + 1}-result.md`);
  const prompt = `${taskDesc}. 작업 완료 후 반드시 2가지를 실행해줘: 1) 결과 요약을 파일로 저장: 결과를 ${resultPath} 에 마크다운으로 작성해줘. 2) 완료 신호 생성: echo '{"status":"completed","task_id":${taskIdx + 1}}' > ${donePath}`;
  cmuxSend(surfaces[i], prompt);
}

// 7. Watchdog는 CLI에서 시작하지 않음 — SKILL.md에서 nohup bash로 직접 시작

// 8. Output result
const result = {
  job_id: JOB_ID,
  state_dir: STATE_DIR,
  watchdog_pid: null, // SKILL.md에서 별도 시작
  workers: surfaces.map((s, i) => ({
    id: i + 1,
    surface: s,
    task: config.tasks[Math.min(i, config.tasks.length - 1)]
  }))
};

console.log(JSON.stringify(result, null, 2));
process.exit(0);

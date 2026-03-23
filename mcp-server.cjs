#!/usr/bin/env node
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { readFileSync, writeFileSync, existsSync, readdirSync } = require("fs");
const { join } = require("path");

function findLatestStateDir() {
  const base = join(process.env.HOME, ".omc/state/cmux-teams");
  try {
    const dirs = readdirSync(base).sort().reverse();
    for (const d of dirs) {
      const cp = join(base, d, "config.json");
      if (existsSync(cp)) {
        const cfg = JSON.parse(readFileSync(cp, "utf8"));
        if (cfg.status === "running") return join(base, d);
      }
    }
    if (dirs.length > 0) return join(base, dirs[0]);
  } catch {}
  return null;
}

function readJSON(p) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } }
function writeJSON(p, d) { try { writeFileSync(p, JSON.stringify(d, null, 2)); } catch {} }

const TOOLS = [
  { name: "cmux_teams_heartbeat", description: "워커 heartbeat 신호 전송 (30초마다 호출 권장)", inputSchema: { type: "object", properties: { worker_id: { type: "number", description: "워커 ID" } }, required: ["worker_id"] } },
  { name: "cmux_teams_claim_task", description: "다음 대기 중인 태스크를 직접 요청", inputSchema: { type: "object", properties: { worker_id: { type: "number", description: "워커 ID" } }, required: ["worker_id"] } },
  { name: "cmux_teams_transition_task", description: "태스크 상태 전환 (pending→in_progress→completed)", inputSchema: { type: "object", properties: { task_id: { type: "number" }, from: { type: "string", enum: ["pending", "in_progress"] }, to: { type: "string", enum: ["in_progress", "completed", "failed"] }, worker_id: { type: "number" } }, required: ["task_id", "to", "worker_id"] } },
  { name: "cmux_teams_status", description: "전체 job 상태 조회", inputSchema: { type: "object", properties: {}, required: [] } }
];

function handleTool(name, args) {
  const sd = findLatestStateDir();
  if (!sd) return { ok: false, error: "No active cmux-teams job" };

  switch (name) {
    case "cmux_teams_heartbeat": {
      writeJSON(join(sd, "workers", `worker-${args.worker_id}-heartbeat.json`), { timestamp: new Date().toISOString(), worker_id: args.worker_id });
      return { ok: true, message: `Heartbeat worker-${args.worker_id}` };
    }
    case "cmux_teams_claim_task": {
      const dir = join(sd, "tasks");
      for (const f of readdirSync(dir).filter(f => f.startsWith("task-")).sort()) {
        const t = readJSON(join(dir, f));
        if (t && t.status === "pending" && !t.assigned_worker) {
          t.status = "in_progress"; t.assigned_worker = args.worker_id; t.started_at = new Date().toISOString();
          writeJSON(join(dir, f), t);
          return { ok: true, task: t };
        }
      }
      return { ok: false, reason: "no_pending_tasks" };
    }
    case "cmux_teams_transition_task": {
      const tp = join(sd, "tasks", `task-${args.task_id}.json`);
      const t = readJSON(tp);
      if (!t) return { ok: false, reason: "task_not_found" };
      if (args.from && t.status !== args.from) return { ok: false, reason: `expected ${args.from}, got ${t.status}` };
      t.status = args.to;
      if (args.to === "completed") {
        t.completed_at = new Date().toISOString();
        writeJSON(join(sd, "workers", `worker-${args.worker_id}-done.json`), { status: "completed", task_id: args.task_id, completed_at: t.completed_at });
      }
      writeJSON(tp, t);
      return { ok: true, task: t };
    }
    case "cmux_teams_status": {
      const cfg = readJSON(join(sd, "config.json"));
      const tasks = [];
      try { for (const f of readdirSync(join(sd, "tasks")).filter(f => f.startsWith("task-")).sort()) tasks.push(readJSON(join(sd, "tasks", f))); } catch {}
      const done = tasks.filter(t => t && t.status === "completed").length;
      return { ok: true, job_id: cfg && cfg.job_id, status: cfg && cfg.status, progress: `${done}/${tasks.length}`, tasks, workers: (cfg && cfg.workers) || [] };
    }
    default: return { ok: false, error: `Unknown: ${name}` };
  }
}

async function main() {
  const server = new Server({ name: "cmux-teams", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const result = handleTool(req.params.name, req.params.arguments || {});
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(() => process.exit(1));

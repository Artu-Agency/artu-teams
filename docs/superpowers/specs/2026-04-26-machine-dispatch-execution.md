# Machine Dispatch Execution — Tasks Run on User Machines

## Business Vision

Artu Teams enables **distributed AI agent development**. Each organization has multiple agents (CEO, Frontend, Backend, etc.) that run AI tasks. The compute happens on **each team member's machine**, not on a central server.

### Core Model

```
Organization "Acme"
├── CEO agent       → Machine A (Tomas's Mac, his Claude credentials)
├── Frontend agent  → Machine B (Santi's Mac, his Claude credentials)
└── Backend agent   → Machine C (Another dev's machine, Codex credentials)
```

**Key principles:**
- **Server = orchestrator only.** Never executes adapter CLIs, never holds API keys.
- **Machines = compute.** Each user's machine runs agents using their own local credentials (`claude login`, `ANTHROPIC_API_KEY`, etc.).
- **Tasks are machine-agnostic.** Any authorized machine can pick up and execute a task. If a machine dies, the task is re-queued and another machine can take it.
- **Credentials are local.** The server never sees, stores, or transmits API keys. Each machine uses whatever auth is configured locally.

### User Experience

1. User installs CLI: `npx artu-teams connect --server <url> --token <token>`
2. CLI connects via WebSocket to the server
3. Server dispatches tasks to connected machines
4. CLI spawns adapter CLIs (claude, codex, gemini) locally
5. Results flow back via WebSocket to the server
6. If machine disconnects, tasks are re-queued automatically

---

## Problem

Currently, the heartbeat system executes adapter CLIs (e.g., `claude`) directly on the EC2 server. This fails because:
1. EC2 doesn't have adapter CLIs installed
2. EC2 doesn't have user credentials
3. EC2 has limited resources (896MB RAM)
4. Adapter errors can crash the server process

## Solution: Machine Dispatch

### Task Run State Machine

```
         ┌──────────────────────────────────────────┐
         │                                          │
queued → dispatched → running → completed           │
                  │         │                       │
                  │         └→ failed               │
                  │                                 │
                  └→ machine_lost ──→ queued ────────┘
                       (re-queue)
```

| State | Meaning |
|-------|---------|
| `queued` | Waiting for available machine |
| `dispatched` | Sent to machine via WS, awaiting ACK |
| `running` | Machine confirmed execution started |
| `completed` | Machine reported success |
| `failed` | Machine reported error or adapter failure |
| `machine_lost` | Machine disconnected during execution → auto re-queue |

### Rules

- **Dispatch timeout**: machine doesn't ACK within 10s → re-queue
- **Machine disconnect**: runs in `dispatched`/`running` → mark `machine_lost` → re-queue
- **Re-queue**: returns to `queued`, any authorized machine can take it
- **No machine available**: fail run with clear error "No machine connected"
- **Persistence**: every state transition is written to DB before any WS action

---

## Server Side: Dispatch Flow

### executeRun() — Modified

```
executeRun(run):
  1. getAvailableMachineForTask(companyId, adapterType)
  2. No machine → fail run: "No machine connected"
  3. Machine found → UPDATE run SET status='dispatched', machineId=X
  4. Send via WS: { type: "task_dispatch", ... }
  5. Start dispatch timeout timer (10s)
  6. Return (async — result comes back via WS)
```

### WS Messages: Server → Machine

```json
{
  "type": "task_dispatch",
  "runId": "uuid",
  "issueId": "PAD-5",
  "companyId": "uuid",
  "agentId": "uuid",
  "adapterType": "claude_local",
  "adapterConfig": {
    "model": "claude-opus-4-7",
    "dangerouslySkipPermissions": true,
    "maxTurnsPerRun": 1000
  },
  "prompt": "Full agent instructions + task context...",
  "timeoutSec": 300
}
```

`adapterConfig` does NOT include secrets/API keys. Only public config (model, flags, limits).

### WS Messages: Machine → Server

| Message | Trigger | Server Action |
|---------|---------|---------------|
| `task_ack { runId }` | Machine received task | Cancel dispatch timeout, mark `running` |
| `task_result { runId, exitCode, stdout, stderr }` | Task finished | Mark `completed` or `failed` |
| `task_progress { runId, log }` | Streaming output | INSERT into `heartbeat_run_events` |
| `task_busy { runId }` | Machine at capacity | Re-queue, try another machine |

### Machine Disconnect Handling

In `machine-ws.ts` close handler (after 30s grace period):

```
For each run in dispatched/running assigned to this machine:
  → UPDATE run SET status='queued', machineId=NULL
  → Publish live event "run re-queued"
  → startNextQueuedRunForAgent() to dispatch to another machine
```

---

## Resilience: Server Never Dies

### Principle: All WS operations are fire-and-forget, DB is source of truth

```
1. Write state to DB
2. Try to send via WS
3. If WS fails → DB state is already correct
```

### Protections

**A) WS errors never crash server**

All machine WS interactions wrapped in try/catch. A machine that fails or sends garbage can NEVER propagate an error to the main process.

**B) Recovery on boot**

When server starts, run recovery sweep:
```sql
SELECT * FROM heartbeat_runs WHERE status IN ('dispatched', 'running');
-- For each: check if assigned machine is online
--   No → re-queue
--   Yes → send verification ping
```

**C) Dispatch timeout as safety net**

Run in `dispatched` > 10s without `task_ack` → re-queue. Backed by periodic cron check every 60s:
```sql
SELECT * FROM heartbeat_runs
WHERE status = 'dispatched'
AND updated_at < NOW() - INTERVAL '30 seconds';
-- Re-queue all
```

**D) Partial results persist immediately**

Each `task_progress` → INSERT to `heartbeat_run_events`. If machine dies mid-execution, logs are already in DB.

**E) Total error isolation**

| Scenario | Response |
|----------|----------|
| Machine sends invalid message | Log + ignore |
| Machine sends unknown runId | Log + ignore |
| Machine sends result for completed run | Log + ignore |
| Machine WS crashes | Close handler cleans up, re-queue runs |

---

## Connect-CLI: Task Execution on Machine

### task_dispatch handler

```
Receive message → ACK → spawn adapter CLI → stream progress → report result
```

### Concurrency

CLI accepts all incoming tasks. Each runs in its own child process — zero shared state.

```
task_dispatch #1 → spawn claude (PID 1234)  ← opus model
task_dispatch #2 → spawn claude (PID 1235)  ← sonnet model
task_dispatch #3 → spawn codex  (PID 1236)
All run in parallel, each reports independently.
```

Active processes tracked in `Map<runId, ChildProcess>` for:
- Reporting active task count in heartbeat
- Killing processes on `task_cancel`
- Cleanup on disconnect

### Adapter Command Mapping

```typescript
const ADAPTER_COMMANDS: Record<string, string> = {
  claude_local: "claude",
  codex_local: "codex",
  gemini_local: "gemini",
  cursor: "cursor",
};
```

### Args Assembly (example: claude)

```typescript
const args = ["--print", "-"];
args.push("--output-format", "stream-json");
if (config.model) args.push("--model", config.model);
if (config.dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
if (config.maxTurnsPerRun) args.push("--max-turns", String(config.maxTurnsPerRun));
```

### Credentials

CLI does NOT receive API keys from server. Uses local environment:
- `claude login` already done by user
- `ANTHROPIC_API_KEY` if set locally
- Codex/Gemini/Cursor credentials configured locally

### Each Spawn is Context Independent

Every spawned process has its own:
- Context/conversation history
- Model configuration
- Working directory
- Environment variables

Zero shared state between spawns.

---

## Files to Modify

| File | Change |
|------|--------|
| `server/src/services/heartbeat.ts` | `executeRun()` → dispatch to machine via WS instead of local `adapter.execute()` |
| `server/src/realtime/machine-ws.ts` | Handlers for `task_ack`, `task_result`, `task_progress`, `task_busy`. Run recovery on disconnect. Dispatch timeout. |
| `server/src/services/machines.ts` | Boot recovery sweep (orphaned runs → re-queue) |
| `packages/connect-cli/src/index.ts` | `task_dispatch` handler → spawn adapter CLI, track processes, report result. `task_cancel` handler. |

## What Does NOT Change

- DB schema (runs already have status, logs go to `heartbeat_run_events`)
- UI (dashboard, inbox, issues — already consume run states)
- Machine connection flow (invite, redeem, WS connect)
- Agent creation flow

## Documentation Updates

- Update skill file (`artu-agent-teams`) with machine dispatch architecture
- Document the business model: distributed compute, local credentials, machine-agnostic tasks
- Update "Pendientes" section with resolved items

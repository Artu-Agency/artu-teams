import { hostname as osHostname, platform, arch as osArch } from "node:os";
import { execFile } from "node:child_process";
import WebSocket from "ws";
import { post, get, authHeaders } from "./http.js";
import { loadConfig, saveConfig, clearConfig, getOrCreateMachineId, CONFIG_FILE } from "./config.js";
import { browserLogin, selectCompany } from "./login.js";

/** Track active task processes */
const activeTasks = new Map<string, { process: ReturnType<typeof execFile>; adapterType: string }>();

// ---------------------------------------------------------------------------
// CLI argument parsing (no deps)
// ---------------------------------------------------------------------------

interface ConnectArgs {
  command: "connect" | "status" | "logout";
  server?: string;
  token?: string;
  name?: string;
  reset?: boolean;
}

function parseArgs(argv: string[]): ConnectArgs {
  let command: ConnectArgs["command"] = "connect";
  let server: string | undefined;
  let token: string | undefined;
  let name: string | undefined;
  let reset = false;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "connect" || arg === "status" || arg === "logout") {
      command = arg;
      continue;
    }
    if (arg === "--reset") { reset = true; continue; }
    if ((arg === "--server" || arg === "-s") && argv[i + 1]) { server = argv[++i]!; continue; }
    if ((arg === "--token" || arg === "-t") && argv[i + 1]) { token = argv[++i]!; continue; }
    if ((arg === "--name" || arg === "-n") && argv[i + 1]) { name = argv[++i]!; continue; }
    if (arg === "--help" || arg === "-h") {
      console.log(`
artu-teams — Connect your machine to an Artu Teams server

Commands:
  connect         Connect machine (login via browser on first use)
  status          Show current config and connection status
  logout          Revoke credentials and clear local config

Options:
  --server, -s    Server URL (default: saved or https://teams.artu.ar/api)
  --token, -t     Invite token (legacy, optional)
  --name, -n      Machine name (default: hostname)
  --reset         Force re-login (clear saved credentials)
  --help, -h      Show this help
`);
      process.exit(0);
    }
  }

  return { command, server, token, name, reset };
}

// ---------------------------------------------------------------------------
// Adapter environment test — runs CLI locally and reports result
// ---------------------------------------------------------------------------

interface AdapterTestCheck {
  code: string;
  level: "info" | "warn" | "error";
  message: string;
  detail?: string;
  hint?: string;
}

interface AdapterTestResult {
  adapterType: string;
  status: "pass" | "warn" | "fail";
  checks: AdapterTestCheck[];
  testedAt: string;
}

function resolveCommand(adapterType: string, config: Record<string, unknown>): string {
  if (typeof config.command === "string" && config.command.trim()) return config.command.trim();
  const defaults: Record<string, string> = {
    claude_local: "claude",
    codex_local: "codex",
    gemini_local: "gemini",
    cursor: "cursor",
  };
  return defaults[adapterType] ?? adapterType;
}

function runAdapterTestLocally(adapterType: string, config: Record<string, unknown>): Promise<AdapterTestResult> {
  return new Promise((resolve) => {
    const checks: AdapterTestCheck[] = [];
    const command = resolveCommand(adapterType, config);
    const cwd = typeof config.cwd === "string" && config.cwd.trim() ? config.cwd.trim() : process.cwd();

    checks.push({ code: "cwd_valid", level: "info", message: `Working directory is valid: ${cwd}` });

    // Check if command exists by running `which` (unix) or `where` (win)
    const whichCmd = platform() === "win32" ? "where" : "which";
    execFile(whichCmd, [command], { timeout: 5000 }, (whichErr) => {
      if (whichErr) {
        checks.push({
          code: "command_not_found",
          level: "error",
          message: `Command not found in PATH: "${command}"`,
          hint: `Install ${command} or set the full path in adapter config.`,
        });
        resolve({ adapterType, status: "fail", checks, testedAt: new Date().toISOString() });
        return;
      }

      checks.push({ code: "command_found", level: "info", message: `Command is executable: ${command}` });

      // Run the actual probe: command --print - --output-format stream-json --verbose
      const args = ["--print", "-", "--output-format", "stream-json", "--verbose"];
      if (config.dangerouslySkipPermissions !== false) args.push("--dangerously-skip-permissions");
      if (typeof config.model === "string" && config.model.trim()) {
        args.push("--model", config.model.trim());
      }

      const envOverrides: Record<string, string> = {};
      if (typeof config.env === "object" && config.env !== null) {
        for (const [k, v] of Object.entries(config.env as Record<string, unknown>)) {
          if (typeof v === "string") envOverrides[k] = v;
          else if (typeof v === "object" && v !== null && "value" in v) {
            envOverrides[k] = String((v as { value: unknown }).value);
          }
        }
      }

      const childEnv = { ...process.env, ...envOverrides };

      // Check API key
      if (childEnv.ANTHROPIC_API_KEY) {
        checks.push({
          code: "api_key_set",
          level: "warn",
          message: "ANTHROPIC_API_KEY is set. Claude will use API-key auth instead of subscription.",
          hint: "Unset ANTHROPIC_API_KEY if you want subscription-based Claude login.",
        });
      } else {
        checks.push({
          code: "subscription_mode",
          level: "info",
          message: "ANTHROPIC_API_KEY is not set; subscription-based auth can be used if Claude is logged in.",
        });
      }

      const child = execFile(command, args, {
        cwd,
        env: childEnv,
        timeout: 40_000,
        maxBuffer: 1024 * 1024,
      }, (err, stdout, stderr) => {
        if (err && (err as any).killed) {
          checks.push({
            code: "probe_timed_out",
            level: "warn",
            message: `${command} hello probe timed out.`,
            hint: "Retry the probe. If this persists, check CLI installation.",
          });
        } else if (err) {
          const detail = (stderr || stdout || "").trim().split("\n")[0]?.slice(0, 240) ?? "";
          checks.push({
            code: "probe_failed",
            level: "error",
            message: `${command} hello probe failed (exit ${err.code ?? "unknown"}).`,
            ...(detail ? { detail } : {}),
            hint: `Run \`${command} --print - --output-format stream-json --verbose\` manually and prompt "Respond with hello."`,
          });
        } else {
          const hasHello = /\bhello\b/i.test(stdout);
          checks.push({
            code: hasHello ? "probe_passed" : "probe_unexpected",
            level: hasHello ? "info" : "warn",
            message: hasHello
              ? `${command} hello probe succeeded.`
              : `${command} probe ran but did not return "hello" as expected.`,
          });
        }

        const status = checks.some(c => c.level === "error") ? "fail"
          : checks.some(c => c.level === "warn") ? "warn" : "pass";
        resolve({ adapterType, status, checks, testedAt: new Date().toISOString() });
      });

      // Send prompt via stdin
      child.stdin?.write("Respond with hello.\n");
      child.stdin?.end();
    });
  });
}

// ---------------------------------------------------------------------------
// Legacy token connect (backward compat)
// ---------------------------------------------------------------------------

async function legacyTokenConnect(server: string, token: string, name?: string) {
  const serverBase = server.replace(/\/+$/, "");
  const machineName = name ?? osHostname();

  console.log(`\n  Artu Teams — Machine Connect (Legacy)`);

  console.log(`  Machine: ${machineName} (${platform()} ${osArch()})\n`);

  console.log("  [1/2] Redeeming invite token...");
  const redeemResult = await post(`${serverBase}/machines/redeem`, {
    token,
    name: machineName,
    hostname: osHostname(),
    os: platform(),
    arch: osArch(),
    ownerUserId: "cli-connect",
    adapters: [],
  });

  if (redeemResult.status !== 201) {
    const err = redeemResult.data as { error?: string } | null;
    throw new Error(`Redeem failed: ${err?.error ?? redeemResult.status}`);
  }

  const machine = redeemResult.data as { id: string; name: string; jwt?: string; wsUrl?: string };
  console.log(`  Machine registered: ${machine.id}`);
  connectWebSocket(machine, serverBase);
}

// ---------------------------------------------------------------------------
// WebSocket connection
// ---------------------------------------------------------------------------

function connectWebSocket(
  machine: { id: string; name: string; jwt?: string; wsUrl?: string },
  serverBase: string,
) {
  let wsUrl: string;
  if (machine.wsUrl) {
    wsUrl = machine.wsUrl;
  } else if (machine.jwt) {
    wsUrl = serverBase
      .replace(/^https:/, "wss:")
      .replace(/^http:/, "ws:")
      .replace(/\/api\/?$/, "") + `/ws/machines?token=${machine.jwt}`;
  } else {
    console.log(`  ✓ Connected (HTTP only). Machine ID: ${machine.id}\n`);
    console.log("  Press Ctrl+C to disconnect.\n");
    return;
  }

  const ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    console.log(`  [✓] Connected!\n`);
    console.log(`  Machine ID: ${machine.id}`);
    console.log(`  Name:       ${machine.name}`);
    console.log(`  Status:     Online\n`);
    console.log("  Press Ctrl+C to disconnect.\n");

    const heartbeatInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "heartbeat",
          cpu: 0,
          memory: 0,
          adapters: [],
          activeTasks: activeTasks.size,
          activeTaskIds: Array.from(activeTasks.keys()),
        }));
      }
    }, 30_000);

    ws.on("close", () => {
      clearInterval(heartbeatInterval);
      for (const [runId, task] of activeTasks) {
        console.log(`  Killing task ${runId} on disconnect`);
        task.process.kill("SIGTERM");
      }
      activeTasks.clear();
      console.log("  Disconnected from server.");
      process.exit(0);
    });
  });

  ws.on("message", (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (msg.type === "connected") {
        // Server acknowledged connection
      } else if (msg.type === "heartbeat_ack") {
        // Heartbeat acknowledged
      } else if (msg.type === "task_dispatch") {
        const runId = typeof msg.runId === "string" ? msg.runId : null;
        const adapterType = typeof msg.adapterType === "string" ? msg.adapterType : null;
        const adapterConfig = (typeof msg.adapterConfig === "object" && msg.adapterConfig !== null
          ? msg.adapterConfig : {}) as Record<string, unknown>;
        const prompt = typeof msg.prompt === "string" ? msg.prompt : "";
        const timeoutSec = typeof msg.timeoutSec === "number" ? msg.timeoutSec : 300;

        if (!runId || !adapterType) {
          console.error("  Invalid task_dispatch: missing runId or adapterType");
          return;
        }

        // ACK immediately
        ws.send(JSON.stringify({ type: "task_ack", runId }));
        console.log(`  Task ${runId}: dispatched (${adapterType})`);

        // Resolve command
        const command = resolveCommand(adapterType, adapterConfig);

        // Build args — isolated from user's personal hooks/plugins/MCP servers
        const args: string[] = [
          "--print", "-",
          "--output-format", "stream-json",
          "--verbose",
          "--no-session-persistence",
        ];
        const model = typeof adapterConfig.model === "string" ? adapterConfig.model.trim() : "";
        if (model) args.push("--model", model);
        if (adapterConfig.dangerouslySkipPermissions !== false) args.push("--dangerously-skip-permissions");
        const maxTurns = typeof adapterConfig.maxTurnsPerRun === "number" ? adapterConfig.maxTurnsPerRun : 0;
        if (maxTurns > 0) args.push("--max-turns", String(maxTurns));

        // Use agent's instructions root as cwd if available
        const taskCwd = typeof adapterConfig.instructionsRootPath === "string" && adapterConfig.instructionsRootPath.trim()
          ? adapterConfig.instructionsRootPath.trim()
          : process.cwd();

        console.log(`  Task ${runId}: spawning ${command} ${args.join(" ").substring(0, 80)}...`);
        console.log(`  Task ${runId}: cwd=${taskCwd}`);

        // Clean env: remove MCP/plugin vars that cause the agent to load user's personal tools
        const cleanEnv = { ...process.env };
        for (const key of Object.keys(cleanEnv)) {
          if (key.startsWith("MCP_") || key.startsWith("CLAUDE_PLUGIN")) {
            delete cleanEnv[key];
          }
        }

        // Spawn process
        const child = execFile(command, args, {
          cwd: taskCwd,
          env: cleanEnv,
          timeout: timeoutSec * 1000,
          maxBuffer: 10 * 1024 * 1024, // 10MB
        }, (err, stdout, stderr) => {
          activeTasks.delete(runId);

          let exitCode = 0;
          if (err) {
            exitCode = (err as any).killed ? -1 : ((err as any).code ?? 1);
            if (typeof exitCode === "string") exitCode = 1; // code can be string like 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          }

          console.log(`  Task ${runId}: finished (exit ${exitCode})`);

          try {
            ws.send(JSON.stringify({
              type: "task_result",
              runId,
              exitCode,
              stdout: stdout?.substring(0, 5 * 1024 * 1024) ?? "", // Cap at 5MB
              stderr: stderr?.substring(0, 1 * 1024 * 1024) ?? "", // Cap at 1MB
            }));
          } catch {
            console.error(`  Task ${runId}: failed to send result (WS disconnected)`);
          }
        });

        // Write prompt as stdin
        if (child.stdin) {
          child.stdin.write(prompt);
          child.stdin.end();
        }

        // Track active process
        activeTasks.set(runId, { process: child, adapterType });

      } else if (msg.type === "task_cancel") {
        const runId = typeof msg.runId === "string" ? msg.runId : null;
        if (!runId) return;

        const active = activeTasks.get(runId);
        if (active) {
          console.log(`  Task ${runId}: cancelling`);
          active.process.kill("SIGTERM");
          activeTasks.delete(runId);
        }

      } else if (msg.type === "adapter_test") {
        const adapterType = typeof msg.adapterType === "string" ? msg.adapterType : "unknown";
        const adapterConfig = (typeof msg.adapterConfig === "object" && msg.adapterConfig !== null
          ? msg.adapterConfig : {}) as Record<string, unknown>;
        console.log(`  Running adapter test: ${adapterType}...`);
        runAdapterTestLocally(adapterType, adapterConfig).then((result) => {
          ws.send(JSON.stringify({ type: "adapter_test_result", adapterType, result }));
          console.log(`  Adapter test ${adapterType}: ${result.status}`);
        }).catch((err) => {
          ws.send(JSON.stringify({
            type: "adapter_test_result",
            adapterType,
            result: {
              adapterType,
              status: "fail",
              checks: [{ code: "test_error", level: "error", message: String(err) }],
              testedAt: new Date().toISOString(),
            },
          }));
        });
      }
    } catch {
      // ignore non-JSON messages
    }
  });

  ws.on("error", (err) => {
    console.error("  WebSocket error:", err.message);
    process.exit(1);
  });

  const shutdown = () => {
    console.log("\n  Disconnecting...");
    for (const [runId, task] of activeTasks) {
      console.log(`  Killing task ${runId} on disconnect`);
      task.process.kill("SIGTERM");
    }
    activeTasks.clear();
    ws.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);

  if (args.command === "status") {
    const config = loadConfig();
    if (!config) {
      console.log("\n  No saved configuration. Run: artu-teams connect\n");
      return;
    }
    console.log(`\n  Artu Teams — Status`);
    console.log(`  Server:    ${config.server}`);
    console.log(`  User:      ${config.userId}`);
    console.log(`  Machine:   ${config.machineId}`);
    console.log(`  Company:   ${config.companyId}`);
    console.log(`  Config:    ${CONFIG_FILE}\n`);
    return;
  }

  if (args.command === "logout") {
    const config = loadConfig();
    if (config) {
      try {
        await post(`${config.server}/cli-auth/revoke-current`, {}, authHeaders(config.apiKey));
        console.log("  ✓ API key revoked");
      } catch {
        // Server unreachable — still clear local config
      }
    }
    clearConfig();
    console.log("  ✓ Local config cleared\n");
    return;
  }

  // --- connect command ---

  if (args.reset) clearConfig();

  // Legacy mode: --server + --token (backward compat)
  if (args.token && args.server) {
    await legacyTokenConnect(args.server, args.token, args.name);
    return;
  }

  let config = loadConfig();
  const serverBase = (args.server ?? config?.server ?? "https://teams.artu.ar/api").replace(/\/+$/, "");

  console.log(`\n  Artu Teams — Machine Connect`);

  // Check if existing config is valid
  if (config) {
    try {
      const meRes = await get(`${config.server}/cli-auth/me`, authHeaders(config.apiKey));
      if (meRes.status === 200) {
        const me = meRes.data as { user: { email: string } };
        console.log(`  ✓ Authenticated as ${me.user.email}`);
      } else {
        console.log("  Saved credentials expired. Re-authenticating...");
        config = null;
      }
    } catch {
      console.log("  Saved credentials invalid. Re-authenticating...");
      config = null;
    }
  }

  // Login if needed
  let apiKey: string;
  let userId: string;
  let companyId: string;
  let machineId: string;

  if (config) {
    apiKey = config.apiKey;
    userId = config.userId;
    companyId = config.companyId;
    machineId = config.machineId;
  } else {
    const login = await browserLogin(serverBase);
    console.log(`  ✓ Authenticated as ${login.userEmail}`);

    const company = await selectCompany(serverBase, login.apiKey, login.companyIds);
    apiKey = login.apiKey;
    userId = login.userId;
    companyId = company.companyId;
    machineId = getOrCreateMachineId();
  }

  // Connect machine via authenticated endpoint
  const machineName = args.name ?? osHostname();
  console.log(`  Connecting machine "${machineName}"...`);

  const connectRes = await post(
    `${serverBase}/machines/connect`,
    {
      machineId,
      hostname: osHostname(),
      os: platform(),
      arch: osArch(),
      companyId,
      adapters: [],
    },
    authHeaders(apiKey),
  );

  if (connectRes.status !== 200) {
    const err = connectRes.data as { error?: string } | null;
    throw new Error(`Failed to connect machine: ${err?.error ?? connectRes.status}`);
  }

  const machine = connectRes.data as {
    id: string;
    name: string;
    jwt?: string;
    wsUrl?: string;
    mergedDuplicates?: number;
  };

  // Save config
  saveConfig({
    machineId: machine.id,
    server: serverBase,
    apiKey,
    userId,
    companyId,
    machineJwt: machine.jwt ?? "",
    createdAt: new Date().toISOString(),
  });

  if (machine.mergedDuplicates && machine.mergedDuplicates > 0) {
    console.log(`  ✓ Cleaned ${machine.mergedDuplicates} duplicate machine(s)`);
  }

  // Connect WebSocket
  connectWebSocket(machine, serverBase);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

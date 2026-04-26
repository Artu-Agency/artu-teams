import { hostname as osHostname, platform, arch as osArch } from "node:os";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { execFile } from "node:child_process";
import path from "node:path";
import WebSocket from "ws";

/** Track active task processes */
const activeTasks = new Map<string, { process: ReturnType<typeof execFile>; adapterType: string }>();

// ---------------------------------------------------------------------------
// CLI argument parsing (no deps)
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { server: string; token: string; name?: string } {
  let server = "";
  let token = "";
  let name: string | undefined;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "connect") continue;
    if ((arg === "--server" || arg === "-s") && argv[i + 1]) {
      server = argv[++i]!;
    } else if ((arg === "--token" || arg === "-t") && argv[i + 1]) {
      token = argv[++i]!;
    } else if ((arg === "--name" || arg === "-n") && argv[i + 1]) {
      name = argv[++i]!;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
artu-teams connect — Connect this machine to an Artu Teams server

Usage:
  npx artu-teams connect --server <url> --token <invite-token>

Options:
  --server, -s <url>     Server API base URL (e.g. https://teams.artu.ar/api)
  --token, -t <token>    Invite token from the onboarding wizard
  --name, -n <name>      Machine name (default: hostname)
  --help, -h             Show this help
`);
      process.exit(0);
    }
  }

  if (!server || !token) {
    console.error("Error: --server and --token are required");
    console.error("Usage: npx artu-teams connect --server <url> --token <token>");
    process.exit(1);
  }

  return { server, token, name };
}

// ---------------------------------------------------------------------------
// HTTP helpers (no fetch dependency for broad Node compat)
// ---------------------------------------------------------------------------

function post(url: string, body: Record<string, unknown>): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const doRequest = isHttps ? httpsRequest : httpRequest;

    const payload = JSON.stringify(body);
    const req = doRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString()));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, data: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode ?? 0, data });
          }
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
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
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  const serverBase = args.server.replace(/\/+$/, "");
  const machineName = args.name ?? osHostname();

  console.log(`\n  Artu Teams — Machine Connect`);
  console.log(`  Server: ${serverBase}`);
  console.log(`  Machine: ${machineName} (${platform()} ${osArch()})\n`);

  // Step 1: Redeem invite token
  console.log("  [1/3] Redeeming invite token...");
  const redeemUrl = `${serverBase}/machines/redeem`;

  let redeemResult: { status: number; data: unknown };
  try {
    redeemResult = await post(redeemUrl, {
      token: args.token,
      name: machineName,
      hostname: osHostname(),
      os: platform(),
      arch: osArch(),
      ownerUserId: "cli-connect",
      adapters: [],
    });
  } catch (err) {
    console.error(`  Error: Could not reach server at ${redeemUrl}`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (redeemResult.status !== 201) {
    const errorData = redeemResult.data as { error?: string } | null;
    console.error(`  Error: Server returned ${redeemResult.status}`);
    console.error(`  ${errorData?.error ?? JSON.stringify(redeemResult.data)}`);
    process.exit(1);
  }

  const machine = redeemResult.data as {
    id: string;
    name: string;
    hostname: string;
    jwt?: string;
    wsUrl?: string;
  };

  console.log(`  Machine registered: ${machine.id}`);

  // Step 2: Connect WebSocket
  console.log("  [2/3] Connecting WebSocket...");

  // Use server-provided wsUrl (direct to backend, bypasses Vercel proxy)
  // Fallback: derive from server base if wsUrl not provided
  let wsUrl: string;
  if (machine.wsUrl) {
    wsUrl = machine.wsUrl;
  } else if (machine.jwt) {
    wsUrl = serverBase
      .replace(/^https:/, "wss:")
      .replace(/^http:/, "ws:")
      .replace(/\/api\/?$/, "") + `/ws/machines?token=${machine.jwt}`;
  } else {
    console.log("  Machine registered successfully.");
    console.log(`\n  Machine ID: ${machine.id}`);
    console.log("  Status: Connected (HTTP only)\n");
    console.log("  Press Ctrl+C to disconnect.\n");
    await new Promise(() => {});
    return;
  }

  const ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    console.log("  [3/3] Connected!\n");
    console.log(`  Machine ID: ${machine.id}`);
    console.log(`  Name: ${machine.name}`);
    console.log(`  Status: Online\n`);
    console.log("  Press Ctrl+C to disconnect.\n");

    // Heartbeat every 30s
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
      // Kill all active tasks
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

        // Build args
        const args: string[] = ["--print", "-", "--output-format", "stream-json", "--verbose"];
        const model = typeof adapterConfig.model === "string" ? adapterConfig.model.trim() : "";
        if (model) args.push("--model", model);
        if (adapterConfig.dangerouslySkipPermissions !== false) args.push("--dangerously-skip-permissions");
        const maxTurns = typeof adapterConfig.maxTurnsPerRun === "number" ? adapterConfig.maxTurnsPerRun : 0;
        if (maxTurns > 0) args.push("--max-turns", String(maxTurns));

        console.log(`  Task ${runId}: spawning ${command} ${args.join(" ").substring(0, 80)}...`);

        // Spawn process
        const child = execFile(command, args, {
          cwd: process.cwd(),
          env: process.env,
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

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n  Disconnecting...");
    // Kill all active tasks
    for (const [runId, task] of activeTasks) {
      console.log(`  Killing task ${runId} on disconnect`);
      task.process.kill("SIGTERM");
    }
    activeTasks.clear();
    ws.close();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    // Kill all active tasks
    for (const [runId, task] of activeTasks) {
      console.log(`  Killing task ${runId} on disconnect`);
      task.process.kill("SIGTERM");
    }
    activeTasks.clear();
    ws.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

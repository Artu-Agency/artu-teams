import { hostname as osHostname, platform, arch as osArch } from "node:os";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import WebSocket from "ws";

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
  };

  console.log(`  Machine registered: ${machine.id}`);

  // Step 2: Connect WebSocket
  console.log("  [2/3] Connecting WebSocket...");

  // The server needs to return a JWT for WebSocket auth.
  // If the redeem endpoint returns a jwt field, use it.
  // Otherwise we need to get one from the server.
  const jwt = machine.jwt;
  if (!jwt) {
    console.log("  Machine registered successfully but no WebSocket JWT received.");
    console.log("  The server may need to be updated to return a JWT on redeem.");
    console.log(`\n  Machine ID: ${machine.id}`);
    console.log("  Status: Connected (HTTP only)\n");
    // Keep process alive so the onboarding wizard detects the machine
    console.log("  Press Ctrl+C to disconnect.\n");
    await new Promise(() => {}); // hang forever
    return;
  }

  // Build WebSocket URL from server base
  const wsUrl = serverBase
    .replace(/^https:/, "wss:")
    .replace(/^http:/, "ws:")
    .replace(/\/api\/?$/, "") + `/ws/machines?token=${jwt}`;

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
        }));
      }
    }, 30_000);

    ws.on("close", () => {
      clearInterval(heartbeatInterval);
      console.log("  Disconnected from server.");
      process.exit(0);
    });
  });

  ws.on("message", (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString()) as { type?: string };
      if (msg.type === "connected") {
        // Server acknowledged connection
      } else if (msg.type === "heartbeat_ack") {
        // Heartbeat acknowledged
      } else if (msg.type === "task_dispatch") {
        console.log("  Received task dispatch:", JSON.stringify(msg));
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
    ws.close();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    ws.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

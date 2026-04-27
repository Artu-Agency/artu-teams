import { createHmac, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import type { Duplex } from "node:stream";
import type { Db } from "@paperclipai/db";
import { machines, machineCompanies, machineAdapters } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { logger } from "../middleware/logger.js";
import { publishLiveEvent } from "../services/live-events.js";

// ---------------------------------------------------------------------------
// ws library (CJS compat, same pattern as live-events-ws.ts)
// ---------------------------------------------------------------------------

interface WsSocket {
  readyState: number;
  ping(): void;
  send(data: string): void;
  terminate(): void;
  close(code?: number, reason?: string): void;
  on(event: "pong", listener: () => void): void;
  on(event: "message", listener: (data: Buffer) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
}

interface WsServer {
  clients: Set<WsSocket>;
  on(event: "connection", listener: (socket: WsSocket, req: IncomingMessage) => void): void;
  on(event: "close", listener: () => void): void;
  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (ws: WsSocket) => void,
  ): void;
  emit(event: "connection", ws: WsSocket, req: IncomingMessage): boolean;
}

const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require("ws") as {
  WebSocket: { OPEN: number };
  WebSocketServer: new (opts: { noServer: boolean }) => WsServer;
};

// ---------------------------------------------------------------------------
// Machine JWT helpers
// ---------------------------------------------------------------------------

const JWT_ALGORITHM = "HS256";

function jwtSecret(): string | null {
  const secret = process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim() || process.env.BETTER_AUTH_SECRET?.trim();
  return secret || null;
}

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signPayload(secret: string, signingInput: string) {
  return createHmac("sha256", secret).update(signingInput).digest("base64url");
}

function safeCompare(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function parseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface MachineJwtClaims {
  machineId: string;
  ownerUserId: string;
  type: "machine";
  iat: number;
  exp: number;
  iss?: string;
  aud?: string;
}

/** Generate a long-lived JWT for a machine (called when a machine redeems an invite). */
export function generateMachineJwt(machineId: string, ownerUserId: string): string | null {
  const secret = jwtSecret();
  if (!secret) return null;

  const issuer = process.env.PAPERCLIP_AGENT_JWT_ISSUER ?? "paperclip";
  const audience = process.env.PAPERCLIP_AGENT_JWT_AUDIENCE ?? "paperclip-api";
  const ttlSeconds = 60 * 60 * 24 * 365; // 1 year

  const now = Math.floor(Date.now() / 1000);
  const claims = {
    machineId,
    ownerUserId,
    type: "machine" as const,
    iat: now,
    exp: now + ttlSeconds,
    iss: issuer,
    aud: audience,
  };

  const header = { alg: JWT_ALGORITHM, typ: "JWT" };
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;
  const signature = signPayload(secret, signingInput);

  return `${signingInput}.${signature}`;
}

/** Verify a machine JWT and return its claims, or null if invalid/expired. */
export function verifyMachineJwt(token: string): MachineJwtClaims | null {
  if (!token) return null;
  const secret = jwtSecret();
  if (!secret) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, claimsB64, signature] = parts;

  const header = parseJson(base64UrlDecode(headerB64!));
  if (!header || header.alg !== JWT_ALGORITHM) return null;

  const signingInput = `${headerB64}.${claimsB64}`;
  const expectedSig = signPayload(secret, signingInput);
  if (!safeCompare(signature!, expectedSig)) return null;

  const claims = parseJson(base64UrlDecode(claimsB64!));
  if (!claims) return null;

  const machineId = typeof claims.machineId === "string" ? claims.machineId : null;
  const ownerUserId = typeof claims.ownerUserId === "string" ? claims.ownerUserId : null;
  const type = claims.type;
  const iat = typeof claims.iat === "number" ? claims.iat : null;
  const exp = typeof claims.exp === "number" ? claims.exp : null;
  if (!machineId || !ownerUserId || type !== "machine" || !iat || !exp) return null;

  const now = Math.floor(Date.now() / 1000);
  if (exp < now) return null;

  const issuer = typeof claims.iss === "string" ? claims.iss : undefined;
  const audience = typeof claims.aud === "string" ? claims.aud : undefined;
  const configIssuer = process.env.PAPERCLIP_AGENT_JWT_ISSUER ?? "paperclip";
  const configAudience = process.env.PAPERCLIP_AGENT_JWT_AUDIENCE ?? "paperclip-api";
  if (issuer && issuer !== configIssuer) return null;
  if (audience && audience !== configAudience) return null;

  return { machineId, ownerUserId, type: "machine", iat, exp, ...(issuer ? { iss: issuer } : {}), ...(audience ? { aud: audience } : {}) };
}

// ---------------------------------------------------------------------------
// Connected machines registry
// ---------------------------------------------------------------------------

interface MachineConnection {
  ws: WsSocket;
  machineId: string;
  ownerUserId: string;
  companyIds: string[];
}

const connectedMachines = new Map<string, MachineConnection>();

/** Timers for offline grace period (30 s after disconnect). */
const offlineTimers = new Map<string, NodeJS.Timeout>();

/** Timers for dispatch ACK timeout (10s after dispatch). */
const dispatchTimers = new Map<string, NodeJS.Timeout>();

/** Event emitter for task lifecycle events (decouples machine-ws from heartbeat logic). */
const machineTaskEmitter = new EventEmitter();
machineTaskEmitter.setMaxListeners(0);
export { machineTaskEmitter };

/** Pending adapter test promises keyed by `machineId::adapterType`. */
const pendingAdapterTests = new Map<string, { resolve: (result: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rejectUpgrade(socket: Duplex, statusLine: string, message: string) {
  const safe = message.replace(/[\r\n]+/g, " ").trim();
  socket.write(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${safe}`);
  socket.destroy();
}

function parseMachinePath(pathname: string): boolean {
  return pathname === "/ws/machines";
}

function parseTokenFromQuery(url: URL): string | null {
  const token = url.searchParams.get("token")?.trim() ?? "";
  return token.length > 0 ? token : null;
}

function safeParse(data: Buffer | string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(data.toString());
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// WebSocket setup
// ---------------------------------------------------------------------------

export function setupMachineWebSocket(server: HttpServer, db: Db) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws: WsSocket, req: IncomingMessage) => {
    const claims = (req as any).__machineClaims as MachineJwtClaims | undefined;
    const companyIds = ((req as any).__machineCompanyIds as string[] | undefined) ?? [];
    if (!claims) {
      ws.close(1008, "missing auth context");
      return;
    }

    const { machineId, ownerUserId } = claims;

    // Clear any pending offline timer for this machine
    const existingTimer = offlineTimers.get(machineId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      offlineTimers.delete(machineId);
    }

    // Close any previous connection for the same machine (stale socket)
    const prev = connectedMachines.get(machineId);
    if (prev) {
      logger.warn({ machineId }, "machine reconnected — closing previous socket");
      prev.ws.close(1000, "replaced by new connection");
    }

    // Register connection
    connectedMachines.set(machineId, { ws, machineId, ownerUserId, companyIds });

    // Persist online status to DB and publish live events
    void (async () => {
      try {
        await db
          .update(machines)
          .set({ status: "online", lastSeenAt: new Date() })
          .where(eq(machines.id, machineId));

        for (const companyId of companyIds) {
          publishLiveEvent({
            companyId,
            type: "machine.status",
            payload: { machineId, status: "online" },
          });
        }
      } catch (err) {
        logger.error({ err, machineId }, "failed to persist machine online status");
      }
    })();

    logger.info({ machineId, ownerUserId, companyIds }, "machine connected");

    // Send welcome message
    ws.send(JSON.stringify({ type: "connected", machineId, companies: companyIds }));

    // ------- message handler -------
    ws.on("message", (data) => {
      const msg = safeParse(data);
      if (!msg) {
        logger.warn({ machineId }, "machine sent non-JSON message — ignoring");
        return;
      }

      const msgType = typeof msg.type === "string" ? msg.type : null;

      switch (msgType) {
        case "heartbeat": {
          // Update machine status with resource metrics
          const cpu = typeof msg.cpu === "number" ? msg.cpu : undefined;
          const memory = typeof msg.memory === "number" ? msg.memory : undefined;
          const adapters = Array.isArray(msg.adapters) ? msg.adapters : undefined;

          logger.debug({ machineId, cpu, memory }, "machine heartbeat");

          // Persist metrics to DB (fire-and-forget)
          void (async () => {
            try {
              await db
                .update(machines)
                .set({
                  cpuUsage: cpu ?? undefined,
                  memoryUsage: memory ?? undefined,
                  lastSeenAt: new Date(),
                })
                .where(eq(machines.id, machineId));

              if (adapters && adapters.length > 0) {
                // Delete existing adapters and re-insert (same pattern as machineService.updateMachineAdapters)
                await db
                  .delete(machineAdapters)
                  .where(eq(machineAdapters.machineId, machineId));

                await db.insert(machineAdapters).values(
                  adapters.map((a: any) => ({
                    machineId,
                    adapterType: typeof a.type === "string" ? a.type : "unknown",
                    status: typeof a.status === "string" ? a.status : "available",
                    model: typeof a.model === "string" ? a.model : null,
                    version: typeof a.version === "string" ? a.version : null,
                    currentTaskId: typeof a.currentTaskId === "string" ? a.currentTaskId : null,
                    updatedAt: new Date(),
                  })),
                );
              }
            } catch (err) {
              logger.error({ err, machineId }, "failed to persist heartbeat metrics");
            }
          })();

          ws.send(JSON.stringify({ type: "heartbeat_ack", ts: Date.now() }));
          break;
        }

        case "task_update": {
          const issueId = typeof msg.issueId === "string" ? msg.issueId : null;
          const status = typeof msg.status === "string" ? msg.status : null;
          if (!issueId || !status) {
            logger.warn({ machineId, msg }, "machine task_update missing issueId or status");
            break;
          }

          logger.info({ machineId, issueId, status }, "machine task update");

          // TODO: update issue status in DB and log activity
          break;
        }

        case "adapter_test_result": {
          const adapterType = typeof msg.adapterType === "string" ? msg.adapterType : null;
          if (!adapterType) break;

          const key = `${machineId}::${adapterType}`;
          const pending = pendingAdapterTests.get(key);
          if (pending) {
            clearTimeout(pending.timer);
            pendingAdapterTests.delete(key);
            pending.resolve(msg.result ?? { ok: true });
          }
          break;
        }

        case "task_ack": {
          const runId = typeof msg.runId === "string" ? msg.runId : null;
          if (!runId) break;
          logger.info({ machineId, runId }, "machine acknowledged task dispatch");

          // Cancel dispatch timeout
          const timerKey = `dispatch::${runId}`;
          const pendingTimer = dispatchTimers.get(timerKey);
          if (pendingTimer) {
            clearTimeout(pendingTimer);
            dispatchTimers.delete(timerKey);
          }

          // Emit event for heartbeat service to mark run as 'running'
          machineTaskEmitter.emit("task_ack", { machineId, runId });
          break;
        }

        case "task_result": {
          const runId = typeof msg.runId === "string" ? msg.runId : null;
          if (!runId) break;
          const exitCode = typeof msg.exitCode === "number" ? msg.exitCode : null;
          const stdout = typeof msg.stdout === "string" ? msg.stdout : "";
          const stderr = typeof msg.stderr === "string" ? msg.stderr : "";
          logger.info({ machineId, runId, exitCode }, "machine reported task result");

          machineTaskEmitter.emit("task_result", { machineId, runId, exitCode, stdout, stderr });
          break;
        }

        case "task_progress": {
          const runId = typeof msg.runId === "string" ? msg.runId : null;
          if (!runId) break;
          const log = typeof msg.log === "string" ? msg.log : "";

          machineTaskEmitter.emit("task_progress", { machineId, runId, log });
          break;
        }

        case "task_busy": {
          const runId = typeof msg.runId === "string" ? msg.runId : null;
          if (!runId) break;
          logger.info({ machineId, runId }, "machine busy, cannot accept task");

          machineTaskEmitter.emit("task_busy", { machineId, runId });
          break;
        }

        default:
          logger.warn({ machineId, type: msgType }, "machine sent unknown message type");
      }
    });

    // ------- close handler -------
    ws.on("close", () => {
      logger.info({ machineId }, "machine disconnected — starting 30 s offline grace period");

      // Start offline grace period
      const timer = setTimeout(() => {
        offlineTimers.delete(machineId);
        connectedMachines.delete(machineId);

        logger.info({ machineId }, "machine offline grace period expired — marking offline");

        // Re-queue any runs dispatched/running on this machine
        machineTaskEmitter.emit("machine_lost", { machineId, companyIds });

        // Persist offline status and publish live events
        void (async () => {
          try {
            await db
              .update(machines)
              .set({ status: "offline" })
              .where(eq(machines.id, machineId));

            for (const cId of companyIds) {
              publishLiveEvent({
                companyId: cId,
                type: "machine.status",
                payload: { machineId, status: "offline" },
              });
            }
          } catch (err) {
            logger.error({ err, machineId }, "failed to persist machine offline status");
          }
        })();
      }, 30_000);

      offlineTimers.set(machineId, timer);
    });

    ws.on("error", (err) => {
      logger.warn({ err, machineId }, "machine websocket client error");
    });
  });

  // ------- Upgrade handler -------
  server.on("upgrade", (req, socket, head) => {
    logger.info({ url: req.url?.substring(0, 80), headers: { upgrade: req.headers.upgrade, connection: req.headers.connection } }, "upgrade request received");

    if (!req.url) return; // let other upgrade handlers deal with it

    const url = new URL(req.url, "http://localhost");
    if (!parseMachinePath(url.pathname)) {
      // Not our path — let other upgrade handlers (live-events) handle it
      return;
    }

    logger.info("machine WS upgrade — path matched");

    const token = parseTokenFromQuery(url);
    if (!token) {
      logger.warn("machine WS upgrade rejected — missing token");
      rejectUpgrade(socket, "401 Unauthorized", "missing token");
      return;
    }

    const claims = verifyMachineJwt(token);
    if (!claims) {
      logger.warn("machine WS upgrade rejected — invalid/expired JWT");
      rejectUpgrade(socket, "403 Forbidden", "invalid or expired token");
      return;
    }

    logger.info({ machineId: claims.machineId }, "machine WS upgrade — JWT valid, upgrading");

    // Verify machine still exists in DB and load companyIds before upgrading
    void (async () => {
      try {
        // Check machine exists (may have been deleted if DB was wiped)
        const machineRow = await db
          .select({ id: machines.id })
          .from(machines)
          .where(eq(machines.id, claims.machineId))
          .then((rows) => rows[0] ?? null);

        if (!machineRow) {
          logger.warn({ machineId: claims.machineId }, "machine WS upgrade rejected — machine not found in DB (stale credentials)");
          rejectUpgrade(socket, "410 Gone", "machine_not_found");
          return;
        }

        const rows = await db
          .select({ companyId: machineCompanies.companyId })
          .from(machineCompanies)
          .where(eq(machineCompanies.machineId, claims.machineId));

        const companyIds = rows.map((r) => r.companyId);

        if (companyIds.length === 0) {
          logger.warn({ machineId: claims.machineId }, "machine WS upgrade rejected — no company associations (stale credentials)");
          rejectUpgrade(socket, "410 Gone", "no_company");
          return;
        }

        (req as any).__machineClaims = claims;
        (req as any).__machineCompanyIds = companyIds;

        wss.handleUpgrade(req, socket, head, (ws: WsSocket) => {
          logger.info({ machineId: claims.machineId }, "machine WS upgrade — handleUpgrade callback fired");
          wss.emit("connection", ws, req);
        });
      } catch (err) {
        logger.error({ err, machineId: claims.machineId }, "machine WS upgrade — failed to load companyIds or upgrade");
        rejectUpgrade(socket, "500 Internal Server Error", "internal error");
      }
    })();
  });

  logger.info("Machine WebSocket server attached on /ws/machines");

  // On startup, mark all machines as offline (no WS connections survive a restart)
  void db
    .update(machines)
    .set({ status: "offline" })
    .then(() => logger.info("marked all machines offline on startup"))
    .catch((err) => logger.error({ err }, "failed to mark machines offline on startup"));

  return wss;
}

// ---------------------------------------------------------------------------
// Public API — used by other server modules to interact with machines
// ---------------------------------------------------------------------------

/** Send a task dispatch to a specific connected machine. Returns false if the machine is not connected. */
export function dispatchTaskToMachine(
  machineId: string,
  payload: {
    issueId: string;
    companyId: string;
    agentConfig: unknown;
    adapterType: string;
    model: string;
  },
): boolean {
  const conn = connectedMachines.get(machineId);
  if (!conn || conn.ws.readyState !== 1 /* WebSocket.OPEN */) return false;
  conn.ws.send(JSON.stringify({ type: "task_dispatch", ...payload }));
  return true;
}

/** Send an adapter environment test to a machine and wait for the response (timeout 45 s). */
export function sendAdapterTest(
  machineId: string,
  adapterType: string,
  adapterConfig?: Record<string, unknown>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const conn = connectedMachines.get(machineId);
    if (!conn || conn.ws.readyState !== 1) {
      return reject(new Error(`Machine ${machineId} is not connected`));
    }

    const key = `${machineId}::${adapterType}`;

    // Clean up any stale pending test for the same key
    const existing = pendingAdapterTests.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.reject(new Error("superseded by new test request"));
    }

    const timer = setTimeout(() => {
      pendingAdapterTests.delete(key);
      reject(new Error(`Adapter test timed out for ${adapterType} on machine ${machineId}`));
    }, 90_000);

    pendingAdapterTests.set(key, { resolve, reject, timer });

    conn.ws.send(JSON.stringify({ type: "adapter_test", adapterType, adapterConfig }));
  });
}

/** Get the list of currently connected machine IDs. */
export function getConnectedMachineIds(): string[] {
  return Array.from(connectedMachines.keys());
}

/** Check if a specific machine is currently connected. */
export function isMachineConnected(machineId: string): boolean {
  return connectedMachines.has(machineId);
}

/** Find a connected machine for a given company. Returns the first online machine ID or null. */
export function findConnectedMachineForCompany(companyId: string): string | null {
  for (const [machineId, conn] of connectedMachines) {
    if (conn.companyIds.includes(companyId) && conn.ws.readyState === 1) {
      return machineId;
    }
  }
  return null;
}

/** Dispatch a task to a machine AND set a 10 s ACK timeout. Returns false if machine is not connected. */
export function dispatchTaskToMachineWithTimeout(
  machineId: string,
  payload: {
    runId: string;
    issueId: string;
    companyId: string;
    agentId: string;
    adapterType: string;
    adapterConfig: Record<string, unknown>;
    prompt: string;
    timeoutSec: number;
  },
  onTimeout: () => void,
): boolean {
  const conn = connectedMachines.get(machineId);
  if (!conn || conn.ws.readyState !== 1) return false;

  try {
    conn.ws.send(JSON.stringify({ type: "task_dispatch", ...payload }));
  } catch (err) {
    logger.error({ err, machineId, runId: payload.runId }, "failed to send task_dispatch");
    return false;
  }

  // Set dispatch ACK timeout (10s)
  const timerKey = `dispatch::${payload.runId}`;
  const existing = dispatchTimers.get(timerKey);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    dispatchTimers.delete(timerKey);
    logger.warn({ machineId, runId: payload.runId }, "dispatch ACK timeout — re-queuing");
    onTimeout();
  }, 10_000);

  dispatchTimers.set(timerKey, timer);
  return true;
}

/** Get companyIds for a connected machine */
export function getConnectedMachineCompanyIds(machineId: string): string[] {
  const conn = connectedMachines.get(machineId);
  return conn?.companyIds ?? [];
}

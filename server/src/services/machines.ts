import { randomUUID } from "node:crypto";
import { and, eq, gt, sql, asc, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  machines,
  machineCompanies,
  machineAdapters,
  machineInvites,
} from "@paperclipai/db";
import { badRequest, notFound, unprocessable } from "../errors.js";

export function machineService(db: Db) {
  /**
   * List machines for a company (via machine_companies bridge).
   */
  async function listMachinesForCompany(companyId: string) {
    const rows = await db
      .select({
        id: machines.id,
        name: machines.name,
        hostname: machines.hostname,
        os: machines.os,
        arch: machines.arch,
        ownerUserId: machines.ownerUserId,
        status: machines.status,
        lastSeenAt: machines.lastSeenAt,
        cpuUsage: machines.cpuUsage,
        memoryUsage: machines.memoryUsage,
        createdAt: machines.createdAt,
        updatedAt: machines.updatedAt,
        role: machineCompanies.role,
        joinedAt: machineCompanies.joinedAt,
      })
      .from(machineCompanies)
      .innerJoin(machines, eq(machines.id, machineCompanies.machineId))
      .where(eq(machineCompanies.companyId, companyId));

    // Load adapters for each machine
    const machineIds = rows.map((r) => r.id);
    const allAdapters = machineIds.length > 0
      ? await db
          .select()
          .from(machineAdapters)
          .where(sql`${machineAdapters.machineId} IN ${machineIds}`)
      : [];

    const adaptersByMachine = new Map<string, typeof allAdapters>();
    for (const adapter of allAdapters) {
      const list = adaptersByMachine.get(adapter.machineId) ?? [];
      list.push(adapter);
      adaptersByMachine.set(adapter.machineId, list);
    }

    return rows.map((row) => ({
      ...row,
      adapters: adaptersByMachine.get(row.id) ?? [],
    }));
  }

  /**
   * Get a single machine with its adapters.
   */
  async function getMachine(machineId: string) {
    const [machine] = await db
      .select()
      .from(machines)
      .where(eq(machines.id, machineId))
      .limit(1);

    if (!machine) return null;

    const adapters = await db
      .select()
      .from(machineAdapters)
      .where(eq(machineAdapters.machineId, machineId));

    return { ...machine, adapters };
  }

  /**
   * Create an invite token (24h expiry) for a company.
   */
  async function createMachineInvite(companyId: string, createdBy: string) {
    const token = randomUUID();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const [invite] = await db
      .insert(machineInvites)
      .values({
        companyId,
        token,
        createdBy,
        expiresAt,
      })
      .returning();

    return invite;
  }

  /**
   * Redeem an invite: validate token, create machine + bridge + adapters, invalidate token.
   */
  async function redeemMachineInvite(
    token: string,
    machineInfo: {
      name: string;
      hostname: string;
      os: string;
      arch: string;
      ownerUserId: string;
      adapters: { type: string; model: string; version: string }[];
    },
  ) {
    // Find and validate the invite
    const [invite] = await db
      .select()
      .from(machineInvites)
      .where(
        and(
          eq(machineInvites.token, token),
          isNull(machineInvites.usedByMachineId),
        ),
      )
      .limit(1);

    if (!invite) {
      throw badRequest("Invalid or already used invite token");
    }

    if (new Date() > invite.expiresAt) {
      throw unprocessable("Invite token has expired");
    }

    // Create the machine — use invite creator as owner (valid FK to user table)
    const [machine] = await db
      .insert(machines)
      .values({
        name: machineInfo.name,
        hostname: machineInfo.hostname,
        os: machineInfo.os,
        arch: machineInfo.arch,
        ownerUserId: invite.createdBy,
        status: "online",
        lastSeenAt: new Date(),
      })
      .returning();

    // Create the machine-company bridge record
    await db.insert(machineCompanies).values({
      machineId: machine.id,
      companyId: invite.companyId,
      role: "worker",
      inviteId: invite.id,
    });

    // Create adapters
    if (machineInfo.adapters.length > 0) {
      await db.insert(machineAdapters).values(
        machineInfo.adapters.map((adapter) => ({
          machineId: machine.id,
          adapterType: adapter.type,
          model: adapter.model,
          version: adapter.version,
          status: "available",
        })),
      );
    }

    // Invalidate the invite
    await db
      .update(machineInvites)
      .set({ usedByMachineId: machine.id })
      .where(eq(machineInvites.id, invite.id));

    // Return full machine with adapters
    return getMachine(machine.id);
  }

  /**
   * Remove a machine from a company.
   */
  async function removeMachineFromCompany(machineId: string, companyId: string) {
    const [deleted] = await db
      .delete(machineCompanies)
      .where(
        and(
          eq(machineCompanies.machineId, machineId),
          eq(machineCompanies.companyId, companyId),
        ),
      )
      .returning();

    if (!deleted) {
      throw notFound("Machine not found in this company");
    }

    return { ok: true };
  }

  /**
   * Update machine status + metrics (called from WebSocket heartbeat).
   */
  async function updateMachineStatus(
    machineId: string,
    data: {
      status: string;
      cpuUsage: number;
      memoryUsage: number;
      lastSeenAt: Date;
    },
  ) {
    const [updated] = await db
      .update(machines)
      .set({
        status: data.status,
        cpuUsage: data.cpuUsage,
        memoryUsage: data.memoryUsage,
        lastSeenAt: data.lastSeenAt,
        updatedAt: new Date(),
      })
      .where(eq(machines.id, machineId))
      .returning();

    if (!updated) {
      throw notFound("Machine not found");
    }

    return updated;
  }

  /**
   * Upsert machine adapters (called from WebSocket heartbeat).
   */
  async function updateMachineAdapters(
    machineId: string,
    adapters: {
      type: string;
      status: string;
      model: string;
      version: string;
      currentTaskId: string | null;
    }[],
  ) {
    // Delete existing adapters and re-insert — simple upsert strategy
    await db
      .delete(machineAdapters)
      .where(eq(machineAdapters.machineId, machineId));

    if (adapters.length > 0) {
      await db.insert(machineAdapters).values(
        adapters.map((adapter) => ({
          machineId,
          adapterType: adapter.type,
          status: adapter.status,
          model: adapter.model,
          version: adapter.version,
          currentTaskId: adapter.currentTaskId,
          updatedAt: new Date(),
        })),
      );
    }

    // Return current adapters
    return db
      .select()
      .from(machineAdapters)
      .where(eq(machineAdapters.machineId, machineId));
  }

  /**
   * Find best machine for task dispatch.
   *
   * Logic: online machines + authorized for company + adapter available + lowest load.
   * Load score = (cpuUsage * 0.3) + (busyAdaptersCount * 0.7)
   */
  async function getAvailableMachineForTask(
    companyId: string,
    adapterType: string,
  ): Promise<{ machineId: string; adapterId: string } | null> {
    // Find online machines authorized for this company that have an available adapter of the requested type
    const candidates = await db
      .select({
        machineId: machines.id,
        adapterId: machineAdapters.id,
        cpuUsage: machines.cpuUsage,
      })
      .from(machineCompanies)
      .innerJoin(machines, eq(machines.id, machineCompanies.machineId))
      .innerJoin(
        machineAdapters,
        and(
          eq(machineAdapters.machineId, machines.id),
          eq(machineAdapters.adapterType, adapterType),
          eq(machineAdapters.status, "available"),
        ),
      )
      .where(
        and(
          eq(machineCompanies.companyId, companyId),
          eq(machines.status, "online"),
        ),
      );

    if (candidates.length === 0) return null;

    // For each candidate machine, count busy adapters to compute load score
    const machineIds = [...new Set(candidates.map((c) => c.machineId))];
    const busyCounts = new Map<string, number>();

    for (const mid of machineIds) {
      const [result] = await db
        .select({ count: sql<number>`count(*)` })
        .from(machineAdapters)
        .where(
          and(
            eq(machineAdapters.machineId, mid),
            eq(machineAdapters.status, "busy"),
          ),
        );
      busyCounts.set(mid, Number(result?.count ?? 0));
    }

    // Score candidates: lower is better
    let best: { machineId: string; adapterId: string; score: number } | null = null;

    for (const candidate of candidates) {
      const busyCount = busyCounts.get(candidate.machineId) ?? 0;
      const cpuUsage = candidate.cpuUsage ?? 0;
      const score = cpuUsage * 0.3 + busyCount * 0.7;

      if (!best || score < best.score) {
        best = {
          machineId: candidate.machineId,
          adapterId: candidate.adapterId,
          score,
        };
      }
    }

    if (!best) return null;

    return { machineId: best.machineId, adapterId: best.adapterId };
  }

  /**
   * Connect a machine (create or reuse) — authenticated via board API key.
   * No invite token needed.
   */
  async function connectMachine(input: {
    machineId: string | null;
    hostname: string;
    os: string;
    arch: string;
    ownerUserId: string;
    companyId: string;
    adapters: { type: string; model: string; version: string }[];
  }) {
    const now = new Date();
    let machine: typeof machines.$inferSelect;

    if (input.machineId) {
      // Try to find existing machine
      const [existing] = await db
        .select()
        .from(machines)
        .where(eq(machines.id, input.machineId))
        .limit(1);

      if (existing) {
        // Reuse — update info + set online
        const [updated] = await db
          .update(machines)
          .set({
            hostname: input.hostname,
            name: input.hostname,
            os: input.os,
            arch: input.arch,
            status: "online",
            lastSeenAt: now,
            updatedAt: now,
          })
          .where(eq(machines.id, input.machineId))
          .returning();
        machine = updated;
      } else {
        // Create with specified ID
        const [created] = await db
          .insert(machines)
          .values({
            id: input.machineId,
            name: input.hostname,
            hostname: input.hostname,
            os: input.os,
            arch: input.arch,
            ownerUserId: input.ownerUserId,
            status: "online",
            lastSeenAt: now,
          })
          .returning();
        machine = created;
      }
    } else {
      // No machineId — create new
      const [created] = await db
        .insert(machines)
        .values({
          name: input.hostname,
          hostname: input.hostname,
          os: input.os,
          arch: input.arch,
          ownerUserId: input.ownerUserId,
          status: "online",
          lastSeenAt: now,
        })
        .returning();
      machine = created;
    }

    // Ensure machine-company bridge exists
    const [existingBridge] = await db
      .select()
      .from(machineCompanies)
      .where(
        and(
          eq(machineCompanies.machineId, machine.id),
          eq(machineCompanies.companyId, input.companyId),
        ),
      )
      .limit(1);

    if (!existingBridge) {
      await db.insert(machineCompanies).values({
        machineId: machine.id,
        companyId: input.companyId,
        role: "worker",
      });
    }

    // Upsert adapters
    if (input.adapters.length > 0) {
      await db
        .delete(machineAdapters)
        .where(eq(machineAdapters.machineId, machine.id));
      await db.insert(machineAdapters).values(
        input.adapters.map((a) => ({
          machineId: machine.id,
          adapterType: a.type,
          model: a.model,
          version: a.version,
          status: "available",
        })),
      );
    }

    // Merge stale duplicates
    const mergedCount = await mergeStaleDuplicates(
      machine.id,
      input.hostname,
      input.os,
      input.arch,
      input.ownerUserId,
    );

    return { machine: await getMachine(machine.id), mergedCount };
  }

  /**
   * Delete offline machines with same fingerprint (hostname+os+arch+owner) but different ID.
   */
  async function mergeStaleDuplicates(
    keepId: string,
    hostname: string,
    os: string,
    arch: string,
    ownerUserId: string,
  ): Promise<number> {
    const duplicates = await db
      .select({ id: machines.id })
      .from(machines)
      .where(
        and(
          eq(machines.hostname, hostname),
          eq(machines.os, os),
          eq(machines.arch, arch),
          eq(machines.ownerUserId, ownerUserId),
          eq(machines.status, "offline"),
          sql`${machines.id} != ${keepId}`,
        ),
      );

    for (const dup of duplicates) {
      await db.delete(machineAdapters).where(eq(machineAdapters.machineId, dup.id));
      await db.delete(machineCompanies).where(eq(machineCompanies.machineId, dup.id));
      await db.delete(machines).where(eq(machines.id, dup.id));
    }

    return duplicates.length;
  }

  return {
    listMachinesForCompany,
    getMachine,
    createMachineInvite,
    redeemMachineInvite,
    removeMachineFromCompany,
    updateMachineStatus,
    updateMachineAdapters,
    getAvailableMachineForTask,
    connectMachine,
    mergeStaleDuplicates,
  };
}

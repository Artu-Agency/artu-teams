import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { machineService } from "../services/machines.js";
import { badRequest } from "../errors.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { generateMachineJwt } from "../realtime/machine-ws.js";

export function machineRoutes(db: Db) {
  const router = Router();
  const svc = machineService(db);

  // GET /companies/:companyId/machines — list machines for a company
  router.get("/companies/:companyId/machines", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const machines = await svc.listMachinesForCompany(companyId);
    res.json(machines);
  });

  // GET /machines/:machineId — get single machine with adapters
  router.get("/machines/:machineId", async (req, res) => {
    assertBoard(req);
    const { machineId } = req.params;
    const machine = await svc.getMachine(machineId);
    if (!machine) {
      res.status(404).json({ error: "Machine not found" });
      return;
    }
    res.json(machine);
  });

  // POST /companies/:companyId/machines/invite — create invite token
  router.post("/companies/:companyId/machines/invite", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    const userId = req.actor.type === "board" ? (req.actor.userId ?? "board") : "unknown";
    const invite = await svc.createMachineInvite(companyId, userId);
    res.status(201).json(invite);
  });

  // POST /machines/redeem — redeem an invite token
  router.post("/machines/redeem", async (req, res) => {
    const { token, name, hostname, os, arch, ownerUserId, adapters } = req.body ?? {};

    if (!token || typeof token !== "string") {
      throw badRequest("Missing or invalid token");
    }
    if (!name || typeof name !== "string") {
      throw badRequest("Missing or invalid machine name");
    }
    if (!hostname || typeof hostname !== "string") {
      throw badRequest("Missing or invalid hostname");
    }

    const machine = await svc.redeemMachineInvite(token, {
      name,
      hostname,
      os: os ?? "unknown",
      arch: arch ?? "unknown",
      ownerUserId: ownerUserId ?? "unknown",
      adapters: Array.isArray(adapters) ? adapters : [],
    });

    // Generate a JWT so the CLI can open a WebSocket connection
    const jwt = machine?.id ? generateMachineJwt(machine.id, ownerUserId ?? "unknown") : null;

    res.status(201).json({ ...machine, jwt });
  });

  // DELETE /companies/:companyId/machines/:machineId — remove machine from company
  router.delete("/companies/:companyId/machines/:machineId", async (req, res) => {
    const { companyId, machineId } = req.params;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const result = await svc.removeMachineFromCompany(machineId, companyId);
    res.json(result);
  });

  return router;
}

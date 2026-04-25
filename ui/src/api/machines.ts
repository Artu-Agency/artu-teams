import { api } from "./client";

export interface Machine {
  id: string;
  name: string;
  hostname: string;
  os: string;
  arch: string;
  ownerUserId: string;
  status: "online" | "offline";
  lastSeenAt: string | null;
  cpuUsage: number | null;
  memoryUsage: number | null;
  adapters: MachineAdapter[];
}

export interface MachineAdapter {
  id: string;
  adapterType: string;
  model: string | null;
  status: "available" | "busy" | "error";
  currentTaskId: string | null;
  version: string | null;
}

export interface MachineInvite {
  id: string;
  token: string;
  expiresAt: string;
}

export const machinesApi = {
  list: (companyId: string) => api.get<Machine[]>(`/companies/${companyId}/machines`),
  get: (machineId: string) => api.get<Machine>(`/machines/${machineId}`),
  createInvite: (companyId: string) =>
    api.post<MachineInvite>(`/companies/${companyId}/machines/invite`, {}),
  remove: (companyId: string, machineId: string) =>
    api.delete(`/companies/${companyId}/machines/${machineId}`),
};

import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export interface CliConfig {
  machineId: string;
  server: string;
  apiKey: string;
  userId: string;
  companyId: string;
  machineJwt: string;
  createdAt: string;
}

const CONFIG_DIR = join(homedir(), ".artu-teams");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export function loadConfig(): CliConfig | null {
  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.machineId === "string" &&
      typeof parsed.server === "string" &&
      typeof parsed.apiKey === "string" &&
      typeof parsed.userId === "string" &&
      typeof parsed.companyId === "string"
    ) {
      return parsed as CliConfig;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveConfig(config: CliConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function clearConfig(): void {
  try {
    unlinkSync(CONFIG_FILE);
  } catch {
    // file didn't exist — fine
  }
}

export function getOrCreateMachineId(existing?: string): string {
  return existing ?? randomUUID();
}

export { CONFIG_FILE };

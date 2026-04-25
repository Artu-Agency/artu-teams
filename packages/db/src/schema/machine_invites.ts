import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { authUsers } from "./auth.js";
import { machines } from "./machines.js";

export const machineInvites = pgTable(
  "machine_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    token: text("token").notNull(),
    createdBy: text("created_by").notNull().references(() => authUsers.id),
    usedByMachineId: uuid("used_by_machine_id").references(() => machines.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tokenUniqueIdx: uniqueIndex("machine_invites_token_unique_idx").on(table.token),
  }),
);

import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { machines } from "./machines.js";
import { companies } from "./companies.js";

export const machineCompanies = pgTable(
  "machine_companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    machineId: uuid("machine_id").notNull().references(() => machines.id),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    role: text("role").default("worker"),
    inviteId: uuid("invite_id"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    machineCompanyIdx: index("machine_companies_machine_company_idx").on(table.machineId, table.companyId),
  }),
);

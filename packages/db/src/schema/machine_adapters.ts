import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { machines } from "./machines.js";
import { issues } from "./issues.js";

export const machineAdapters = pgTable(
  "machine_adapters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    machineId: uuid("machine_id").notNull().references(() => machines.id),
    adapterType: text("adapter_type").notNull(),
    model: text("model"),
    status: text("status").default("available"),
    currentTaskId: uuid("current_task_id").references(() => issues.id),
    version: text("version"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    machineAdapterTypeIdx: index("machine_adapters_machine_type_idx").on(table.machineId, table.adapterType),
  }),
);

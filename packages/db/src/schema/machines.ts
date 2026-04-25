import { pgTable, uuid, text, timestamp, real, index } from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";

export const machines = pgTable(
  "machines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    hostname: text("hostname").notNull(),
    os: text("os").notNull(),
    arch: text("arch").notNull(),
    ownerUserId: text("owner_user_id").notNull().references(() => authUsers.id),
    status: text("status").notNull().default("offline"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    cpuUsage: real("cpu_usage"),
    memoryUsage: real("memory_usage"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ownerStatusIdx: index("machines_owner_status_idx").on(table.ownerUserId, table.status),
  }),
);

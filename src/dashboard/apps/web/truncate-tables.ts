#!/usr/bin/env bun
import { sql } from "drizzle-orm";
import { db } from "./src/drizzle/index.ts";

console.log("Truncating tables...");

try {
    await db.execute(sql`TRUNCATE TABLE timers CASCADE`);
    console.log("✓ Truncated timers table");

    await db.execute(sql`TRUNCATE TABLE activity_logs CASCADE`);
    console.log("✓ Truncated activity_logs table");

    console.log("✓ All tables truncated successfully!");
    process.exit(0);
} catch (error) {
    console.error("✗ Error truncating tables:", error);
    process.exit(1);
}

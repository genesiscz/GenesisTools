/**
 * Dashboard PowerSync Backend Connector
 *
 * This connector handles uploading local changes to the Nitro backend.
 * Runs in "local-only" mode - no PowerSync Cloud, just client SQLite + server SQLite.
 *
 * Flow:
 * 1. Client makes changes → PowerSync queues in CRUD batch
 * 2. uploadData() calls server function to sync
 * 3. Nitro applies changes to server SQLite
 *
 * NOTE: No direct imports from @powersync/web to avoid SSR issues.
 * Types are defined inline.
 *
 * NOTE: Server functions must be statically imported for TanStack Start
 * to transform them into RPC calls on the client.
 */

import { uploadSyncBatch } from "@/lib/timer/timer-sync.server";

// Define the PowerSync connector interface inline to avoid SSR import issues
interface PowerSyncCredentials {
    endpoint: string;
    token: string;
    expiresAt?: Date;
    userId?: string;
}

// biome-ignore lint/suspicious/noExplicitAny: Avoid PowerSync type imports during SSR
type AbstractPowerSyncDatabase = any;

export class DashboardConnector {
    /**
     * Fetch PowerSync credentials
     *
     * For local-only mode (no PowerSync Cloud), return null.
     * This disables the PowerSync sync service connection.
     */
    async fetchCredentials(): Promise<PowerSyncCredentials | null> {
        // Local-only mode - no PowerSync Cloud
        // Return null to disable sync service connection
        return null;
    }

    /**
     * Upload local changes to the Nitro backend
     *
     * Called manually after write operations.
     * Uses TanStack Start server function for RPC.
     */
    async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
        // Get pending CRUD operations
        const batch = await database.getCrudBatch(100);

        if (!batch || batch.crud.length === 0) {
            console.log("[PowerSync] No pending operations to sync");
            return;
        }

        try {
            console.log("[PowerSync] Raw CRUD batch:", JSON.stringify(batch.crud.slice(0, 2), null, 2));

            const operations = batch.crud.map(
                // biome-ignore lint/suspicious/noExplicitAny: PowerSync CRUD batch format varies
                (op: any) => ({
                    id: op.id,
                    op: op.op as "PUT" | "PATCH" | "DELETE",
                    table: op.table,
                    // PowerSync uses 'opData' for the actual data
                    data: op.opData ?? op.data ?? {},
                })
            );

            console.log(`[PowerSync] Uploading ${operations.length} operations to server...`);
            console.log("[PowerSync] First operation:", JSON.stringify(operations[0], null, 2));

            // Call server function (TanStack Start transforms to RPC on client)
            await uploadSyncBatch({ data: { operations } });

            // Mark the batch as complete
            await batch.complete();
            console.log(`[PowerSync] Uploaded ${operations.length} operations to server`);
        } catch (error) {
            console.error("[PowerSync] Error uploading data:", error);
            throw error; // Rethrow to trigger retry
        }
    }
}

/**
 * Create a connector instance
 */
export function createConnector(): DashboardConnector {
    return new DashboardConnector();
}

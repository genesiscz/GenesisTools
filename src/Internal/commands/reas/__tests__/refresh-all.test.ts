import { describe, expect, test } from "bun:test";
import { refreshPropertiesSequentially } from "@app/Internal/commands/reas/ui/src/components/watchlist/refresh-all";

describe("refreshPropertiesSequentially", () => {
    test("refreshes properties in sequence and reports progress", async () => {
        const order: number[] = [];
        const progress: Array<{ completed: number; failed: number; propertyId: number; error?: string }> = [];

        const result = await refreshPropertiesSequentially({
            propertyIds: [2, 4, 8],
            refreshProperty: async (propertyId) => {
                order.push(propertyId);
            },
            onProgress: (entry) => {
                progress.push({
                    completed: entry.completed,
                    failed: entry.failed,
                    propertyId: entry.propertyId,
                    error: entry.error,
                });
            },
        });

        expect(order).toEqual([2, 4, 8]);
        expect(progress).toEqual([
            { completed: 1, failed: 0, propertyId: 2, error: undefined },
            { completed: 2, failed: 0, propertyId: 4, error: undefined },
            { completed: 3, failed: 0, propertyId: 8, error: undefined },
        ]);
        expect(result).toEqual({
            completed: 3,
            failed: 0,
            total: 3,
            failures: [],
        });
    });

    test("continues after failures and collects error details", async () => {
        const result = await refreshPropertiesSequentially({
            propertyIds: [1, 2, 3],
            refreshProperty: async (propertyId) => {
                if (propertyId === 2) {
                    throw new Error("provider timeout");
                }
            },
        });

        expect(result.completed).toBe(2);
        expect(result.failed).toBe(1);
        expect(result.total).toBe(3);
        expect(result.failures).toEqual([{ propertyId: 2, error: "provider timeout" }]);
    });
});

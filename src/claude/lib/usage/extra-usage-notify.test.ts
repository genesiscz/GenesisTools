import { setupStorageSandbox } from "@app/utils/storage/test-sandbox";

setupStorageSandbox();

import { describe, expect, test } from "bun:test";
import { Storage } from "@app/utils/storage/storage";
import type { AccountUsage, ExtraUsageBucket } from "./api";
import { __makeExtraUsageNotifier } from "./extra-usage-notify";
import { formatExtraUsageMessage } from "./extra-usage-tracker";

function makeAccount(name: string, extra: ExtraUsageBucket): AccountUsage {
    return {
        accountName: name,
        label: name,
        usage: {
            five_hour: { utilization: 0, resets_at: null },
            seven_day: { utilization: 0, resets_at: null },
            extra_usage: extra,
        },
    };
}

describe("processExtraUsageNotifications", () => {
    test("persists disabled state before returning so repeat polls do not re-fire", async () => {
        const storage = new Storage("claude-usage");
        const dispatched: string[] = [];
        const run = __makeExtraUsageNotifier({
            extraUsageEnabled: () => true,
            storage,
            dispatch: async (accountName, event) => {
                dispatched.push(formatExtraUsageMessage({ accountName, event }));
            },
        });

        await run([
            makeAccount("reservine", {
                is_enabled: true,
                used_credits: 1834,
                monthly_limit: 10_000,
                utilization: 18.34,
                currency: "EUR",
                decimal_places: 2,
            }),
        ]);

        expect(dispatched).toHaveLength(1);

        dispatched.length = 0;

        await run([
            makeAccount("reservine", {
                is_enabled: false,
                monthly_limit: null,
                used_credits: null,
                utilization: null,
            }),
        ]);

        expect(dispatched).toHaveLength(1);
        expect(dispatched[0]).toContain("disabled");

        dispatched.length = 0;

        await run([
            makeAccount("reservine", {
                is_enabled: false,
                monthly_limit: null,
                used_credits: null,
                utilization: null,
            }),
        ]);

        expect(dispatched).toHaveLength(0);
    });
});

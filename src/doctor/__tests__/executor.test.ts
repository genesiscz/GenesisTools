import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { executeActions } from "@app/doctor/lib/executor";
import { HISTORY_FILE } from "@app/doctor/lib/paths";
import type { Action, ActionResult, Finding, Severity } from "@app/doctor/lib/types";

let originalHistory: string | null;
let runId: string;

beforeEach(() => {
    originalHistory = existsSync(HISTORY_FILE) ? readFileSync(HISTORY_FILE, "utf8") : null;
    runId = `doctor-executor-test-${crypto.randomUUID()}`;
});

afterEach(() => {
    if (originalHistory === null) {
        rmSync(HISTORY_FILE, { force: true });
    } else {
        writeFileSync(HISTORY_FILE, originalHistory, "utf8");
    }
});

function finding(id: string, severity: Severity = "safe"): Finding {
    return {
        id,
        analyzerId: "stub",
        title: `finding-${id}`,
        severity,
        reclaimableBytes: 100,
        actions: [],
    };
}

function action(id: string, label: string, onExecute?: () => Promise<Partial<ActionResult>>): Action {
    return {
        id,
        label,
        confirm: "none",
        execute: async (_, found) => {
            const partial = (await onExecute?.()) ?? {};
            return {
                findingId: found.id,
                actionId: id,
                status: "ok",
                actualReclaimedBytes: found.reclaimableBytes,
                ...partial,
            };
        },
    };
}

describe("executor", () => {
    it("executes selected actions and writes history", async () => {
        const found = finding("f1");
        const selected = action("delete", "Delete");
        const results = await executeActions({
            runId,
            dryRun: false,
            items: [{ finding: found, action: selected }],
        });
        expect(results).toHaveLength(1);
        expect(results[0]?.status).toBe("ok");
    });

    it("short-circuits to dry-run when requested", async () => {
        const found = finding("f1");
        let called = false;
        const selected = action("delete", "Delete", async () => {
            called = true;
            return {};
        });
        const results = await executeActions({
            runId,
            dryRun: true,
            items: [{ finding: found, action: selected }],
        });
        expect(called).toBe(false);
        expect(results[0]?.status).toBe("ok");
        expect(results[0]?.actualReclaimedBytes).toBe(100);
    });

    it("marks failures", async () => {
        const found = finding("f1");
        const selected: Action = {
            id: "bad",
            label: "Bad",
            confirm: "none",
            execute: async () => {
                throw new Error("nope");
            },
        };
        const results = await executeActions({
            runId,
            dryRun: false,
            items: [{ finding: found, action: selected }],
        });
        expect(results[0]?.status).toBe("failed");
        expect(results[0]?.error).toContain("nope");
    });
});

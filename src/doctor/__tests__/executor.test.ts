import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Analyzer } from "@app/doctor/lib/analyzer";
import { executeActions } from "@app/doctor/lib/executor";
import { HISTORY_FILE } from "@app/doctor/lib/paths";
import type { Action, ActionResult, Finding, Severity } from "@app/doctor/lib/types";
import { runPlain } from "@app/doctor/ui/plain";
import * as plainFindings from "@app/doctor/ui/plain/findings";
import { executeSelected } from "@app/doctor/ui/tui/App";
import { useEngineStore } from "@app/doctor/ui/tui/stores/engine-store";
import * as trashStaging from "@genesiscz/utils/prompts/clack/trash-staging";

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
        expect(results[0]?.status).toBe("skipped");
        expect(results[0]?.actualReclaimedBytes).toBe(100);
    });

    it("never runs a blocked finding's action, from any caller", async () => {
        const found = finding("vm", "blocked");
        const guarded: Action = {
            id: "delete",
            label: "Delete",
            confirm: "none",
            execute: async () => {
                throw new Error("a blocked finding reached execute");
            },
        };
        const results = await executeActions({ runId, dryRun: false, items: [{ finding: found, action: guarded }] });

        expect(results[0]?.status).toBe("skipped");
        expect(results[0]?.error).toContain("blocked");
    });

    it("still runs a cautious finding's action (negative control)", async () => {
        let ran = false;
        const results = await executeActions({
            runId,
            dryRun: false,
            items: [
                {
                    finding: finding("ok", "cautious"),
                    action: action("delete", "Delete", async () => {
                        ran = true;
                        return {};
                    }),
                },
            ],
        });

        expect(ran).toBe(true);
        expect(results[0]?.status).toBe("ok");
    });

    it.each(["metadata", "severity"])("refuses %s blockers before direct execution", async (kind) => {
        const found = finding("guarded", kind === "severity" ? "blocked" : "cautious");
        found.metadata = { blockers: kind === "metadata" ? ["fixture file has an open writer"] : [] };
        const selected = action("delete", "Delete");
        const consume = spyOn(selected, "execute").mockImplementation(async () => {
            throw new Error("irreversible execution reached");
        });
        try {
            const results = await executeActions({
                runId,
                dryRun: false,
                items: [{ finding: found, action: selected }],
            });
            expect(consume).not.toHaveBeenCalled();
            expect(results[0]).toMatchObject({ status: "skipped", metadata: { blocked: true } });
            if (kind === "metadata") {
                expect(results[0]?.error).toContain("fixture file has an open writer");
            }
        } finally {
            consume.mockRestore();
        }
    });

    for (const route of ["plain", "tui"] as const) {
        it.each(["metadata", "severity", "late-metadata", "allowed"])(
            `${route} Trash staging guards %s at the consuming call`,
            async (kind) => {
                const found = finding("trash-fixture", kind === "severity" ? "blocked" : "cautious");
                found.metadata = {
                    path: "/invented-fixture/cache",
                    blockers: kind === "metadata" ? ["fixture open writer"] : [],
                };
                const selected = { ...action("stage-trash", "Trash"), staged: true };
                found.actions = [selected];
                const trigger = finding("earlier-direct-action");
                trigger.actions = [
                    action("change-state", "Change state", async () => {
                        found.metadata = { ...found.metadata, blockers: ["writer appeared during the earlier action"] };
                        return {};
                    }),
                ];
                const choices = kind === "late-metadata" ? [trigger, found] : [found];
                const pick = spyOn(plainFindings, "selectFindings").mockResolvedValue(choices);
                const confirm = spyOn(plainFindings, "confirmActions").mockResolvedValue(
                    choices.map((entry) => ({ finding: entry, action: entry.actions[0] }))
                );
                const consume = spyOn(
                    trashStaging,
                    route === "plain" ? "stageAndConfirm" : "stageItems"
                ).mockImplementation(async () => {
                    throw new Error("irreversible Trash call reached");
                });
                try {
                    const dispatch = async () => {
                        if (route === "tui") {
                            const store = useEngineStore.getState();
                            store.reset("stub");
                            for (const entry of choices) {
                                store.applyEvent({
                                    type: "finding",
                                    analyzerId: "stub",
                                    finding: entry,
                                    fromCache: false,
                                });
                                store.toggleFinding(entry.id);
                            }
                            await executeSelected({ runId, dryRun: false });
                            return;
                        }
                        const analyzer = new (class extends Analyzer {
                            readonly id = "stub";
                            readonly name = "Fixture";
                            readonly icon = "F";
                            readonly category = "disk";
                            protected async *run(): AsyncIterable<Finding> {
                                yield* choices;
                            }
                        })();
                        await runPlain({
                            analyzers: [analyzer],
                            only: ["stub"],
                            runId,
                            thorough: false,
                            fresh: true,
                            dryRun: false,
                        });
                    };
                    if (kind === "allowed") {
                        await expect(dispatch()).rejects.toThrow("irreversible Trash call reached");
                        expect(consume).toHaveBeenCalledTimes(1);
                        const staged = [
                            { id: found.id, path: "/invented-fixture/cache", bytes: 100, label: found.title },
                        ];
                        expect(consume.mock.calls[0]?.[0]).toEqual(
                            route === "plain" ? { items: staged, summaryTitle: "Staged for permanent delete" } : staged
                        );
                    } else {
                        await dispatch();
                        expect(consume).not.toHaveBeenCalled();
                    }
                } finally {
                    consume.mockRestore();
                    confirm.mockRestore();
                    pick.mockRestore();
                    useEngineStore.getState().reset("");
                }
            }
        );
    }

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

import { describe, expect, it } from "bun:test";
import { mockDashboardClient } from "@/api/mock-client";
import {
    COMMANDS_INTERVAL_MS,
    commandsListQuery,
    createCommand,
    deleteCommand,
    quickCommandsKeys,
    runCommand,
} from "@/features/quick-commands/queries";

describe("quick-commands mock fixtures", () => {
    it("commands.list returns saved snippets", async () => {
        const res = await mockDashboardClient.commands.list();

        expect(res.commands.length).toBeGreaterThan(0);
        expect(res.commands[0]?.id).toBeTruthy();
        expect(res.commands[0]?.command).toBeTruthy();
    });

    it("createCommand echoes the requested label + command", async () => {
        const res = await createCommand(mockDashboardClient, { label: "Lint", command: "bun lint" });

        expect(res.command.label).toBe("Lint");
        expect(res.command.command).toBe("bun lint");
        expect(res.command.id).toBeTruthy();
    });

    it("deleteCommand resolves a removed count", async () => {
        const res = await deleteCommand(mockDashboardClient, "cmd-tests");

        expect(res.removed).toBeGreaterThanOrEqual(0);
    });

    it("runCommand creates a tmux session then attaches it to the target", async () => {
        const res = await runCommand(mockDashboardClient, {
            command: { id: "cmd-tests", label: "Run tests", command: "bun test" },
            target: { mode: "quick_dev_dashboard" },
        });

        expect(res.result.tmuxSessionName).toBeTruthy();
    });
});

describe("quick-commands queryOptions factory", () => {
    it("commandsListQuery has the commands key + interval", () => {
        const q = commandsListQuery(mockDashboardClient);

        expect([...q.queryKey]).toEqual([...quickCommandsKeys.list]);
        expect(q.refetchInterval).toBe(COMMANDS_INTERVAL_MS);
        expect(typeof q.queryFn).toBe("function");
    });

    it("the factory queryFn calls through to the client", async () => {
        const q = commandsListQuery(mockDashboardClient);
        const res = await (q.queryFn as () => Promise<{ commands: unknown[] }>)();

        expect(Array.isArray(res.commands)).toBe(true);
    });
});

import { setupStorageSandbox } from "@app/utils/storage/test-sandbox";

setupStorageSandbox();

import { describe, expect, it } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { jsonlPath } from "@app/task/lib/paths";
import { TaskSessionStore } from "@app/task/lib/session-store";

describe("TaskSessionStore.resolveRunSessionName", () => {
    it("uses requested name when no session files exist", async () => {
        const store = new TaskSessionStore();
        const resolved = await store.resolveRunSessionName("metro-fresh");

        expect(resolved).toEqual({ session: "metro-fresh", requested: "metro-fresh", renamed: false });
    });

    it("suffixes datetime when session jsonl already exists", async () => {
        const store = new TaskSessionStore();
        await store.getSessionsDir();
        writeFileSync(jsonlPath("metro-dup"), '{"type":"meta"}\n');

        const resolved = await store.resolveRunSessionName("metro-dup");

        expect(resolved.requested).toBe("metro-dup");
        expect(resolved.renamed).toBe(true);
        expect(resolved.session).toMatch(/^metro-dup-\d{4}-\d{2}-\d{2}_\d{2}:\d{2}:\d{2}$/);
        expect(resolved.session).not.toBe("metro-dup");
    });

    it("listRelatedSessionNames matches base and collision-suffixed sessions (eval2 bug #6)", async () => {
        const store = new TaskSessionStore();
        await store.getSessionsDir();
        writeFileSync(jsonlPath("eval2-dup"), '{"type":"meta"}\n');
        writeFileSync(jsonlPath("eval2-dup-2026-05-26_14:30:22"), '{"type":"meta"}\n');
        writeFileSync(jsonlPath("eval2-dup-unrelated"), '{"type":"meta"}\n');

        const related = await store.listRelatedSessionNames("eval2-dup-2026-05-26_14:30:22", "eval2-dup");

        expect(related).toEqual(["eval2-dup", "eval2-dup-2026-05-26_14:30:22"]);
        expect(related).not.toContain("eval2-dup-unrelated");
    });

    it("prepareSession does not truncate an existing session", async () => {
        const store = new TaskSessionStore();
        await store.getSessionsDir();
        const existingPath = jsonlPath("metro-keep");
        writeFileSync(existingPath, '{"type":"line","seq":1,"text":"keep me"}\n');

        const resolved = await store.resolveRunSessionName("metro-keep");
        await store.prepareSession({
            name: resolved.session,
            command: "echo hi",
            mode: "pipe",
            cwd: "/tmp",
        });

        expect(existsSync(existingPath)).toBe(true);
        expect(await Bun.file(existingPath).text()).toContain("keep me");
    });

    it("reconcileSessionState reads exit record from jsonl when meta is stale", async () => {
        const store = new TaskSessionStore();
        await store.getSessionsDir();
        const name = "metro-reconcile";
        writeFileSync(
            jsonlPath(name),
            [
                '{"type":"meta","session":"metro-reconcile"}',
                '{"type":"exit","code":0,"durationMs":1200,"ts":"2026-05-26T00:00:00.000Z"}',
            ].join("\n") + "\n"
        );
        await store.prepareSession({
            name,
            command: "echo hi",
            mode: "pipe",
            cwd: "/tmp",
        });

        const reconciled = await store.reconcileSessionState(name);

        expect(reconciled?.exitCode).toBe(0);
        expect(reconciled?.durationMs).toBe(1200);
    });

    it("reconcileSessionState synthesizes meta from jsonl-only sessions", async () => {
        const store = new TaskSessionStore();
        await store.getSessionsDir();
        const name = "dash-artifact";
        writeFileSync(
            jsonlPath(name),
            [
                '{"type":"meta","session":"dash-artifact","command":"test","mode":"pipe","cwd":"/tmp","startedAt":"2026-05-26T00:00:00.000Z"}',
                '{"type":"exit","code":42,"durationMs":500,"ts":"2026-05-26T00:00:01.000Z"}',
            ].join("\n") + "\n"
        );

        const reconciled = await store.reconcileSessionState(name);

        expect(reconciled?.exitCode).toBe(42);
        expect(reconciled?.command).toBe("test");
    });
});

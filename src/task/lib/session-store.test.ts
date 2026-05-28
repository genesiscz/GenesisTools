import { setupStorageSandbox } from "@app/utils/storage/test-sandbox";

setupStorageSandbox();

import { describe, expect, it } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jsonlPath, sessionFilePaths } from "@app/task/lib/paths";
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
        expect(resolved.session).toMatch(/^metro-dup-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/);
        expect(resolved.session).not.toBe("metro-dup");
    });

    it("listRelatedSessionNames matches base and collision-suffixed sessions (eval2 bug #6)", async () => {
        const store = new TaskSessionStore();
        await store.getSessionsDir();
        writeFileSync(jsonlPath("eval2-dup"), '{"type":"meta"}\n');
        writeFileSync(jsonlPath("eval2-dup-2026-05-26_14-30-22"), '{"type":"meta"}\n');
        writeFileSync(jsonlPath("eval2-dup-unrelated"), '{"type":"meta"}\n');

        const related = await store.listRelatedSessionNames("eval2-dup-2026-05-26_14-30-22", "eval2-dup");

        expect(related).toEqual(["eval2-dup", "eval2-dup-2026-05-26_14-30-22"]);
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
            `${[
                '{"type":"meta","session":"metro-reconcile"}',
                '{"type":"exit","code":0,"durationMs":1200,"ts":"2026-05-26T00:00:00.000Z"}',
            ].join("\n")}\n`
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
            `${[
                '{"type":"meta","session":"dash-artifact","command":"test","mode":"pipe","cwd":"/tmp","startedAt":"2026-05-26T00:00:00.000Z"}',
                '{"type":"exit","code":42,"durationMs":500,"ts":"2026-05-26T00:00:01.000Z"}',
            ].join("\n")}\n`
        );

        const reconciled = await store.reconcileSessionState(name);

        expect(reconciled?.exitCode).toBe(42);
        expect(reconciled?.command).toBe("test");
    });
});

describe("TaskSessionStore session reuse helpers", () => {
    it("getLastLineSeq returns max seq from line records", async () => {
        const store = new TaskSessionStore();
        await store.getSessionsDir();
        const name = "reuse-seq";
        writeFileSync(
            jsonlPath(name),
            `${[
                '{"type":"meta","session":"reuse-seq"}',
                '{"type":"line","seq":1,"out":"stdout","ts":1,"text":"a"}',
                '{"type":"line","seq":3,"out":"stdout","ts":2,"text":"b"}',
            ].join("\n")}\n`
        );

        expect(await store.getLastLineSeq(name)).toBe(3);
    });

    it("getLastLineSeq returns 0 when no line records exist", async () => {
        const store = new TaskSessionStore();
        await store.getSessionsDir();
        writeFileSync(jsonlPath("reuse-empty"), '{"type":"meta","session":"reuse-empty"}\n');

        expect(await store.getLastLineSeq("reuse-empty")).toBe(0);
    });

    it("clearSessionLogs truncates log files and removes meta", async () => {
        const store = new TaskSessionStore();
        await store.getSessionsDir();
        const name = "reuse-clear";
        const paths = sessionFilePaths(name);
        writeFileSync(paths.jsonl, '{"type":"line","seq":1,"out":"stdout","ts":1,"text":"old"}\n');
        writeFileSync(paths.uiJsonl, '{"type":"line","seq":1,"text":"old"}\n');
        writeFileSync(paths.stdout, "old\n");
        writeFileSync(paths.stderr, "err\n");
        await store.prepareSession({
            name,
            command: "old",
            mode: "pipe",
            cwd: "/tmp",
        });

        await store.clearSessionLogs(name);

        expect(await Bun.file(paths.jsonl).text()).toBe("");
        expect(await Bun.file(paths.uiJsonl).text()).toBe("");
        expect(await Bun.file(paths.stdout).text()).toBe("");
        expect(await Bun.file(paths.stderr).text()).toBe("");
        expect(existsSync(paths.meta)).toBe(false);
    });

    it("prepareSessionReuseContinue strips exit records and clears exited meta", async () => {
        const store = new TaskSessionStore();
        await store.getSessionsDir();
        const name = "reuse-continue";
        writeFileSync(
            jsonlPath(name),
            `${[
                '{"type":"meta","session":"reuse-continue"}',
                '{"type":"line","seq":2,"out":"stdout","ts":1,"text":"keep"}',
                '{"type":"exit","code":0,"durationMs":100,"ts":"2026-05-26T00:00:00.000Z"}',
            ].join("\n")}\n`
        );
        await store.prepareSession({
            name,
            command: "old",
            mode: "pipe",
            cwd: "/tmp",
        });
        await store.markExited({ name, exitCode: 0, durationMs: 100 });

        await store.prepareSessionReuseContinue({
            name,
            command: "new",
            mode: "pty",
            cwd: "/work",
        });

        const text = await Bun.file(jsonlPath(name)).text();
        expect(text).toContain('"seq":2');
        expect(text).not.toContain('"type":"exit"');

        const meta = await store.getSessionMeta(name);
        expect(meta?.command).toBe("new");
        expect(meta?.mode).toBe("pty");
        expect(meta?.exitCode).toBeUndefined();
        expect(meta?.pid).toBeUndefined();
    });

    it("clearOlderThanSeq removes lines with seq <= threshold from jsonl and ui jsonl", async () => {
        const store = new TaskSessionStore();
        await store.getSessionsDir();
        const name = "reuse-trim";
        const paths = sessionFilePaths(name);
        writeFileSync(
            paths.jsonl,
            `${[
                '{"type":"meta","session":"reuse-trim"}',
                '{"type":"line","seq":1,"out":"stdout","ts":1,"text":"drop"}',
                '{"type":"line","seq":2,"out":"stdout","ts":2,"text":"drop"}',
                '{"type":"line","seq":3,"out":"stdout","ts":3,"text":"keep"}',
            ].join("\n")}\n`
        );
        writeFileSync(
            paths.uiJsonl,
            `${[
                '{"type":"line","seq":1,"text":"drop"}',
                '{"type":"line","seq":2,"text":"drop"}',
                '{"type":"line","seq":3,"text":"keep"}',
            ].join("\n")}\n`
        );

        const removed = await store.clearOlderThanSeq(name, 2);

        expect(removed).toBe(2);
        const records = await Bun.file(paths.jsonl).text();
        expect(records).toContain('"seq":3');
        expect(records).not.toContain('"seq":1');
        expect(records).not.toContain('"seq":2');

        const uiRecords = await Bun.file(paths.uiJsonl).text();
        expect(uiRecords).toContain('"seq":3');
        expect(uiRecords).not.toContain('"seq":1');
    });

    it("listSessionNames ignores dashboard ui jsonl mirrors", async () => {
        const store = new TaskSessionStore();
        const dir = await store.getSessionsDir();
        const name = "list-names-canonical-only";
        writeFileSync(join(dir, `${name}.jsonl`), '{"type":"meta"}\n');
        writeFileSync(join(dir, `${name}.ui.jsonl`), '{"type":"line","seq":1}\n');
        writeFileSync(join(dir, "orphan.ui.jsonl"), '{"type":"line","seq":1}\n');

        const names = await store.listSessionNames();

        expect(names).toContain(name);
        expect(names).not.toContain(`${name}.ui`);
        expect(names).not.toContain("orphan.ui");
    });
});

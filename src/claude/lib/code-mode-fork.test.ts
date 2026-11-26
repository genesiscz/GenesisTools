import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPins, recordPin } from "@genesiscz/utils/agent-sessions/pins";
import { claudeCodeModePin, writeSessionCopy } from "@genesiscz/utils/agent-sessions/readers/claude-fork";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { readProcess } from "@genesiscz/utils/process/processes";
import { checkSessionIntoCodeMode, forkSessionIntoCodeMode, stopClaudeProcesses } from "./code-mode-fork";

const id = "aaaaaaaa-1111-4222-8333-444444444444";
const backupId = "bbbbbbbb-1111-4222-8333-444444444444";
function fixture() {
    const home = mkdtempSync(join(tmpdir(), "fork-recovery-"));
    const directory = join(home, "projects", "-work-shop");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, id + ".jsonl");
    writeFileSync(
        path,
        [
            SafeJSON.stringify({ type: "user", sessionId: id, cwd: "/work/shop", message: { content: "invoice" } }),
            SafeJSON.stringify({ type: "custom-title", sessionId: id, customTitle: "Invoices" }),
            SafeJSON.stringify({ type: "agent-name", sessionId: id, agentName: "Invoices" }),
        ].join("\n") + "\n"
    );
    return { home, path, directory };
}

test("concurrent admissions create one backup and preserve the source account", async () => {
    const { home, path, directory } = fixture();
    await env.testing.withOverrides({ CLAUDE_CONFIG_DIR: home, GENESIS_TOOLS_HOME: home }, async () => {
        await recordPin({
            sessionId: id,
            account: "work",
            auth: "token",
            model: "fixture-model",
            cwd: "/work/shop",
            workspaceId: null,
            source: "manual",
            at: Date.now(),
        });
        const outcomes = await Promise.all([
            forkSessionIntoCodeMode({ session: id, title: "Invoice totals" }),
            forkSessionIntoCodeMode({ session: id, title: "Invoice totals" }),
        ]);
        expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(["forked", "refused"]);
        const moved = outcomes.find((outcome) => outcome.kind === "forked");
        if (moved?.kind !== "forked") {
            throw new Error("fixture did not move");
        }
        expect(readdirSync(directory).filter((name) => name.endsWith(".jsonl"))).toHaveLength(2);
        const pin = (await loadPins({ readOnly: true })).get(moved.plan.backupId);
        expect(pin).toMatchObject({ account: "work", auth: "token", model: "fixture-model" });
        expect(claudeCodeModePin(path)).toBe(true);
        expect((await checkSessionIntoCodeMode({ session: id })).kind).toBe("checked");
    });
});

test("process stop refuses a different process identity and a non-launcher process", async () => {
    const child = Bun.spawn(["/bin/sleep", "20"], { env: process.env, stdout: "ignore", stderr: "ignore" });
    try {
        const start = readProcess(child.pid)?.startMs;
        expect(start).toBeNumber();
        expect(
            await stopClaudeProcesses([child.pid], { expectedStarts: { [child.pid]: -1 }, termMs: 5, killMs: 5 })
        ).toEqual([]);
        expect(readProcess(child.pid)).not.toBeNull();
        if (start === null || start === undefined) {
            throw new Error("fixture process has no start");
        }
        expect(
            await stopClaudeProcesses([child.pid], { expectedStarts: { [child.pid]: start }, termMs: 5, killMs: 5 })
        ).toEqual([]);
        expect(readProcess(child.pid)).not.toBeNull();
    } finally {
        child.kill();
        await child.exited;
    }
});

test("a partial move reuses the published backup and finishes its missing writes", async () => {
    const { home, path, directory } = fixture();
    const backupPath = join(directory, backupId + ".jsonl");
    const plan = {
        sessionId: id,
        sessionPath: path,
        title: "Invoice totals",
        backupId,
        backupPath,
        backupTitle: "Invoices-without-codemode",
    };
    await writeSessionCopy({
        sourceId: id,
        sourcePath: path,
        copyId: backupId,
        copyPath: backupPath,
        title: plan.backupTitle,
    });
    const before = readFileSync(backupPath, "utf8");
    writeFileSync(path + ".codemode-fork.json", SafeJSON.stringify({ plan, complete: false }));
    await env.testing.withOverrides({ CLAUDE_CONFIG_DIR: home, GENESIS_TOOLS_HOME: home }, async () => {
        const outcome = await forkSessionIntoCodeMode({ session: id, title: "Invoice totals" });
        expect(outcome.kind).toBe("forked");
        expect(outcome.kind === "forked" && outcome.plan.backupId).toBe(backupId);
        expect(readFileSync(backupPath, "utf8")).toBe(before);
        expect(claudeCodeModePin(path)).toBe(true);
        expect(readdirSync(directory).filter((name) => name.endsWith(".jsonl"))).toHaveLength(2);
    });
});

import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QaEntry } from "../types";
import { emitObsidian } from "./obsidian";
import { SinkError } from "./types";

const entry: QaEntry = {
    id: "1",
    ts: 1779000000000,
    sessionId: "s",
    sessionTitle: null,
    project: "GenesisTools",
    repoRoot: "/r",
    cwd: "/r",
    branch: "feat/x",
    commitSha: "abc1234",
    commitMessage: "fix things",
    agent: "claude-code",
    isWorktree: false,
    worktreePath: null,
    aiAgent: null,
    agentLabel: null,
    tag: "question",
    question: "why X?",
    answerMd: "Because **Y**.\n\n- point",
    refs: [{ type: "commit", value: "abc1234" }],
    source: "mcp",
    turnUuid: null,
};

const cfg = {
    sinks: { obsidian: true, sound: false, notify: false },
    obsidianPathTemplate: "{project}/Questions/{date}.md",
};

describe("obsidianSink", () => {
    it("appends a full markdown entry under {project}/Questions/{date}.md", async () => {
        const vault = mkdtempSync(join(tmpdir(), "vault-"));
        await emitObsidian(entry, cfg, vault);
        const d = new Date(entry.ts);
        const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const file = join(vault, "GenesisTools", "Questions", `${day}.md`);
        const md = readFileSync(file, "utf8");
        expect(md).toContain("## ");
        expect(md).toContain("why X?");
        expect(md).toContain("Because **Y**.");
        expect(md).toContain("- [ ] reviewed");
        expect(md).toContain("commit:abc1234");
        expect(md).toContain("fix things");
        expect(md).toContain("claude-code");
    });

    it("throws SinkError with a remedy when no vault resolvable", async () => {
        await expect(emitObsidian(entry, cfg, null)).rejects.toThrow(SinkError);
    });

    it("writes off the event loop, so the fan-out timeout can actually bound it", async () => {
        // `runFanOut` races `emit` against a timer. A SYNCHRONOUS write finishes before the race
        // is armed, so the timer is decorative — and a blocked vault volume then outlives the
        // answer claim. Returning a thenable is what makes that budget real.
        const vault = mkdtempSync(join(tmpdir(), "vault-"));
        const pending = emitObsidian(entry, cfg, vault);

        expect(typeof (pending as Promise<void>).then).toBe("function");

        await pending;
    });
});

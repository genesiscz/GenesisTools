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
    it("appends a full markdown entry under {project}/Questions/{date}.md", () => {
        const vault = mkdtempSync(join(tmpdir(), "vault-"));
        emitObsidian(entry, cfg, vault);
        const d = new Date(entry.ts);
        const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const file = join(vault, "GenesisTools", "Questions", `${day}.md`);
        const md = readFileSync(file, "utf8");
        expect(md).toContain("## ");
        expect(md).toContain("why X?");
        expect(md).toContain("Because **Y**.");
        expect(md).toContain("- [ ] reviewed");
        expect(md).toContain("commit:abc1234");
    });

    it("throws SinkError with a remedy when no vault resolvable", () => {
        expect(() => emitObsidian(entry, cfg, null)).toThrow(SinkError);
    });
});

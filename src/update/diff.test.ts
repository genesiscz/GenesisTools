import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpRegistration } from "@app/genesis-tools-mcp/lib/mcp-install";
import {
    diffUpdateSnapshots,
    formatUpdateDiff,
    printUpdateCatalogue,
    readUpdateSnapshot,
    writeUpdateSnapshot,
} from "./diff";
import { genesisAppRefreshAction } from "./genesis-app-refresh";
import { offerMcpRegistration } from "./mcp-registration-offer";

function tempSnapshotPath(): string {
    return join(mkdtempSync(join(tmpdir(), "update-diff-test-")), "snapshot.json");
}

describe("diffUpdateSnapshots", () => {
    const current = {
        version: "2026.10.04.1",
        tools: [
            { name: "ask", description: "Multi-provider LLM chat" },
            { name: "hub", description: "Review hub" },
        ],
        skills: [{ name: "tdd", description: "Test-first workflow" }],
    };

    it("reports no changes on the very first run (no previous snapshot)", () => {
        const diff = diffUpdateSnapshots(undefined, current);

        expect(diff.versionChanged).toBe(false);
        expect(diff.toolsAdded).toEqual([]);
        expect(diff.skillsAdded).toEqual([]);
        expect(diff.hasChanges).toBe(false);
    });

    it("reports a version change", () => {
        const diff = diffUpdateSnapshots(
            { version: "2026.09.04.1", tools: current.tools, skills: current.skills },
            current
        );

        expect(diff.versionChanged).toBe(true);
        expect(diff.previousVersion).toBe("2026.09.04.1");
        expect(diff.currentVersion).toBe("2026.10.04.1");
        expect(diff.hasChanges).toBe(true);
    });

    it("reports a tool added and a tool removed", () => {
        const previous = {
            version: current.version,
            tools: [
                { name: "hub", description: "Review hub" },
                { name: "retired-tool", description: "gone" },
            ],
            skills: current.skills,
        };
        const diff = diffUpdateSnapshots(previous, current);

        expect(diff.toolsAdded).toEqual(["ask"]);
        expect(diff.toolsRemoved).toEqual(["retired-tool"]);
        expect(diff.hasChanges).toBe(true);
    });

    it("reports a tool whose description changed, as changed rather than added", () => {
        const previous = {
            version: current.version,
            tools: [
                { name: "ask", description: "old description" },
                { name: "hub", description: "Review hub" },
            ],
            skills: current.skills,
        };
        const diff = diffUpdateSnapshots(previous, current);

        expect(diff.toolsChanged).toEqual(["ask"]);
        expect(diff.toolsAdded).toEqual([]);
        expect(diff.toolsRemoved).toEqual([]);
    });

    it("reports skill changes the same way as tool changes", () => {
        const previous = { version: current.version, tools: current.tools, skills: [] };
        const diff = diffUpdateSnapshots(previous, current);

        expect(diff.skillsAdded).toEqual(["tdd"]);
        expect(diff.hasChanges).toBe(true);
    });

    it("reports nothing changed when the previous snapshot is byte-for-byte the same", () => {
        const diff = diffUpdateSnapshots(current, current);

        expect(diff.hasChanges).toBe(false);
    });
});

describe("formatUpdateDiff", () => {
    it("renders an empty list when nothing changed", () => {
        const diff = diffUpdateSnapshots(undefined, { version: "v1", tools: [], skills: [] });

        expect(formatUpdateDiff(diff)).toEqual([]);
    });

    it("renders one line per kind of change, in a fixed order", () => {
        const diff = diffUpdateSnapshots(
            { version: "v1", tools: [{ name: "old", description: "d" }], skills: [] },
            { version: "v2", tools: [{ name: "new", description: "d" }], skills: [{ name: "tdd", description: "d" }] }
        );

        expect(formatUpdateDiff(diff)).toEqual([
            "Version: v1 -> v2",
            "Commands added: new",
            "Commands removed: old",
            "Skills added: tdd",
        ]);
    });
});

describe("readUpdateSnapshot / writeUpdateSnapshot", () => {
    it("round-trips a written snapshot", () => {
        const path = tempSnapshotPath();
        const snapshot = { version: "v1", tools: [{ name: "a", description: "b" }], skills: [] };
        writeUpdateSnapshot(snapshot, path);

        expect(readUpdateSnapshot(path)).toEqual(snapshot);
    });

    it("reads undefined when no snapshot exists yet", () => {
        expect(readUpdateSnapshot(tempSnapshotPath())).toBeUndefined();
    });

    // Regression test: PR #456 review — valid JSON of the wrong shape reached diffEntries, which threw
    it("treats a snapshot of the wrong shape as missing", () => {
        const path = tempSnapshotPath();

        writeFileSync(path, "{}\n");
        expect(readUpdateSnapshot(path)).toBeUndefined();

        writeFileSync(path, '{ "version": "v1", "tools": [{ "name": 1 }], "skills": [] }\n');
        expect(readUpdateSnapshot(path)).toBeUndefined();

        writeFileSync(path, '{ "version": 3, "tools": [], "skills": [] }\n');
        expect(readUpdateSnapshot(path)).toBeUndefined();
    });
});

// Regression test: PR #456 review — a --verbose update never wrote the snapshot, so the next normal
// update compared against an older baseline and reported the same changes again
describe("printUpdateCatalogue", () => {
    const previous = { version: "v1", tools: [], skills: [] };
    const current = { version: "v2", tools: [{ name: "alpha", description: "first tool" }], skills: [] };

    it("records the snapshot on a verbose run too, and lists everything", () => {
        const path = tempSnapshotPath();
        writeUpdateSnapshot(previous, path);
        const lines: string[] = [];

        printUpdateCatalogue({ current, verbose: true, println: (line) => lines.push(line), snapshotPath: path });

        expect(readUpdateSnapshot(path)).toEqual(current);
        expect(lines.join("\n")).toContain("Available commands:");
    });

    it("prints only what changed on a normal run, and records the snapshot", () => {
        const path = tempSnapshotPath();
        writeUpdateSnapshot(previous, path);
        const lines: string[] = [];

        printUpdateCatalogue({ current, verbose: false, println: (line) => lines.push(line), snapshotPath: path });

        expect(lines.join("\n")).toContain("Commands added: alpha");
        expect(lines.join("\n")).not.toContain("Available commands:");
        expect(readUpdateSnapshot(path)).toEqual(current);
    });
});

describe("genesisAppRefreshAction", () => {
    it("skips a user who never installed GenesisTools.app", () => {
        expect(genesisAppRefreshAction({ built: false, stale: false })).toBe("skip");
    });

    it("rebuilds an installed app whose sources changed", () => {
        expect(genesisAppRefreshAction({ built: true, stale: true })).toBe("rebuild");
    });

    it("leaves a current, installed app alone", () => {
        expect(genesisAppRefreshAction({ built: true, stale: false })).toBe("skip");
    });
});

function fakeDeps(overrides: { registration?: McpRegistration; isTty?: boolean; confirmAnswer?: boolean } = {}) {
    const calls: string[] = [];
    const logs: string[] = [];
    const deps = {
        registration: async (): Promise<McpRegistration> => {
            calls.push("isRegistered");
            return overrides.registration ?? "not-registered";
        },
        isTty: () => overrides.isTty ?? true,
        confirmRegister: async () => {
            calls.push("confirmRegister");
            return overrides.confirmAnswer ?? true;
        },
        register: async () => {
            calls.push("register");
        },
        log: (message: string) => {
            calls.push("log");
            logs.push(message);
        },
    };

    return { deps, calls, logs };
}

describe("offerMcpRegistration", () => {
    it("does nothing once the server is already registered", async () => {
        const { deps, calls } = fakeDeps({ registration: "registered" });
        await offerMcpRegistration(deps);

        expect(calls).toEqual(["isRegistered"]);
    });

    it("prints one hint line and never prompts without a TTY", async () => {
        const { deps, calls, logs } = fakeDeps({ isTty: false });
        await offerMcpRegistration(deps);

        expect(calls).toEqual(["isRegistered", "log"]);
        expect(logs[0]).toContain("tools genesis-tools-mcp install");
    });

    it("never registers when the answer is no", async () => {
        const { deps, calls } = fakeDeps({ confirmAnswer: false });
        await offerMcpRegistration(deps);

        expect(calls).toEqual(["isRegistered", "confirmRegister"]);
    });

    it("registers when the answer is yes", async () => {
        const { deps, calls } = fakeDeps();
        await offerMcpRegistration(deps);

        expect(calls).toEqual(["isRegistered", "confirmRegister", "register"]);
    });

    it("never throws when registration itself fails", async () => {
        const { deps, calls, logs } = fakeDeps();
        deps.register = async () => {
            calls.push("register");
            throw new Error("claude plugin install failed");
        };

        await expect(offerMcpRegistration(deps)).resolves.toBeUndefined();

        expect(calls).toEqual(["isRegistered", "confirmRegister", "register", "log"]);
        expect(logs.at(-1)).toContain("claude plugin install failed");
    });

    // Regression test: PR #456 review — an unreadable ~/.claude.json rejected the check, which sat
    // outside every handler and stopped the whole update after the pull
    it("keeps going with the install hint when the registration check itself fails", async () => {
        const { deps, calls, logs } = fakeDeps();
        deps.registration = async () => {
            calls.push("isRegistered");
            throw new Error("Unexpected token in the Claude config");
        };

        await expect(offerMcpRegistration(deps)).resolves.toBeUndefined();

        expect(calls).toEqual(["isRegistered", "log"]);
        expect(logs[0]).toContain("Unexpected token in the Claude config");
        expect(logs[0]).toContain("tools genesis-tools-mcp install");
    });

    // Regression test: PR #456 review round 4 — with no Claude config the offer asked anyway, and the
    // install then refused because there was no config file to register in
    it("tells the user to start Claude Code first, and never prompts, when Claude has no config", async () => {
        const { deps, calls, logs } = fakeDeps({ registration: "no-config" });
        await offerMcpRegistration(deps);

        expect(calls).toEqual(["isRegistered", "log"]);
        expect(logs[0]).toContain("Start Claude Code once");
        expect(logs[0]).toContain("tools genesis-tools-mcp install");
    });
});

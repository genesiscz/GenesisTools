import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sessionPaths } from "@app/agents/lib/paths";
import { env } from "@genesiscz/utils/env";
import { parseWritePolicy, resolveWritableRoots, resolveWritePolicy } from "./spawn";

describe("resolveWritePolicy", () => {
    test("defaults to a read-only reviewer", () => {
        expect(resolveWritePolicy()).toEqual({
            writePolicy: "deny",
            sandbox: "read-only",
            approvalPolicy: "never",
        });
    });

    test("maps allow and ask to workspace-write with different approvals", () => {
        expect(resolveWritePolicy("allow")).toEqual({
            writePolicy: "allow",
            sandbox: "workspace-write",
            approvalPolicy: "never",
        });
        expect(resolveWritePolicy("ask")).toEqual({
            writePolicy: "ask",
            sandbox: "workspace-write",
            approvalPolicy: "untrusted",
        });
    });

    test("rejects unknown write policies instead of silently using deny", () => {
        expect(parseWritePolicy(undefined)).toBeUndefined();
        expect(parseWritePolicy("ask")).toBe("ask");
        expect(() => parseWritePolicy("sometimes")).toThrow("--write must be ask, allow, or deny");
    });

    test("keeps explicit deny read-only", () => {
        expect(resolveWritePolicy("deny")).toEqual({
            writePolicy: "deny",
            sandbox: "read-only",
            approvalPolicy: "never",
        });
    });
});

describe("resolveWritableRoots", () => {
    test("grants one agents session without exposing unrelated durable tool state", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-writable-roots-"));
        const explicit = join(home, "explicit");

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, () => {
            const roots = resolveWritableRoots({
                requested: [explicit],
                agentsEnabled: true,
                sandbox: "workspace-write",
                rendezvousSession: "parent-session",
            });
            const selected = sessionPaths("parent-session");

            expect(roots).toEqual([resolve(explicit), selected.sessionDir]);
            expect(existsSync(selected.sessionDir)).toBe(true);
            expect(existsSync(selected.slotsDir)).toBe(true);
            expect(roots).not.toContain(join(home, ".genesis-tools"));
            expect(roots).not.toContain(join(home, ".genesis-tools", "ai"));
            expect(roots).not.toContain(join(home, ".genesis-tools", "security"));
            expect(roots).not.toContain(join(home, ".genesis-tools", "plugins"));
            expect(roots).not.toContain(sessionPaths("other-session").sessionDir);
        });
    });

    test("does not add an implicit root for read-only or agents-disabled workers", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-writable-roots-control-"));
        const explicit = join(home, "explicit");

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, () => {
            expect(
                resolveWritableRoots({
                    requested: [explicit],
                    agentsEnabled: true,
                    sandbox: "read-only",
                    rendezvousSession: "parent-session",
                })
            ).toEqual([resolve(explicit)]);
            expect(
                resolveWritableRoots({
                    requested: [explicit],
                    agentsEnabled: false,
                    sandbox: "workspace-write",
                })
            ).toEqual([resolve(explicit)]);
        });
    });
});

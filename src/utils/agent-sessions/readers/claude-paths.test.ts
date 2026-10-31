import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { ACCOUNT_PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/alias-list";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";
import { SafeJSON } from "@genesiscz/utils/json";
import { resolveHistoryProvider } from "../provider";
import type { NativeSessionSource } from "../types";
import { claudeNativeId, claudeProjectDirectory, claudeProjectName, isClaudeSubagentPath } from "./claude-paths";

function source(root: string, filePath: string): NativeSessionSource<"claude"> {
    return { kind: "claude", root, sourceHome: root, filePath, dataPaths: [filePath], metadataPaths: [] };
}

test("project-scoped and flat roots never use the transcript filename as an encoded project", () => {
    const scoped = source("/fixture/projects/-projects-shop", "/fixture/projects/-projects-shop/session.jsonl");
    expect(claudeProjectDirectory(scoped)).toBe("-projects-shop");
    const flat = source("/fixture/sources", "/fixture/sources/session.jsonl");
    expect(claudeProjectDirectory(flat)).toBeUndefined();
    expect(claudeProjectName({ source: flat, cwd: "/projects/shop" })).toBe("shop");
    expect(claudeProjectName({ source: flat })).toBeNull();
    expect(isClaudeSubagentPath("/fixture/sources/agent-helper.jsonl")).toBe(true);
    expect(isClaudeSubagentPath("/fixture/subagents/helper.jsonl")).toBe(true);
    expect(isClaudeSubagentPath("/fixture/sources/session.jsonl")).toBe(false);
    expect(claudeNativeId(source("/fixture/projects", "/fixture/projects/-shop/session.jsonl"))).toBe("session");
    expect(claudeNativeId(source("/fixture/projects", "/fixture/projects/-shop/parent/subagents/agent-a.jsonl"))).toBe(
        "-shop/parent/subagents/agent-a"
    );
});

test("the sub-agent path test answers as the segment split it replaced", () => {
    const split = (path: string) => path.split(sep).includes("subagents") || basename(path).startsWith("agent-");
    const paths = [
        "subagents",
        `subagents${sep}agent.jsonl`,
        `${sep}fixture${sep}subagents`,
        `${sep}fixture${sep}subagents${sep}helper.jsonl`,
        `${sep}fixture${sep}mysubagents${sep}helper.jsonl`,
        `${sep}fixture${sep}subagents-old${sep}helper.jsonl`,
        `${sep}fixture${sep}sub${sep}agents${sep}helper.jsonl`,
        `${sep}fixture${sep}agent-dir${sep}`,
        `${sep}fixture${sep}project${sep}agent-a1.jsonl`,
        `${sep}fixture${sep}project${sep}session.jsonl`,
        "",
    ];
    for (const path of paths) {
        expect([path, isClaudeSubagentPath(path)]).toEqual([path, split(path)]);
    }
});

interface PathCase {
    harness: string;
    path: string;
    expect: unknown;
}

function isPathCase(value: unknown): value is PathCase {
    return (
        typeof value === "object" &&
        value !== null &&
        "harness" in value &&
        typeof value.harness === "string" &&
        "path" in value &&
        typeof value.path === "string" &&
        "expect" in value
    );
}

/** The shared path fixtures: every harness's reader classifies each case as the file says (`fixtures/session-paths.json`). */
describe("classifyPath against the shared session-path fixtures", () => {
    const fixtures: unknown = SafeJSON.parse(
        readFileSync(join(moduleDir(import.meta), "fixtures", "session-paths.json"), "utf8"),
        { strict: true }
    );
    const raw: unknown[] =
        typeof fixtures === "object" && fixtures !== null && "cases" in fixtures && Array.isArray(fixtures.cases)
            ? fixtures.cases
            : [];
    const cases = raw.filter(isPathCase);

    test("the fixture file holds only well-formed cases, for every harness", () => {
        expect(cases.length).toBe(raw.length);
        expect([...new Set(cases.map((entry) => entry.harness))].sort()).toEqual([...ACCOUNT_PROVIDER_ALIASES].sort());
    });

    for (const entry of cases) {
        test(`${entry.harness} ${entry.path}`, () => {
            const role: unknown = resolveHistoryProvider(entry.harness).reader.classifyPath(entry.path);
            expect(role).toEqual(entry.expect);
        });
    }
});

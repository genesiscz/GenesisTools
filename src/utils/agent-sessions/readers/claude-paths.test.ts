import { expect, test } from "bun:test";
import { basename, sep } from "node:path";
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

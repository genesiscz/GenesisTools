import { expect, test } from "bun:test";
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

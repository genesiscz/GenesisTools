import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@genesiscz/utils/agent-sessions/types";
import { resolveLaunchCwd } from "./launch";

/**
 * The directory a resumed session opens in, for every coding-agent tool.
 *
 * Claude's own resume has carried this fallback for a while and the shared path gained it with
 * the first stage of the parity work; nothing pinned it there. 629 of 1,617 indexed sessions on
 * this machine (39%) name a directory that is gone, and `Bun.spawn` rejects a missing cwd with
 * an ENOENT that names the SHELL binary rather than the directory, so a regression here reads
 * as a broken shell for more than a third of all sessions.
 */

const session = (cwd: string): AgentSession => ({
    kind: "codex",
    sessionId: "aaaa1111",
    title: "Invoice work",
    cwd,
    mtime: new Date(0),
    filePath: "/sessions/aaaa1111.jsonl",
});

test("a resumed session opens in its own directory when that directory still exists", () => {
    const live = mkdtempSync(join(tmpdir(), "gt-launch-cwd-"));

    expect(resolveLaunchCwd(session(live), "/somewhere/else")).toBe(live);
});

test("a removed directory falls back to the requested one instead of failing the spawn", () => {
    const live = mkdtempSync(join(tmpdir(), "gt-launch-cwd-"));
    const gone = join(live, "removed-worktree");

    expect(resolveLaunchCwd(session(gone), live)).toBe(live);
});

test("no session and no recorded directory both keep the requested one", () => {
    const live = mkdtempSync(join(tmpdir(), "gt-launch-cwd-"));

    expect(resolveLaunchCwd(undefined, live)).toBe(live);
    expect(resolveLaunchCwd(session(""), live)).toBe(live);
    expect(resolveLaunchCwd(session(live), live)).toBe(live);
});

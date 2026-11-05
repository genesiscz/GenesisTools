import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeCompactHistorySchema } from "@genesiscz/utils/agent-sessions/migrations";
import { failureCaller } from "@genesiscz/utils/cli/failures/caller";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { genesisToolsDirIn } from "@genesiscz/utils/storage/root";
import { resolveAgentHost } from "./host";
import {
    callerCwd,
    currentCaller,
    gatherHarnessPoster,
    getAgentRuntimeContext,
    gitCommonRoot,
    runAsCaller,
} from "./runtime";

describe("characterization: host, runtime, poster and failure caller agree on identity", () => {
    const layout = {
        cwd: "/fixture/repo/sub",
        repoRoot: "/fixture/repo",
        project: "repo",
        isWorktree: false,
        worktreePath: null,
        branch: null,
        commitSha: null,
        commitMessage: null,
    };
    const cases = [
        {
            name: "Claude",
            vars: { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "c1", AI_AGENT: "label" },
            agent: "claude-code",
            sessionId: "c1",
            label: "label",
        },
        {
            name: "Codex",
            vars: { CODEX_CI: "1", CODEX_THREAD_ID: "x1", AI_AGENT: "label" },
            agent: "codex",
            sessionId: "x1",
            label: null,
        },
        {
            name: "Grok",
            vars: { GROK_SESSION_ID: "g1", AI_AGENT: "label" },
            agent: "grok",
            sessionId: "g1",
            label: "label",
        },
        {
            name: "Copilot",
            vars: { COPILOT_AGENT_SESSION_ID: "p1", AI_AGENT: "label" },
            agent: "copilot",
            sessionId: "p1",
            label: "label",
        },
        { name: "none", vars: { AI_AGENT: "label" }, agent: "unknown", sessionId: null, label: "label" },
    ] as const;
    for (const row of cases) {
        it(`${row.name}: compares the same environment across gatherers`, () => {
            const runtime = getAgentRuntimeContext(layout, row.vars);
            const poster = gatherHarnessPoster(layout, row.vars);
            const failure = failureCaller({ context: runtime, processEnv: row.vars, home: "/fixture/missing" });
            expect(resolveAgentHost(row.vars)).toMatchObject({ agent: row.agent, sessionId: row.sessionId });
            expect(runtime).toMatchObject({
                agent: row.agent,
                sessionId: row.sessionId,
                aiAgent: row.label,
                ...layout,
            });
            expect(poster).toEqual(runtime);
            expect(failure).toMatchObject({
                agent: row.agent,
                sessionId: row.sessionId,
                aiAgent: "label",
                project: "repo",
                repoRoot: "/fixture/repo",
            });
            expect(failure).not.toHaveProperty("cwd");
        });
    }
});

function git(args: string[], cwd: string): void {
    const r = Bun.spawnSync(["git", "-c", "user.email=t@t.t", "-c", "user.name=t", ...args], {
        env: process.env,
        cwd,
        stdout: "pipe",
        stderr: "pipe",
    });
    if (r.exitCode !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
    }
}

/** A main checkout with one linked worktree, so repoRoot/worktree claims are real. */
function makeRepo(): { main: string; worktree: string; deep: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-runtime-")));
    const main = join(root, "MainRepo");
    mkdirSync(main);
    git(["init", "-q", "-b", "main"], main);
    Bun.write(join(main, "README.md"), "x");
    git(["add", "-A"], main);
    git(["commit", "-qm", "init"], main);

    const deep = join(main, "src", "deep");
    mkdirSync(deep, { recursive: true });

    const worktree = join(root, "wt");
    git(["worktree", "add", "-q", "-b", "feat/x", worktree], main);
    return { main, worktree, deep };
}

describe("getAgentRuntimeContext", () => {
    it("detects claude-code from CLAUDE_CODE_SESSION_ID + reads git/project", () => {
        const ctx = getAgentRuntimeContext({}, { CLAUDE_CODE_SESSION_ID: "sess-123", CLAUDECODE: "1" });
        expect(ctx.agent).toBe("claude-code");
        expect(ctx.sessionId).toBe("sess-123");
        expect(ctx.isInAgent).toBe(true);
        expect(typeof ctx.project).toBe("string");
        expect(ctx.project.length).toBeGreaterThan(0);
        expect(ctx.commitMessage === null || typeof ctx.commitMessage === "string").toBe(true);
    });

    it("honors explicit overrides over env", () => {
        const ctx = getAgentRuntimeContext(
            { sessionId: "override", project: "Foo" },
            { CLAUDE_CODE_SESSION_ID: "env" }
        );
        expect(ctx.sessionId).toBe("override");
        expect(ctx.project).toBe("Foo");
    });

    it("agent=unknown when no agent env present", () => {
        const ctx = getAgentRuntimeContext({}, {});
        expect(ctx.agent).toBe("unknown");
        expect(ctx.sessionId).toBeNull();
    });

    it("detects codex from CODEX_CI and reads CODEX_THREAD_ID as sessionId", () => {
        const ctx = getAgentRuntimeContext({}, { CODEX_CI: "1", CODEX_THREAD_ID: "thr-42" });
        expect(ctx.agent).toBe("codex");
        expect(ctx.sessionId).toBe("thr-42");
        expect(ctx.isInAgent).toBe(true);
    });

    it("codex detected via CODEX_THREAD_ID even if CODEX_CI absent", () => {
        const ctx = getAgentRuntimeContext({}, { CODEX_THREAD_ID: "thr-9" });
        expect(ctx.agent).toBe("codex");
        expect(ctx.sessionId).toBe("thr-9");
    });

    it("detects grok from GROK_SESSION_ID", () => {
        const ctx = getAgentRuntimeContext({}, { GROK_SESSION_ID: "01a048de-25a9-7052-bbb8-46f8ae503f43" });
        expect(ctx.agent).toBe("grok");
        expect(ctx.sessionId).toBe("01a048de-25a9-7052-bbb8-46f8ae503f43");
        expect(ctx.isInAgent).toBe(true);
    });

    it("detects GitHub Copilot CLI from COPILOT_AGENT_SESSION_ID", () => {
        // Copilot puts its own --session-id into every child's environment; the
        // uuid below is the one observed live in the MCP server on 2026-08-31.
        const ctx = getAgentRuntimeContext({}, { COPILOT_AGENT_SESSION_ID: "3bf1c496-8e82-4cb6-b688-bf65fd3d250a" });
        expect(ctx.agent).toBe("copilot");
        expect(ctx.sessionId).toBe("3bf1c496-8e82-4cb6-b688-bf65fd3d250a");
        expect(ctx.isInAgent).toBe(true);
    });

    it("the inherited outer host wins when two are present", () => {
        // grok launched from a Claude Code shell inherits CLAUDE_CODE_SESSION_ID.
        const ctx = getAgentRuntimeContext({}, { CLAUDE_CODE_SESSION_ID: "sess-1", GROK_SESSION_ID: "grok-1" });
        expect(ctx.agent).toBe("claude-code");
        expect(ctx.sessionId).toBe("sess-1");
    });
});

describe("getAgentRuntimeContext — caller scope (resident server)", () => {
    it("takes harness, session and cwd from the caller, not from the process env", async () => {
        const { main, worktree } = makeRepo();
        const caller = { agent: "claude-code" as const, sessionId: "caller-a", cwd: worktree };
        const ctx = await runAsCaller(caller, async () => {
            await Promise.resolve();
            return getAgentRuntimeContext({}, { GROK_SESSION_ID: "process-env" });
        });
        expect(ctx.agent).toBe("claude-code");
        expect(ctx.sessionId).toBe("caller-a");
        expect(ctx.cwd).toBe(worktree);
        expect(ctx.repoRoot).toBe(main);
        expect(runAsCaller(caller, () => callerCwd())).toBe(worktree);
    });

    it("keeps two concurrent callers apart", async () => {
        const { main, deep } = makeRepo();
        const [a, b] = await Promise.all([
            runAsCaller(
                {
                    agent: "claude-code",
                    sessionId: "caller-a",
                    cwd: main,
                    sourceMessage: { messageId: "native-message-a" },
                },
                async () => {
                    await Bun.sleep(5);
                    return getAgentRuntimeContext({}, {});
                }
            ),
            runAsCaller({ agent: "codex", sessionId: null, cwd: deep }, async () => getAgentRuntimeContext({}, {})),
        ]);
        expect([a.sessionId, a.cwd, a.agent]).toEqual(["caller-a", main, "claude-code"]);
        expect([b.sessionId, b.cwd, b.agent]).toEqual([null, deep, "codex"]);
        expect(a.sourceMessage).toEqual({ messageId: "native-message-a" });
        expect(b.sourceMessage).toBeUndefined();
        const retargeted = runAsCaller(
            {
                agent: "claude-code",
                sessionId: "caller-a",
                cwd: main,
                sourceMessage: { messageId: "native-message-a" },
            },
            () => getAgentRuntimeContext({ agent: "codex", sessionId: "caller-b" }, {})
        );
        expect(retargeted.sourceMessage).toBeUndefined();
    });

    it("leaves the process env in charge outside a scope", () => {
        expect(currentCaller()).toBeUndefined();
        expect(getAgentRuntimeContext({}, { GROK_SESSION_ID: "g-1" }).sessionId).toBe("g-1");
        expect(callerCwd()).toBe(process.cwd());
    });
});

describe("getAgentRuntimeContext — git identity", () => {
    it("reports a linked worktree against the main checkout", () => {
        const { main, worktree } = makeRepo();
        const ctx = getAgentRuntimeContext({ cwd: worktree }, {});
        expect(ctx.isWorktree).toBe(true);
        expect(ctx.worktreePath).toBe(worktree);
        expect(ctx.repoRoot).toBe(main);
        expect(ctx.project).toBe("MainRepo");
        expect(ctx.branch).toBe("feat/x");
    });

    it("names the project after the repo, not the subdirectory the session sits in", () => {
        const { main, deep } = makeRepo();
        const ctx = getAgentRuntimeContext({ cwd: deep }, {});
        expect(ctx.isWorktree).toBe(false);
        expect(ctx.worktreePath).toBeNull();
        expect(ctx.repoRoot).toBe(main);
        expect(ctx.project).toBe("MainRepo");
        expect(ctx.branch).toBe("main");
    });

    it("falls back to the directory itself outside any repo", () => {
        const outside = realpathSync(mkdtempSync(join(tmpdir(), "no-repo-")));
        const ctx = getAgentRuntimeContext({ cwd: outside }, {});
        expect(ctx.isWorktree).toBe(false);
        expect(ctx.repoRoot).toBe(outside);
        expect(ctx.branch).toBeNull();
    });
});

describe("gitCommonRoot", () => {
    it("gives one repo ONE identity, reached directly or through a symlink", () => {
        // PR #343 review t1 round 13. `resolveAncestorCwd` canonicalises its
        // paths on purpose — the kernel reports /private/tmp where process.cwd()
        // keeps /tmp — so a lexically-resolved common dir compared against a
        // canonical one made the same repository look like two, which rejected
        // the live ancestor cwd and reinstated the stale-cwd bug.
        const { main } = makeRepo();
        const linkDir = realpathSync(mkdtempSync(join(tmpdir(), "agent-runtime-link-")));
        const link = join(linkDir, "AliasRepo");
        symlinkSync(main, link);

        const direct = gitCommonRoot(main);
        const viaLink = gitCommonRoot(link);

        expect(direct).toBeTruthy();
        expect(viaLink).toBe(direct);
    });

    it("a genuinely different repo still gets a different identity", () => {
        // The negative control: canonicalising must not collapse two repos into
        // one, which would let an unrelated ancestor cwd be adopted.
        const a = makeRepo();
        const b = makeRepo();

        expect(gitCommonRoot(a.main)).not.toBe(gitCommonRoot(b.main));
    });

    it("a linked worktree shares the main checkout's identity", () => {
        // The property the comparison exists for.
        const { main, worktree } = makeRepo();

        expect(gitCommonRoot(worktree)).toBe(gitCommonRoot(main));
    });

    it("is null outside any repository", () => {
        const outside = realpathSync(mkdtempSync(join(tmpdir(), "no-repo-")));

        expect(gitCommonRoot(outside)).toBeNull();
    });
});

it("retains a historical cwd when the checkout has been removed", () => {
    const cwd = join(mkdtempSync(join(tmpdir(), "agent-origin-")), "removed-checkout");
    const context = getAgentRuntimeContext({ cwd, sessionId: "historical-session" }, {});
    expect(context.cwd).toBe(cwd);
    expect(context.sessionId).toBe("historical-session");
    expect(context.branch).toBeNull();
    expect(context.commitSha).toBeNull();
});

// Characterization tests (2026-11-04): they pin what the gatherer answers today, before the agent-context
// gatherers are unified. A change in an answer here is a decision to make, not a test to adjust.
describe("characterization: which host answers", () => {
    it("Claude with only its session id is claude-code but not isInAgent: that flag follows CLAUDECODE alone", () => {
        const ctx = getAgentRuntimeContext({}, { CLAUDE_CODE_SESSION_ID: "sess-only" });
        expect(ctx.agent).toBe("claude-code");
        expect(ctx.sessionId).toBe("sess-only");
        expect(ctx.isInAgent).toBe(false);
    });

    it("Codex started inside Claude: the outer Claude host wins, and the Codex thread id is not used", () => {
        const ctx = getAgentRuntimeContext(
            {},
            { CLAUDE_CODE_SESSION_ID: "claude-outer", CLAUDECODE: "1", CODEX_CI: "1", CODEX_THREAD_ID: "thr-inner" }
        );
        expect(ctx.agent).toBe("claude-code");
        expect(ctx.sessionId).toBe("claude-outer");
        expect(ctx.isInAgent).toBe(true);
    });

    it("Claude started inside Codex still reads as Codex only while no Claude variable is set", () => {
        expect(getAgentRuntimeContext({}, { CODEX_CI: "1", CODEX_THREAD_ID: "thr-1" }).agent).toBe("codex");
        expect(getAgentRuntimeContext({}, { CODEX_THREAD_ID: "thr-1", CLAUDECODE: "1" }).agent).toBe("claude-code");
    });

    it("with no agent env the agent is unknown, isInAgent is false and nothing names a session", () => {
        const ctx = getAgentRuntimeContext({}, {});
        expect(ctx.agent).toBe("unknown");
        expect(ctx.isInAgent).toBe(false);
        expect(ctx.sessionId).toBeNull();
        expect(ctx.sessionTitle).toBeNull();
        expect(ctx.aiAgent).toBeNull();
    });

    it("AI_AGENT is the aiAgent of Claude, Grok and an unknown host, and never of Codex", () => {
        expect(getAgentRuntimeContext({}, { CLAUDECODE: "1", AI_AGENT: "label" }).aiAgent).toBe("label");
        expect(getAgentRuntimeContext({}, { GROK_SESSION_ID: "g1", AI_AGENT: "label" }).aiAgent).toBe("label");
        expect(getAgentRuntimeContext({}, { AI_AGENT: "label" }).aiAgent).toBe("label");
        expect(getAgentRuntimeContext({}, { CODEX_CI: "1", AI_AGENT: "label" }).aiAgent).toBeNull();
    });

    it("a caller scope replaces the env host completely, an unknown caller included", () => {
        const processEnv = { CLAUDE_CODE_SESSION_ID: "env-session", CLAUDECODE: "1", AI_AGENT: "label" };
        const ctx = runAsCaller({ agent: "unknown", sessionId: null, cwd: process.cwd() }, () =>
            getAgentRuntimeContext({}, processEnv)
        );
        expect(ctx.agent).toBe("unknown");
        expect(ctx.sessionId).toBeNull();
        expect(ctx.isInAgent).toBe(false);
        expect(ctx.aiAgent).toBeNull();
    });

    it("a caller scope with a Codex agent and no session reports isInAgent and a null session", () => {
        const ctx = runAsCaller({ agent: "codex", sessionId: null, cwd: process.cwd() }, () =>
            getAgentRuntimeContext({}, { CLAUDE_CODE_SESSION_ID: "env-session" })
        );
        expect(ctx.agent).toBe("codex");
        expect(ctx.sessionId).toBeNull();
        expect(ctx.isInAgent).toBe(true);
    });

    it("an override of the cwd beats the caller's cwd", () => {
        const { main, worktree } = makeRepo();
        const ctx = runAsCaller({ agent: "codex", sessionId: "c1", cwd: main }, () =>
            getAgentRuntimeContext({ cwd: worktree }, {})
        );
        expect(ctx.cwd).toBe(worktree);
        expect(ctx.branch).toBe("feat/x");
    });
});

describe("characterization: git facts", () => {
    it("reads the short sha and the subject of the last commit, and the branch of the main checkout", () => {
        const { main } = makeRepo();
        const ctx = getAgentRuntimeContext({ cwd: main }, {});
        expect(ctx.commitMessage).toBe("init");
        expect(ctx.commitSha).toMatch(/^[0-9a-f]{7,}$/);
        expect(ctx.branch).toBe("main");
        expect(ctx.isWorktree).toBe(false);
    });

    it("a linked worktree reads its own commit data, not the main checkout's", () => {
        const { main, worktree } = makeRepo();
        git(["commit", "-q", "--allow-empty", "-m", "second in main"], main);
        const inMain = getAgentRuntimeContext({ cwd: main }, {});
        const inWorktree = getAgentRuntimeContext({ cwd: worktree }, {});
        expect(inMain.commitMessage).toBe("second in main");
        expect(inWorktree.commitMessage).toBe("init");
        expect(inWorktree.commitSha).not.toBe(inMain.commitSha);
    });

    it("a fact the overrides carry is taken as given, even when git says otherwise", () => {
        const { main } = makeRepo();
        const ctx = getAgentRuntimeContext({ cwd: main, branch: "given", commitMessage: null }, {});
        expect(ctx.branch).toBe("given");
        expect(ctx.commitMessage).toBeNull();
        expect(ctx.commitSha).toMatch(/^[0-9a-f]{7,}$/);
    });
});

/**
 * The cwd of the nearest ancestor that moved is adopted only when it shares our `.git`. The kernel is the only
 * source of an ancestor's cwd, so this runs a real chain: the outer shell sits in `ancestorCwd`, and the process
 * under test (a child of that shell) starts in `ownCwd`.
 */
function sessionCwdSeenFromChain(ownCwd: string, ancestorCwd: string): string {
    const script = join(mkdtempSync(join(tmpdir(), "agent-runtime-chain-")), "probe.ts");
    const runtime = join(import.meta.dir, "runtime.ts");
    writeFileSync(
        script,
        `import { getAgentRuntimeContext } from ${SafeJSON.stringify(runtime)};\nconsole.log(getAgentRuntimeContext({}, {}).cwd);\n`
    );
    const r = Bun.spawnSync(
        [
            "/bin/sh",
            "-c",
            'cd "$1"; ( cd "$2"; exec "$3" "$4" ); exit $?',
            "sh",
            ancestorCwd,
            ownCwd,
            process.execPath,
            script,
        ],
        { env: process.env, stdout: "pipe", stderr: "pipe" }
    );

    if (r.exitCode !== 0) {
        throw new Error(`chain probe failed: ${r.stderr.toString()}`);
    }

    return r.stdout.toString().trim();
}

describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "characterization: the session cwd is an ancestor's, when it shares our .git",
    () => {
        it("adopts the cwd of an ancestor that sits in another worktree of the same repository", () => {
            const { main, worktree } = makeRepo();
            expect(sessionCwdSeenFromChain(main, worktree)).toBe(worktree);
        });

        it("keeps our own cwd when the ancestor sits in another repository", () => {
            const mine = makeRepo();
            const other = makeRepo();
            expect(sessionCwdSeenFromChain(mine.main, other.main)).toBe(mine.main);
        });

        it("keeps our own cwd when the ancestor sits outside any repository", () => {
            const { main } = makeRepo();
            const outside = realpathSync(mkdtempSync(join(tmpdir(), "no-repo-")));
            expect(sessionCwdSeenFromChain(main, outside)).toBe(main);
        });
    }
);

describe("characterization: the session title comes from the history cache", () => {
    function historyHome(rows: { provider: string; nativeId: string; title: string | null; summary: string | null }[]) {
        const home = realpathSync(mkdtempSync(join(tmpdir(), "agent-title-home-")));
        const path = genesisToolsDirIn(home, "claude-history", "index.db");
        mkdirSync(join(home, ".genesis-tools", "claude-history"), { recursive: true });
        const db = new Database(path);
        initializeCompactHistorySchema(db);
        const insert = db.prepare(
            "INSERT INTO session_metadata(source_key,provider,native_id,file_path,session_id,custom_title,summary,mtime,is_subagent) VALUES (?,?,?,?,?,?,?,?,?)"
        );

        for (const [index, row] of rows.entries()) {
            insert.run(
                `k${index}`,
                row.provider,
                row.nativeId,
                `/fixture/${index}.jsonl`,
                row.nativeId,
                row.title,
                row.summary,
                1,
                0
            );
        }

        db.close();
        return home;
    }

    it("Claude takes the custom title of its anthropic-sub row, else the summary", async () => {
        const home = historyHome([
            { provider: "anthropic-sub", nativeId: "titled", title: "Named by the user", summary: "A summary" },
            { provider: "anthropic-sub", nativeId: "summed", title: null, summary: "Only a summary" },
        ]);

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, () => {
            const titled = getAgentRuntimeContext({}, { CLAUDE_CODE_SESSION_ID: "titled" });
            const summed = getAgentRuntimeContext({}, { CLAUDE_CODE_SESSION_ID: "summed" });
            expect(titled.sessionTitle).toBe("Named by the user");
            expect(summed.sessionTitle).toBe("Only a summary");
        });
    });

    it("Codex and Grok read their own provider's rows, and a Claude row does not answer for them", async () => {
        const home = historyHome([
            { provider: "openai-sub", nativeId: "shared", title: "Codex title", summary: null },
            { provider: "grok-sub", nativeId: "shared", title: "Grok title", summary: null },
        ]);

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, () => {
            expect(getAgentRuntimeContext({}, { CODEX_THREAD_ID: "shared" }).sessionTitle).toBe("Codex title");
            expect(getAgentRuntimeContext({}, { GROK_SESSION_ID: "shared" }).sessionTitle).toBe("Grok title");
            expect(getAgentRuntimeContext({}, { CLAUDE_CODE_SESSION_ID: "shared" }).sessionTitle).toBeNull();
        });
    });

    it("an override title is kept, and a session the cache does not know has no title", async () => {
        const home = historyHome([{ provider: "anthropic-sub", nativeId: "known", title: "Cached", summary: null }]);

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, () => {
            const given = getAgentRuntimeContext({ sessionTitle: "Given" }, { CLAUDE_CODE_SESSION_ID: "known" });
            expect(given.sessionTitle).toBe("Given");
            expect(getAgentRuntimeContext({}, { CLAUDE_CODE_SESSION_ID: "other" }).sessionTitle).toBeNull();
        });
    });

    it("an agent without a history provider gets no lookup, and a missing index is no error", async () => {
        const empty = realpathSync(mkdtempSync(join(tmpdir(), "agent-title-empty-")));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: empty }, () => {
            expect(getAgentRuntimeContext({}, { COPILOT_AGENT_SESSION_ID: "p1" }).sessionTitle).toBeNull();
            expect(getAgentRuntimeContext({}, { CLAUDE_CODE_SESSION_ID: "no-index" }).sessionTitle).toBeNull();
        });
    });
});

describe("characterization: nested caller scopes restore their parent", () => {
    const facts = {
        project: "FixtureRepo",
        repoRoot: "/fixture/repo",
        isWorktree: false,
        worktreePath: null,
        branch: null,
        commitSha: null,
        commitMessage: null,
        sessionTitle: "Fixture title",
    };
    const vars = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "ambient-session", AI_AGENT: "ambient-label" };

    it("restores two enclosing scopes after an awaited inner caller with a null session and cwd", async () => {
        const outer = {
            agent: "claude-code" as const,
            sessionId: "outer",
            cwd: "/fixture/outer",
            sourceMessage: { messageId: "outer-message" },
        };
        const middle = { agent: "grok" as const, sessionId: "middle", cwd: "/fixture/middle" };
        const inner = { agent: "codex" as const, sessionId: null, cwd: null };
        expect(currentCaller()).toBeUndefined();

        await runAsCaller(outer, async () => {
            await runAsCaller(middle, async () => {
                await runAsCaller(inner, async () => {
                    await Promise.resolve();
                    expect(currentCaller()).toBe(inner);
                    expect(callerCwd()).toBe(process.cwd());
                    expect(getAgentRuntimeContext({ ...facts, cwd: "/fixture/resolved" }, vars)).toMatchObject({
                        agent: "codex",
                        sessionId: null,
                        isInAgent: true,
                        aiAgent: null,
                        sourceMessage: undefined,
                        cwd: "/fixture/resolved",
                    });
                });
                expect(currentCaller()).toBe(middle);
                expect(callerCwd()).toBe("/fixture/middle");
                expect(getAgentRuntimeContext(facts, vars)).toMatchObject({
                    agent: "grok",
                    sessionId: "middle",
                    cwd: "/fixture/middle",
                    sourceMessage: undefined,
                });
            });
            expect(currentCaller()).toBe(outer);
            expect(callerCwd()).toBe("/fixture/outer");
            expect(getAgentRuntimeContext(facts, vars)).toMatchObject({
                agent: "claude-code",
                sessionId: "outer",
                sourceMessage: { messageId: "outer-message" },
            });
        });
        expect(currentCaller()).toBeUndefined();
        expect(callerCwd()).toBe(process.cwd());
        const outside = getAgentRuntimeContext({ ...facts, cwd: "/fixture/resolved" }, vars);
        expect(outside).toMatchObject({
            agent: "claude-code",
            sessionId: "ambient-session",
            aiAgent: "ambient-label",
        });
        expect(outside).not.toHaveProperty("sourceMessage");
    });

    it("restores the outer caller after both a synchronous throw and an async rejection", async () => {
        const outer = { agent: "grok" as const, sessionId: "outer", cwd: "/fixture/outer" };
        const inner = { agent: "unknown" as const, sessionId: null, cwd: "/fixture/inner" };
        const failure = new Error("fixture failure");

        await runAsCaller(outer, async () => {
            expect(() =>
                runAsCaller(inner, () => {
                    expect(currentCaller()).toBe(inner);
                    throw failure;
                })
            ).toThrow(failure);
            expect(currentCaller()).toBe(outer);

            await expect(
                runAsCaller(inner, async () => {
                    await Promise.resolve();
                    expect(currentCaller()).toBe(inner);
                    throw failure;
                })
            ).rejects.toThrow(failure);
            expect(currentCaller()).toBe(outer);
            expect(getAgentRuntimeContext(facts, vars)).toMatchObject({ agent: "grok", sessionId: "outer" });
        });
        expect(currentCaller()).toBeUndefined();
    });

    it("an empty scoped cwd stays empty, while a null cwd falls back to the process", () => {
        runAsCaller({ agent: "copilot", sessionId: "", cwd: "" }, () => {
            expect(callerCwd()).toBe("");
            expect(getAgentRuntimeContext(facts, vars)).toMatchObject({
                agent: "copilot",
                sessionId: "",
                cwd: "",
                isInAgent: true,
            });
        });
        expect(runAsCaller({ agent: "copilot", sessionId: null, cwd: null }, callerCwd)).toBe(process.cwd());
    });
});

describe("characterization: unusual git layouts and cwd spellings", () => {
    let fixture: ReturnType<typeof makeRepo>;
    let bare: string;
    let unborn: string;
    let alias: string;

    beforeAll(() => {
        fixture = makeRepo();
        git(["checkout", "-q", "--detach"], fixture.worktree);
        bare = join(fixture.main, "..", "bare.git");
        git(["clone", "-q", "--bare", fixture.main, bare], fixture.main);
        unborn = join(fixture.main, "..", "UnbornRepo");
        mkdirSync(unborn);
        git(["init", "-q", "-b", "main"], unborn);
        alias = join(fixture.main, "..", "AliasWorktree");
        symlinkSync(fixture.worktree, alias);
        mkdirSync(join(fixture.worktree, "nested"));
    });

    it("a detached linked worktree reports branch HEAD and keeps its commit and main repo identity", () => {
        const ctx = getAgentRuntimeContext({ cwd: fixture.worktree }, {});
        expect(ctx).toMatchObject({
            branch: "HEAD",
            commitMessage: "init",
            repoRoot: fixture.main,
            project: "MainRepo",
            isWorktree: true,
            worktreePath: fixture.worktree,
        });
        expect(ctx.commitSha).toMatch(/^[0-9a-f]{7,}$/);
    });

    it("a repository without commits has a repo identity but no branch, sha or subject", () => {
        const ctx = getAgentRuntimeContext({ cwd: unborn }, {});
        expect(ctx).toMatchObject({
            cwd: unborn,
            repoRoot: unborn,
            project: "UnbornRepo",
            isWorktree: false,
            worktreePath: null,
            branch: null,
            commitSha: null,
            commitMessage: null,
        });
        expect(gitCommonRoot(unborn)).toBe(join(unborn, ".git"));
    });

    it("a bare repo uses its directory as the root and still reads HEAD commit facts", () => {
        expect(getAgentRuntimeContext({ cwd: bare }, {})).toMatchObject({
            cwd: bare,
            repoRoot: bare,
            project: "bare.git",
            isWorktree: false,
            worktreePath: null,
            branch: "main",
            commitMessage: "init",
        });
        expect(gitCommonRoot(bare)).toBe(realpathSync(bare));
    });

    it("a symlinked cwd below a worktree .git file stays lexical while git roots are canonical", () => {
        const cwd = join(alias, "nested");
        expect(getAgentRuntimeContext({ cwd }, {})).toMatchObject({
            cwd,
            repoRoot: fixture.main,
            project: "MainRepo",
            isWorktree: true,
            worktreePath: fixture.worktree,
            branch: "HEAD",
        });
    });

    it("a nonexistent cwd inside a real repo does not inherit that repo's git identity", () => {
        const cwd = join(fixture.main, "missing-child");
        expect(getAgentRuntimeContext({ cwd }, {})).toMatchObject({
            cwd,
            repoRoot: cwd,
            project: "missing-child",
            isWorktree: false,
            worktreePath: null,
            branch: null,
            commitSha: null,
            commitMessage: null,
        });
        expect(gitCommonRoot(cwd)).toBeNull();
    });
});

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountEnvVar } from "@genesiscz/utils/ai/account-env";
import { harnessHooks } from "@genesiscz/utils/ai/providers/harness-hooks";
import { harnessDriver } from "@genesiscz/utils/ai/providers/harness-index";
import { SafeJSON } from "@genesiscz/utils/json";
import { readT3ThreadDetails } from "@genesiscz/utils/t3code/caller-enricher";
import { type CallerSource, clearGitFactsCache, readPeerCaller, whoIsCalling } from "./index";

const local = (env: NodeJS.ProcessEnv) => ({ origin: "local" as const, env });

function scratch(prefix: string): string {
    return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function put(path: string, text = ""): string {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
    return path;
}

describe("whoIsCalling: one precedence rule", () => {
    it("the env host chain names a local caller, the outer host first", () => {
        const identity = whoIsCalling(local({ CLAUDE_CODE_SESSION_ID: "outer", CODEX_THREAD_ID: "inner" }));

        expect(identity).toMatchObject({ agent: "claude-code", sessionId: "outer" });
        expect(identity.sources).toMatchObject({ agent: "env", sessionId: "env" });
    });

    it("a hook payload names the caller ahead of the env it inherited", () => {
        const identity = whoIsCalling({
            origin: "local",
            env: { CLAUDE_CODE_SESSION_ID: "outer", AI_AGENT: "claude-label" },
            hook: { caller: "codex", sessionId: "codex-thread", turnId: "turn-1", toolUseId: "call-1" },
        });

        expect(identity).toMatchObject({
            agent: "codex",
            sessionId: "codex-thread",
            turnId: "turn-1",
            toolUseId: "call-1",
            isInAgent: true,
            aiAgent: null,
        });
        expect(identity.sources).toMatchObject({ agent: "hook-payload", turnId: "hook-payload" });
    });

    it("a source for the same caller fills only what is empty; one for another caller adds nothing", () => {
        const same = whoIsCalling({
            origin: "local",
            env: { CLAUDE_CODE_SESSION_ID: "s1", CLAUDECODE: "1", AI_AGENT: "label", CLAUDE_EFFORT: " high " },
            hook: { caller: "claude", subagentId: "agent-7" },
        });

        expect(same).toMatchObject({ agent: "claude-code", sessionId: "s1", subagentId: "agent-7", aiAgent: "label" });
        expect(same.effort).toBe("high");
        expect(same.sources).toMatchObject({ agent: "hook-payload", sessionId: "env", subagentId: "hook-payload" });

        const other = whoIsCalling({
            origin: "local",
            env: { CLAUDE_CODE_SESSION_ID: "s1" },
            hook: { caller: "claude", sessionId: "s2" },
        });
        expect(other.sessionId).toBe("s2");
    });

    it("the Codex tool call id comes from CODEX_TOOL_CALL_ID only when the caller is that Codex", () => {
        expect(whoIsCalling(local({ CODEX_THREAD_ID: "t1", CODEX_TOOL_CALL_ID: " exec-1 " })).toolUseId).toBe("exec-1");
        // Claude is the outer host here: the inherited Codex variable describes nobody it is.
        expect(
            whoIsCalling(local({ CLAUDE_CODE_SESSION_ID: "c1", CODEX_THREAD_ID: "t1", CODEX_TOOL_CALL_ID: "exec-1" }))
                .toolUseId
        ).toBeUndefined();
    });

    it("the effort is read only from the caller's own harness variable", () => {
        expect(whoIsCalling(local({ CODEX_THREAD_ID: "t1", CLAUDE_EFFORT: "low" })).effort).toBeUndefined();
    });

    it("the seam: a test changes the sources, with no env, process or file", () => {
        const fake: CallerSource = { id: "env", read: () => ({ agent: "grok", sessionId: "g-1" }) };
        expect(whoIsCalling(local({}), {}, [fake])).toMatchObject({ agent: "grok", sessionId: "g-1" });
        const broken: CallerSource = {
            id: "hook-payload",
            read: () => {
                throw new Error("boom");
            },
        };
        expect(whoIsCalling(local({}), {}, [broken, fake]).agent).toBe("grok");
    });

    it("the env-only path spawns nothing and reads no host store", () => {
        const spawn = spyOn(Bun, "spawnSync");
        const missingHome = join(tmpdir(), "no-such-t3-home");
        const identity = whoIsCalling(
            local({ CODEX_THREAD_ID: "t1", T3CODE_THREAD_ID: "thread-1", T3CODE_HOME: missingHome, TMUX_PANE: "%1" })
        );

        expect(spawn).not.toHaveBeenCalled();
        spawn.mockRestore();
        expect(identity.host).toEqual({ app: "t3code", threadId: "thread-1" });
        expect(identity.branch).toBeUndefined();
        expect(identity.repoRoot).toBeUndefined();
    });
});

describe("whoIsCalling: a remote caller", () => {
    const gatewayEnv = {
        CLAUDE_CODE_SESSION_ID: "gateway-own",
        CMUX_SURFACE_ID: "gateway-surface",
        TMUX_PANE: "%9",
        T3CODE_THREAD_ID: "gateway-thread",
        [accountEnvVar("claude")]: "gateway-account",
    };

    it("never takes this process's env, terminal or account", () => {
        const saved = { ...process.env };
        Object.assign(process.env, gatewayEnv);

        try {
            const identity = whoIsCalling({
                origin: "remote",
                caller: { agent: "codex", sessionId: "remote-thread", cwd: "/fixture/remote" },
            });

            expect(identity).toMatchObject({ agent: "codex", sessionId: "remote-thread", cwd: "/fixture/remote" });
            expect(identity.aiAgent).toBeNull();
            expect(identity.terminal).toBeUndefined();
            expect(identity.account).toBeUndefined();
            expect(identity.host).toBeUndefined();
        } finally {
            for (const key of Object.keys(gatewayEnv)) {
                if (!(key in saved)) {
                    delete process.env[key];
                }
            }
        }
    });

    it("the fallback cwd applies only to a scope whose session is explicitly null, below an override", () => {
        const nullSession = {
            origin: "remote" as const,
            caller: { agent: "codex" as const, sessionId: null, cwd: "/a" },
        };
        expect(whoIsCalling(nullSession, { fallbackCwd: "/fallback" }).cwd).toBe("/fallback");
        expect(whoIsCalling(nullSession, { fallbackCwd: "/fallback", overrides: { cwd: "/given" } }).cwd).toBe(
            "/given"
        );
        expect(
            whoIsCalling(
                { origin: "remote", caller: { agent: "codex", sessionId: "s", cwd: "/a" } },
                { fallbackCwd: "/fallback" }
            ).cwd
        ).toBe("/a");
        expect(whoIsCalling(local({}), { fallbackCwd: "/fallback", overrides: { cwd: "/given" } }).cwd).toBe("/given");
    });

    it("a peer with no owner is an unknown caller", () => {
        expect(readPeerCaller({ clientPort: 1, serverPort: 1 })).toMatchObject({ agent: "unknown", sessionId: null });
    });
});

describe("enrichers: terminals, host and account, each in its own slot", () => {
    it("cmux and tmux are both kept, trimmed; a blank value names nothing", () => {
        const identity = whoIsCalling(
            local({
                CLAUDE_CODE_SESSION_ID: "c1",
                CMUX_SURFACE_ID: " surface-1 ",
                CMUX_WORKSPACE_ID: "workspace-1",
                CMUX_TAB_ID: "",
                TMUX_PANE: "%3",
            })
        );

        expect(identity.terminal).toEqual({
            cmux: { surfaceId: "surface-1", workspaceId: "workspace-1", tabId: null },
            tmux: { pane: "%3" },
        });
        expect(whoIsCalling(local({ TMUX_PANE: " \t ", CMUX_SURFACE_ID: " " })).terminal).toBeUndefined();
        expect(identity).toMatchObject({ agent: "claude-code", sessionId: "c1" });
    });

    it("the account is the caller's own harness stamp, an account or a proxy target", () => {
        const codex = whoIsCalling(local({ CODEX_THREAD_ID: "t1", [accountEnvVar("codex")]: "work laptop" }));
        expect(codex.account).toEqual({ harness: "codex", account: "work laptop", proxyTarget: null });

        const grok = whoIsCalling(local({ GROK_SESSION_ID: "g1", [accountEnvVar("grok")]: "proxy:side/grok-sub" }));
        expect(grok.account).toEqual({ harness: "grok", account: null, proxyTarget: "side/grok-sub" });

        // A Codex caller never borrows the Claude stamp it inherited, and Copilot or no host has no key at all.
        expect(
            whoIsCalling(local({ CODEX_THREAD_ID: "t1", [accountEnvVar("claude")]: "work" })).account
        ).toBeUndefined();
        expect(
            whoIsCalling(local({ COPILOT_AGENT_SESSION_ID: "p1", [accountEnvVar("claude")]: "work" })).account
        ).toBeUndefined();
        expect(whoIsCalling(local({ [accountEnvVar("claude")]: "work" })).account).toBeUndefined();
        expect(whoIsCalling(local({ CODEX_THREAD_ID: "t1", [accountEnvVar("codex")]: "  " })).account).toBeUndefined();
    });
});

describe("the T3 Code enricher", () => {
    function t3Store(rows: { threadId: string; instance: string; model: string; parent: string | null }[]): string {
        const home = scratch("t3-home-");
        mkdirSync(join(home, "userdata"));
        const db = new Database(join(home, "userdata", "statev2.sqlite"));
        db.exec(`CREATE TABLE orchestration_v2_projection_threads (
            thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload_json TEXT NOT NULL, provider_instance_id TEXT)`);
        db.exec("CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, workspace_root TEXT NOT NULL)");
        db.query("INSERT INTO projection_projects VALUES (?, ?)").run("project-1", "/fixture/project");

        for (const row of rows) {
            const payload = SafeJSON.stringify({
                modelSelection: { instanceId: row.instance, model: row.model },
                lineage: { parentThreadId: row.parent, relationshipToParent: row.parent ? "subagent" : null },
            });
            db.query("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?, ?)").run(
                row.threadId,
                "project-1",
                payload,
                row.instance
            );
        }

        db.close();
        return home;
    }

    it("the thread id is free; the provider instance, model, project and parent need the host facet", () => {
        const home = t3Store([
            { threadId: "thread:child", instance: "gt-codex-work", model: "model-1", parent: "thread:root" },
        ]);
        const env = { CODEX_THREAD_ID: "codex-thread", T3CODE_THREAD_ID: "thread:child", T3CODE_HOME: home };

        expect(whoIsCalling(local(env)).host).toEqual({ app: "t3code", threadId: "thread:child" });
        expect(whoIsCalling(local(env), { facets: ["host"] }).host).toEqual({
            app: "t3code",
            threadId: "thread:child",
            providerInstanceId: "gt-codex-work",
            model: "model-1",
            projectId: "project-1",
            projectRoot: "/fixture/project",
            parentThreadId: "thread:root",
            relationshipToParent: "subagent",
        });
    });

    it("an unknown thread, a missing store or a broken file leave the thread id and every other fact intact", () => {
        const broken = scratch("t3-broken-");
        put(join(broken, "userdata", "statev2.sqlite"), "not a database");
        const env = { GROK_SESSION_ID: "g1", T3CODE_THREAD_ID: "thread:x", T3CODE_HOME: broken, TMUX_PANE: "%2" };
        const identity = whoIsCalling(local(env), { facets: ["host"] });

        expect(identity).toMatchObject({ agent: "grok", sessionId: "g1", terminal: { tmux: { pane: "%2" } } });
        expect(identity.host).toEqual({ app: "t3code", threadId: "thread:x" });
        expect(readT3ThreadDetails("thread:none", t3Store([]))).toBeUndefined();
    });
});

describe("the transcript and model facets, through each harness's locator and model reader", () => {
    const NOW = new Date(2026, 10, 4, 12, 0, 0);

    it("Codex: the rollout in the caller's first CODEX_HOME, and its model", () => {
        const home = scratch("codex-home-");
        const id = "01a0f4fc-171d-7c30-9679-ee00633dee2d";
        const day = join(home, "sessions", "2026", "11", "04");
        const rollout = put(
            join(day, `rollout-2026-11-04T09-00-00-${id}.jsonl`),
            `${SafeJSON.stringify({ type: "turn_context", payload: { model: "codex-model-1" } })}\n`
        );
        const identity = whoIsCalling(local({ CODEX_THREAD_ID: id, CODEX_HOME: `${home},/fixture/second` }), {
            facets: ["model"],
            now: NOW,
        });

        expect(identity).toMatchObject({ transcriptPath: rollout, model: "codex-model-1" });
        expect(identity.sources).toMatchObject({ transcriptPath: "transcript", model: "transcript" });
    });

    it("Grok: the session folder under its cwd, and the model of its summary.json", () => {
        const home = scratch("grok-home-");
        const cwd = "/fixture/grok project";
        const folder = join(home, "sessions", encodeURIComponent(cwd), "grok-session-1");
        const updates = put(join(folder, "updates.jsonl"), "");
        put(join(folder, "summary.json"), SafeJSON.stringify({ current_model_id: "grok-model-1" }));
        const identity = whoIsCalling(
            {
                origin: "local",
                env: { GROK_SESSION_ID: "grok-session-1", GROK_HOME: home },
                hook: { caller: "grok", cwd },
            },
            { facets: ["model"], now: NOW }
        );

        expect(identity).toMatchObject({ agent: "grok", transcriptPath: updates, model: "grok-model-1" });
    });

    it("a hook's own transcript and model win, and Copilot has no transcript lookup", () => {
        const identity = whoIsCalling(
            {
                origin: "local",
                env: {},
                hook: { caller: "claude", sessionId: "s1", transcriptPath: "/fixture/t.jsonl", model: "hook-model" },
            },
            { facets: ["model", "transcript"] }
        );
        expect(identity).toMatchObject({ transcriptPath: "/fixture/t.jsonl", model: "hook-model" });
        expect(identity.sources).toMatchObject({ transcriptPath: "hook-payload", model: "hook-payload" });
        expect(whoIsCalling(local({ COPILOT_AGENT_SESSION_ID: "p1" }), { facets: ["model"] })).toMatchObject({
            transcriptPath: null,
            model: null,
        });
    });
});

describe("the git facet's cache", () => {
    afterEach(() => clearGitFactsCache());

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

    it("a second call spawns nothing, and a commit or a branch switch is seen at once", () => {
        const repo = scratch("identity-git-");
        git(["init", "-q", "-b", "main"], repo);
        git(["commit", "-q", "--allow-empty", "-m", "first"], repo);
        const read = () => whoIsCalling(local({}), { facets: ["git"], overrides: { cwd: repo } });

        expect(read()).toMatchObject({ branch: "main", commitMessage: "first", repoRoot: repo });
        const spawn = spyOn(Bun, "spawnSync");
        expect(read().commitMessage).toBe("first");
        expect(spawn).not.toHaveBeenCalled();
        spawn.mockRestore();

        git(["commit", "-q", "--allow-empty", "-m", "second"], repo);
        expect(read().commitMessage).toBe("second");
        git(["checkout", "-q", "-b", "feat/other"], repo);
        expect(read().branch).toBe("feat/other");
        git(["pack-refs", "--all"], repo);
        git(["commit", "-q", "--allow-empty", "-m", "third"], repo);
        expect(read()).toMatchObject({ branch: "feat/other", commitMessage: "third" });
    });

    it("a reftable repository: a commit or a branch switch is seen at once", () => {
        const repo = scratch("identity-reftable-");
        git(["init", "-q", "--ref-format=reftable", "-b", "main"], repo);
        git(["commit", "-q", "--allow-empty", "-m", "first"], repo);
        const read = () => whoIsCalling(local({}), { facets: ["git"], overrides: { cwd: repo } });

        expect(read()).toMatchObject({ branch: "main", commitMessage: "first" });
        git(["commit", "-q", "--allow-empty", "-m", "second"], repo);
        expect(read().commitMessage).toBe("second");
        git(["checkout", "-q", "-b", "feat/other"], repo);
        expect(read().branch).toBe("feat/other");
    });
});

describe("whoIsCalling: overrides and retargeting", () => {
    const oldSession = {
        origin: "local" as const,
        env: { CLAUDE_EFFORT: "high" },
        hook: {
            caller: "claude" as const,
            sessionId: "old",
            model: "old-model",
            transcriptPath: "/fixture/old.jsonl",
            turnId: "old-turn",
            subagentId: "old-agent",
            toolUseId: "old-tool",
        },
    };

    it("an override that names another session drops every fact of the old session", () => {
        const identity = whoIsCalling(oldSession, { overrides: { sessionId: "new", turnId: "new-turn" } });

        expect(identity).toMatchObject({ agent: "claude-code", sessionId: "new", turnId: "new-turn" });

        for (const field of ["model", "transcriptPath", "subagentId", "toolUseId", "effort", "sessionTitle"] as const) {
            expect([field, identity[field]]).toEqual([field, undefined]);
            expect([field, identity.sources[field]]).toEqual([field, undefined]);
        }

        expect(identity.sources).toMatchObject({ sessionId: "override", turnId: "override" });
    });

    it("a retargeted caller's transcript facet looks up the NEW session, never keeps the old path", () => {
        const home = scratch("retarget-home-");
        const identity = whoIsCalling(oldSession, {
            overrides: { sessionId: "new", cwd: "/fixture/project" },
            facets: ["transcript", "model"],
            home,
        });

        expect(identity).toMatchObject({ sessionId: "new", transcriptPath: null, model: null });
        expect(identity.sources).toMatchObject({ transcriptPath: "transcript", model: "transcript" });
    });

    it("an override of the same session keeps the session's facts", () => {
        const identity = whoIsCalling(oldSession, { overrides: { sessionId: "old" } });
        expect(identity).toMatchObject({
            transcriptPath: "/fixture/old.jsonl",
            turnId: "old-turn",
            model: "old-model",
        });
    });

    it("a failed transcript or model lookup leaves the resolved caller intact and the facet unset", () => {
        const locate = harnessDriver("claude").parts.locate;
        const denied = Object.assign(new Error("EACCES: permission denied, scandir"), { code: "EACCES" });
        const lookup = spyOn(locate, "callerTranscript").mockImplementation(() => {
            throw denied;
        });

        try {
            const identity = whoIsCalling(local({ CLAUDE_CODE_SESSION_ID: "s1", TMUX_PANE: "%4" }), {
                facets: ["transcript", "model"],
                overrides: { cwd: "/fixture/project" },
            });

            expect(lookup).toHaveBeenCalled();
            expect(identity).toMatchObject({
                agent: "claude-code",
                sessionId: "s1",
                terminal: { tmux: { pane: "%4" } },
            });
            expect(identity.transcriptPath).toBeUndefined();
            expect(identity.model).toBeUndefined();
            expect(identity.sources.transcriptPath).toBeUndefined();
        } finally {
            lookup.mockRestore();
        }

        const model = spyOn(harnessHooks("claude"), "currentModel").mockImplementation(() => {
            throw denied;
        });

        try {
            const identity = whoIsCalling(
                {
                    origin: "local",
                    env: {},
                    hook: { caller: "claude", sessionId: "s1", transcriptPath: "/fixture/t.jsonl" },
                },
                { facets: ["model"] }
            );

            expect(identity).toMatchObject({ sessionId: "s1", transcriptPath: "/fixture/t.jsonl" });
            expect(identity.model).toBeUndefined();
        } finally {
            model.mockRestore();
        }
    });

    it("an explicit account, terminal or host is never replaced by an enricher", () => {
        const env = {
            CLAUDE_CODE_SESSION_ID: "c1",
            [accountEnvVar("claude")]: "ambient",
            CMUX_SURFACE_ID: "ambient-surface",
            TMUX_PANE: "%7",
            T3CODE_THREAD_ID: "ambient-thread",
        };
        const account = { harness: "claude" as const, account: "explicit", proxyTarget: null };
        const terminal = { tmux: { pane: "%1" } };
        const host = { app: "t3code" as const, threadId: "explicit-thread" };
        const identity = whoIsCalling(local(env), { overrides: { account, terminal, host } });

        expect(identity).toMatchObject({ account, terminal, host });
        expect(identity.terminal?.cmux).toBeUndefined();
        expect(identity.sources).toMatchObject({ account: "override", terminal: "override", host: "override" });
        expect(identity.sources["terminal.cmux"]).toBeUndefined();
    });

    it("an explicit null model, transcript or title is an answer: no lookup runs", () => {
        const lookup = spyOn(harnessDriver("claude").parts.locate, "callerTranscript");

        try {
            const identity = whoIsCalling(local({ CLAUDE_CODE_SESSION_ID: "s1" }), {
                facets: ["model", "transcript", "title"],
                overrides: { model: null, transcriptPath: null, sessionTitle: null, cwd: "/fixture/project" },
            });

            expect(lookup).not.toHaveBeenCalled();
            expect(identity).toMatchObject({ model: null, transcriptPath: null, sessionTitle: null });
            expect(identity.sources).toMatchObject({
                model: "override",
                transcriptPath: "override",
                sessionTitle: "override",
            });
        } finally {
            lookup.mockRestore();
        }
    });
});

describe("provenance: each independent observation keeps its own source", () => {
    it("cmux and tmux each record their own source, in either order", () => {
        const identity = whoIsCalling(local({ CLAUDE_CODE_SESSION_ID: "c1", CMUX_SURFACE_ID: "s-1", TMUX_PANE: "%3" }));

        expect(identity.sources["terminal.cmux"]).toBe("cmux");
        expect(identity.sources["terminal.tmux"]).toBe("tmux");
        expect(identity.sources.terminal).toBeUndefined();
    });

    it("the host thread id comes from the env, its details from the host's store", () => {
        const env = { CODEX_THREAD_ID: "t1", T3CODE_THREAD_ID: "thread:x", T3CODE_HOME: scratch("t3-none-") };

        expect(whoIsCalling(local(env)).sources).toMatchObject({ "host.threadId": "t3code" });
        expect(whoIsCalling(local(env)).sources["host.details"]).toBeUndefined();
    });
});

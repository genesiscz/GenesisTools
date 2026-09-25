import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LocalCheckout } from "@genesiscz/utils/git/local-checkouts";
import type { EditorTarget, RunResult, TerminalTarget } from "@genesiscz/utils/open-in";
import { makeTempDir } from "@genesiscz/utils/paths";
import { isProcessAlive } from "@genesiscz/utils/process-alive";
import { targetFromHash } from "../extension/shared/route-target";
import { actionValues, runAction } from "./actions";
import { ConfigError, parseConfig } from "./config";
import { type Deps, type RunOptions, routedRunner, spawnArgv } from "./deps";
import { explainHunk } from "./explain";
import { dispatch } from "./host/dispatch";
import { extensionIdFromKey, pinnedExtensionId } from "./host/install";
import { hostReplyDeadlineMs } from "./host/messages";
import { encodeFrame, FrameReader } from "./host/protocol";
import { openFile } from "./open";
import { parseForgeUrl, splitRefPath } from "./page-url";
import { planReview, startReview } from "./review";
import { explainLink, routeLink } from "./router";
import { checkPageValue, checkRelativePath, fillArgv } from "./values";

const base = makeTempDir("browser-extension-");
const root = join(base, "app");
const worktree = join(base, "app-feat");
mkdirSync(join(root, "src"), { recursive: true });
mkdirSync(worktree, { recursive: true });
writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");

afterAll(() => {
    rmSync(base, { recursive: true, force: true });
});

const project = { host: "gitlab.internal.example", path: "group/app" };
const checkouts: LocalCheckout[] = [
    { root, commonDir: join(root, ".git"), branch: "main", isMain: true, remoteUrl: "git@x:group/app.git", project },
    { root: worktree, commonDir: join(root, ".git"), branch: "feat/login", isMain: false, remoteUrl: "", project },
];

interface Calls {
    run: { argv: string[]; opts: RunOptions }[];
    tools: string[][];
    editor: EditorTarget[];
    terminal: TerminalTarget[];
}

function fakeDeps({
    config = {},
    tools = () => ({ code: 0, stdout: "", stderr: "" }),
    run = () => ({ code: 0, stdout: "", stderr: "" }),
}: {
    config?: Record<string, unknown>;
    tools?: (args: string[]) => RunResult;
    run?: (argv: string[]) => RunResult;
} = {}): { deps: Deps; calls: Calls } {
    const calls: Calls = { run: [], tools: [], editor: [], terminal: [] };
    const parsed = parseConfig({ repoRoots: [], ...config });
    const deps: Deps = {
        config: async () => parsed,
        checkouts: () => checkouts,
        run: async (argv, opts) => {
            calls.run.push({ argv, opts });
            return run(argv);
        },
        tools: async (args) => {
            calls.tools.push(args);
            return tools(args);
        },
        editor: () => ({
            kind: "editor",
            id: "cursor",
            label: "Cursor",
            open: async (target) => {
                calls.editor.push(target);
                return { driver: "cursor", detail: "opened" };
            },
        }),
        terminal: () => ({
            kind: "terminal",
            id: "cmux",
            label: "cmux",
            open: async (target) => {
                calls.terminal.push(target);
                return { driver: "cmux", detail: "workspace:1" };
            },
        }),
        promptDir: join(base, "prompts"),
        now: () => new Date("2026-01-02T03:04:05Z"),
    };
    return { deps, calls };
}

describe("parseForgeUrl", () => {
    it("reads GitHub PRs, blobs with a line, and diff anchors", () => {
        expect(parseForgeUrl("https://github.com/o/r/pull/12/files")).toMatchObject({
            kind: "github",
            project: "o/r",
            view: "pr",
            number: 12,
        });
        expect(parseForgeUrl("https://github.com/o/r/blob/feat/x/src/a.ts#L10-L12")).toMatchObject({
            view: "blob",
            refPath: "feat/x/src/a.ts",
            line: 10,
        });
        expect(parseForgeUrl("https://github.com/o/r/pull/3/files#diff-0a1bR44")?.line).toBe(44);
    });

    it("reads GitLab subgroups and MRs, only on GitLab hosts", () => {
        const url = "https://gitlab.internal.example/group/sub/app/-/merge_requests/7/diffs";
        expect(parseForgeUrl(url)).toMatchObject({ kind: "gitlab", project: "group/sub/app", view: "pr", number: 7 });
        expect(parseForgeUrl("https://code.example.com/group/app/-/merge_requests/7")).toBeNull();
        expect(
            parseForgeUrl("https://code.example.com/group/app/-/merge_requests/7", ["code.example.com"])?.number
        ).toBe(7);
        expect(parseForgeUrl("javascript:alert(1)")).toBeNull();
    });

    it("the route page's target is the encoded URL the bypass rule and the host see", () => {
        expect(targetFromHash("#https://genesis.tools/a%20b")).toBe("https://genesis.tools/a%20b");
        expect(targetFromHash("#https://genesis.tools/a b?q=1")).toBe("https://genesis.tools/a%20b?q=1");
    });

    it("a malformed percent escape in a blob path is a project page, not a throw", () => {
        expect(parseForgeUrl("https://github.com/o/r/blob/main/src/%zz.ts")).toMatchObject({
            project: "o/r",
            view: "project",
        });
    });

    it("splits a blob ref against known branch names, longest first", () => {
        expect(splitRefPath("feat/x/src/a.ts", ["feat", "feat/x"])).toEqual({ ref: "feat/x", path: "src/a.ts" });
        expect(splitRefPath("main/src/a.ts", [])).toEqual({ ref: "main", path: "src/a.ts" });
    });
});

describe("page values", () => {
    it("refuses option-looking, control-character and out-of-pattern values", () => {
        expect(checkPageValue("title", "  Fix login ")).toBe("Fix login");
        expect(() => checkPageValue("title", "--upload-pack=x")).toThrow('must not start with "-"');
        expect(() => checkPageValue("title", "a\nb")).toThrow("printable");
        expect(() => checkPageValue("id", "12a", "\\d+")).toThrow("does not match");
    });

    it("keeps each filled template one argv element", () => {
        expect(fillArgv(["init", "{id}", "--title={title}"], { id: "12345", title: "a b; $(c)" })).toEqual([
            "init",
            "12345",
            "--title=a b; $(c)",
        ]);
    });

    it("accepts only plain repository-relative paths", () => {
        expect(checkRelativePath("src/a.ts")).toBe("src/a.ts");

        for (const bad of ["/etc/passwd", "../x", "src/../../x", "a//b", "a\\b"]) {
            expect(() => checkRelativePath(bad)).toThrow();
        }
    });
});

describe("config", () => {
    it("refuses a template that names an unknown value", () => {
        const action = { id: "a", label: "A", match: "^https://x/(?<id>\\d+)", cwd: "/tmp", command: ["x", "{nope}"] };
        expect(() => parseConfig({ actions: [action] })).toThrow(ConfigError);
    });

    it("refuses a label that names an unknown value", () => {
        const action = {
            id: "a",
            label: "Deploy {prod}",
            match: "^https://x/(?<id>\\d+)",
            cwd: "/tmp",
            command: ["x"],
        };
        expect(() => parseConfig({ actions: [action] })).toThrow(/label uses \{prod\}/);
    });

    it("refuses a field or URL group named like a built-in value", () => {
        const base = { id: "a", label: "A", cwd: "/tmp", command: ["x"] };
        const field = { ...base, match: "^https://x/", fields: { url: { selector: "h1" } } };
        expect(() => parseConfig({ actions: [field] })).toThrow('fields: "url" is a built-in value');
        const group = { ...base, match: "^https://x/(?<cwd>\\w+)" };
        expect(() => parseConfig({ actions: [group] })).toThrow('group "cwd" is a built-in value');
        const fine = { ...base, match: "^https://x/(?<id>\\d+)", fields: { title: { selector: "h1" } } };
        expect(parseConfig({ actions: [fine] }).actions).toHaveLength(1);
    });

    it("refuses an unknown driver", () => {
        expect(() => parseConfig({ editor: "notepad" })).toThrow("editor must be one of");
    });

    it("keeps each GitLab host once and refuses a host Chrome cannot match", () => {
        const hosts = ["GitLab.Example.test", "gitlab.example.test", "git.example.test:8443"];
        expect(parseConfig({ gitlabHosts: hosts }).gitlabHosts).toEqual([
            "gitlab.example.test",
            "git.example.test:8443",
        ]);

        for (const bad of [
            ".example.test",
            "a..b",
            "-git.example.test",
            "git.example.test:70000",
            "git.example.test:0",
        ]) {
            expect(() => parseConfig({ gitlabHosts: [bad] })).toThrow("gitlabHosts must be bare host names");
        }
    });
});

describe("native messaging frames", () => {
    it("round-trips messages split across chunks", () => {
        const frames = [...encodeFrame({ command: "ping" }), ...encodeFrame({ command: "config.get" })];
        const reader = new FrameReader();
        expect(reader.push(new Uint8Array(frames.slice(0, 7)))).toEqual([]);
        expect(reader.push(new Uint8Array(frames.slice(7)))).toEqual([{ command: "ping" }, { command: "config.get" }]);
    });

    it("reads a large request sent in small chunks, and the frame behind it in the same chunk", () => {
        const big = { command: "config.set", params: { text: "x".repeat(900 * 1024) } };
        const first = encodeFrame(big);
        const second = encodeFrame({ command: "ping" });
        const stream = new Uint8Array(first.byteLength + second.byteLength);
        stream.set(first, 0);
        stream.set(second, first.byteLength);
        const reader = new FrameReader();
        const messages: unknown[] = [];

        for (let offset = 0; offset < stream.byteLength; offset += 4093) {
            messages.push(...reader.push(stream.subarray(offset, offset + 4093)));
        }

        expect(messages).toEqual([big, { command: "ping" }]);
        expect(reader.push(encodeFrame({ command: "config.get" }))).toEqual([{ command: "config.get" }]);
    });

    it("waits for a reply longer than the host's own timeout, and briefly for a quick command", () => {
        const defaults = parseConfig({ repoRoots: [] });
        expect(hostReplyDeadlineMs("hunk.explain")).toBeGreaterThan(defaults.agent.headlessTimeoutMs);
        expect(hostReplyDeadlineMs("action.run")).toBeGreaterThan(120_000);
        expect(hostReplyDeadlineMs("config.get")).toBe(60_000);
    });

    it("derives the extension id from the public key the way Chromium does", () => {
        expect(extensionIdFromKey(Buffer.from("key").toString("base64"))).toMatch(/^[a-p]{32}$/);
        // Computed from the manifest key with `openssl rsa -pubout -outform DER | shasum -a 256`.
        expect(pinnedExtensionId()).toBe("nhjllpnekfohbnljgelfpcdfhagbojne");
    });
});

describe("dispatch", () => {
    it("refuses commands outside the allowlist before running anything", async () => {
        const { deps, calls } = fakeDeps();
        const reply = await dispatch(deps, { command: "run", params: { argv: ["rm", "-rf", "/"] } });
        expect(reply).toMatchObject({ ok: false, code: "unknown-command" });
        expect(calls.run).toEqual([]);
    });

    it("maps a missing checkout to no-checkout", async () => {
        const { deps } = fakeDeps();
        const reply = await dispatch(deps, { command: "open.terminal", params: { url: "https://github.com/o/other" } });
        expect(reply).toMatchObject({ ok: false, code: "no-checkout" });
    });
});

describe("open locally", () => {
    it("opens the file at its line inside the checkout, and refuses a path that leaves it", async () => {
        const { deps, calls } = fakeDeps();
        const url = "https://gitlab.internal.example/group/app/-/merge_requests/7";
        await openFile(deps, { url, path: "src/a.ts", line: 3 });
        expect(calls.editor[0]).toMatchObject({ file: expect.stringMatching(/app\/src\/a\.ts$/), line: 3 });
        await expect(openFile(deps, { url, path: "../app-feat" })).rejects.toThrow();
    });
});

describe("review", () => {
    const url = "https://gitlab.internal.example/group/app/-/merge_requests/7";

    it("reports not-available when the GitLab facts command is missing, and starts nothing", async () => {
        // The real miss: commander prints the ROOT usage for an unknown subcommand and exits 0.
        const rootUsage = { code: 0, stdout: "Usage: gitlab [options] [command]", stderr: "" };
        const { deps, calls } = fakeDeps({ tools: () => rootUsage });
        const plan = await planReview(deps, { url });
        expect(plan.gate).toMatchObject({ hub: true, facts: false });
        await expect(startReview(deps, { url })).rejects.toThrow("not available yet");
        expect(calls.terminal).toEqual([]);
    });

    it("starts the agent in the worktree on the MR branch with a prompt file, never the prompt on the line", async () => {
        const { deps, calls } = fakeDeps({
            tools: () => ({ code: 0, stdout: "Usage: gitlab pr review [options] <iid>", stderr: "" }),
        });
        await startReview(deps, { url, branch: "feat/login" });
        const argv = calls.terminal[0]?.argv ?? [];
        expect(calls.terminal[0]?.cwd).toBe(worktree);
        const sentence = argv.at(-1) ?? "";
        expect(argv.slice(0, -1)).toEqual(parseConfig({}).agent.interactive);
        expect(sentence).toMatch(/^Read the task in .+-review-.+\.md and do it\.$/);
        const prompt = await Bun.file(sentence.replace(/^Read the task in (.+) and do it\.$/, "$1")).text();
        expect(prompt).toContain("tools gitlab pr review 7 --json");
        expect(prompt).toContain("Never post, approve or merge");
    });
});

describe("explain", () => {
    it("sends the hunk on stdin to the headless agent in the checkout", async () => {
        const { deps, calls } = fakeDeps({ run: () => ({ code: 0, stdout: " It renames a.\n", stderr: "" }) });
        const answer = await explainHunk(deps, {
            url: "https://gitlab.internal.example/group/app/-/merge_requests/7",
            hunk: "-a\n+b",
            path: "src/a.ts",
        });
        expect(answer.answer).toBe("It renames a.");
        expect(calls.run[0]?.argv).toEqual(parseConfig({}).agent.headless);
        expect(calls.run[0]?.opts.cwd).toBe(root);
        expect(calls.run[0]?.opts.stdin).toContain("-a\n+b");
    });
});

describe("actions", () => {
    const action = {
        id: "start",
        label: "Start {id}",
        match: "^https://dev\\.example\\.com/_workitems/edit/(?<id>\\d+)",
        fields: { title: { selector: "#title" } },
        cwd: root,
        command: ["./init.sh", "{id}", "{title}"],
        sessionCwd: "{stdoutLastLine}",
        prompt: "Work item {id}: {title}",
    };
    const url = "https://dev.example.com/_workitems/edit/12345";

    it("takes URL values from its own match, not from the page", () => {
        expect(actionValues(parseConfig({ actions: [action] }).actions[0], url, { title: "Login", id: "999" })).toEqual(
            {
                url,
                id: "12345",
                title: "Login",
            }
        );
    });

    it("runs the argv in cwd, then opens the session in the folder the command printed", async () => {
        const { deps, calls } = fakeDeps({
            config: { actions: [action] },
            run: () => ({ code: 0, stdout: `created\n${worktree}\n`, stderr: "" }),
        });
        const outcome = await runAction(deps, { actionId: "start", url, fields: { title: "Fix $(login)" } });
        expect(calls.run[0]).toMatchObject({ argv: ["./init.sh", "12345", "Fix $(login)"], opts: { cwd: root } });
        expect(outcome.sessionCwd).toBe(worktree);
        expect(calls.terminal[0]).toMatchObject({ cwd: worktree, title: "Start 12345" });
    });
});

describe("configured argv runner", () => {
    it("returns at the deadline and ends the grandchild that held the output pipes", async () => {
        const started = Date.now();
        const held = await spawnArgv(["sh", "-c", "sleep 4 & echo $!; wait"], { timeoutMs: 300 });
        const elapsed = Date.now() - started;

        expect(held.code).toBe(124);
        expect(elapsed).toBeLessThan(3000);

        // The group kill reached `sleep` too: its pid stops answering (reaping is asynchronous).
        const grandchild = Number(held.stdout.trim());
        expect(grandchild).toBeGreaterThan(0);
        // This test spawned the pid itself moments ago, which is the case isProcessAlive covers.
        const alive = () => isProcessAlive(grandchild);
        const deadline = Date.now() + 2000;

        while (alive() && Date.now() < deadline) {
            await Bun.sleep(100);
        }

        expect(alive()).toBe(false);

        const quick = await spawnArgv(["sh", "-c", "echo done"], { timeoutMs: 5000 });
        expect(quick).toEqual({ code: 0, stdout: "done\n", stderr: "" });
    });

    it("sends a leading `tools` through the tools runner and spawns anything else", async () => {
        const seen: { via: string; argv: string[]; opts: RunOptions }[] = [];
        const record =
            (via: string) =>
            async (argv: string[], opts: RunOptions): Promise<RunResult> => {
                seen.push({ via, argv, opts });
                return { code: 0, stdout: "", stderr: "" };
            };
        const run = routedRunner({ tools: record("tools"), spawn: record("spawn") });

        await run(["tools", "claude", "run", "--", "-p"], { cwd: root, timeoutMs: 5000, stdin: "prompt" });
        await run(["/usr/bin/open", "-b", "x"], { timeoutMs: 5000 });

        expect(seen).toEqual([
            {
                via: "tools",
                argv: ["claude", "run", "--", "-p"],
                opts: { cwd: root, timeoutMs: 5000, stdin: "prompt" },
            },
            { via: "spawn", argv: ["/usr/bin/open", "-b", "x"], opts: { timeoutMs: 5000 } },
        ]);
    });
});

describe("router", () => {
    it("hands a routed link to GenesisTools.app and keeps an unrouted one in the browser", async () => {
        const routed = fakeDeps({
            tools: () => ({ code: 0, stdout: '{"kind":"run","via":"route","argv":["tools","x"]}', stderr: "" }),
        });
        const explained = await explainLink(routed.deps, "https://genesis.tools/tabs/work");
        expect(explained).toMatchObject({ handled: true, runs: true, routed: false, summary: "tools x" });
        expect(routed.calls.run).toEqual([]);
        expect(await routeLink(routed.deps, "https://genesis.tools/tabs/work")).toMatchObject({ routed: true });
        expect(routed.calls.run[0]?.argv.slice(0, 3)).toEqual(["/usr/bin/open", "-b", "com.genesiscz.genesistools"]);

        const unrouted = fakeDeps({
            tools: () => ({
                code: 0,
                stdout: '{"kind":"open","via":"default","url":"https://genesis.tools/x"}',
                stderr: "",
            }),
        });
        expect(await routeLink(unrouted.deps, "https://genesis.tools/x")).toMatchObject({ handled: false });
        expect(unrouted.calls.run).toEqual([]);
        await expect(routeLink(unrouted.deps, "https://evil.example/x")).rejects.toThrow("only https://genesis.tools");
    });
});

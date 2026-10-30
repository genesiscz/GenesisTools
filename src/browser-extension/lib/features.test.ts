import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OpenHubOptions, OpenHubResult } from "@app/hub/lib/open";
import { buildStamp, readBuildInfo, writeBuildInfo } from "@genesiscz/utils/browser-extension/build-info";
import { extensionProfiles } from "@genesiscz/utils/browser-extension/profiles";
import { GENESIS_EXTENSION_ID } from "@genesiscz/utils/browser-extension/registry";
import {
    describeUpdateRange,
    freshnessOf,
    updateRangeFromReply,
} from "@genesiscz/utils/browser-extension/runtime/freshness";
import { defaultRouterConfig, type RouteRule } from "@genesiscz/utils/browser-router/route";
import type { LocalCheckout } from "@genesiscz/utils/git/local-checkouts";
import { SafeJSON } from "@genesiscz/utils/json";
import type { EditorTarget, RunResult, TerminalTarget } from "@genesiscz/utils/open-in";
import { makeTempDir } from "@genesiscz/utils/paths";
import { isProcessAlive } from "@genesiscz/utils/process-alive";
import {
    checkoutCache,
    headBranchFromEmbeddedData,
    menuTargetContext,
    pageFocusTarget,
    quickCardMayClose,
    surfaceHoldsFocus,
} from "../extension/content-dom";
import { targetFromHash } from "../extension/shared/route-target";
import { actionValues, runAction } from "./actions";
import { routerHostPermissions } from "./build";
import { ConfigError, parseConfig } from "./config";
import { type Deps, type RunOptions, routedRunner, spawnArgv } from "./deps";
import { cliTail } from "./errors";
import { explainHunk } from "./explain";
import { dispatch } from "./host/dispatch";
import { extensionIdFromKey, pinnedExtensionId } from "./host/install";
import {
    EXTENSION_PAGE_COMMANDS,
    type HostResponse,
    hostReplyDeadlineMs,
    type PlainNavigationService,
} from "./host/messages";
import { encodeFrame, FrameReader } from "./host/protocol";
import { openInHub } from "./hub";
import { allowsPlainNavigation, loopbackPort, loopbackRegex, readPlainNavigationServices } from "./loopback";
import { openFile } from "./open";
import { parseForgeUrl, splitRefPath } from "./page-url";
import { planReview, startReview } from "./review";
import {
    checkRouterLink,
    ensureLink,
    explainLink,
    plainNavigationServices,
    type RouterHosts,
    routeLink,
} from "./router";
import { checkPageValue, checkRelativePath, fillArgv } from "./values";
import { loopbackGrantCheck } from "./verify";

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
    hub: OpenHubOptions[];
}

function fakeDeps({
    config = {},
    tools = () => ({ code: 0, stdout: "", stderr: "" }),
    run = () => ({ code: 0, stdout: "", stderr: "" }),
    hub = (options) => ({ built: false, args: ["--hub", "--mode", options.mode ?? "sessions"] }),
}: {
    config?: Record<string, unknown>;
    tools?: (args: string[]) => RunResult;
    run?: (argv: string[]) => RunResult;
    hub?: (options: OpenHubOptions) => OpenHubResult;
} = {}): { deps: Deps; calls: Calls } {
    const calls: Calls = { run: [], tools: [], editor: [], terminal: [], hub: [] };
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
        hub: async (options) => {
            calls.hub.push(options);
            return hub(options);
        },
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
        expect(targetFromHash("#https://links.example.test/a%20b")).toBe("https://links.example.test/a%20b");
        expect(targetFromHash("#https://links.example.test/a b?q=1")).toBe("https://links.example.test/a%20b?q=1");
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
        // The router's capability check reads the same id from utils.
        expect(pinnedExtensionId()).toBe(GENESIS_EXTENSION_ID);
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

describe("open in GenesisTools", () => {
    const mr = "https://gitlab.internal.example/group/app/-/merge_requests/7";

    it("selects the MR in the hub's PRs mode, and opens a diff file in its review", async () => {
        const { deps, calls } = fakeDeps();
        expect(await openInHub(deps, { url: `${mr}/diffs` })).toMatchObject({ root });
        expect(await openInHub(deps, { url: mr, path: "src/a.ts" })).toMatchObject({
            detail: "Asked GenesisTools to show group/app!7, src/a.ts",
        });
        expect(calls.hub).toEqual([
            { mode: "prs", pr: "group/app!7", reveal: undefined },
            { mode: "prs", pr: "group/app!7", reveal: "src/a.ts" },
        ]);
        await expect(openInHub(deps, { url: mr, path: "../app-feat/x" })).rejects.toThrow();
        expect(calls.hub).toHaveLength(2);
    });

    it("opens any other project page in Worktrees, on the worktree of the page's branch", async () => {
        const { deps, calls } = fakeDeps();
        await openInHub(deps, { url: "https://gitlab.internal.example/group/app", branch: "feat/login" });
        expect(calls.hub).toEqual([{ mode: "worktrees", worktree }]);
    });

    it("never reaches the hub for a project with no local checkout", async () => {
        const { deps } = fakeDeps({
            hub: () => {
                throw new Error("the hub must not open for a project without a checkout");
            },
        });
        const reply = await dispatch(deps, {
            command: "hub.open",
            params: { url: "https://github.com/o/other/pull/3" },
        });
        expect(reply).toMatchObject({ ok: false, code: "no-checkout" });
    });
});

describe("page text for the cards", () => {
    it("drops colour codes, clack glyphs and blank lines from a CLI failure, and keeps its end", () => {
        expect(cliTail("\u001b[31m│\u001b[39m\n■  link used up\n\n")).toBe("link used up");
        expect(cliTail(`${"x".repeat(400)}\nreason`, 20)).toBe(`…${"x".repeat(13)}\nreason`);
    });

    it("reads the right-clicked element for a menu entry and nothing for the keyboard shortcut", () => {
        const read = (): { path?: string } => ({ path: "src/a.ts" });
        const never = (): { path?: string } => {
            throw new Error("the shortcut must not read an old right-click target");
        };
        expect(menuTargetContext({ type: "menu", item: "open-hub", source: "shortcut" }, never, {})).toEqual({});
        expect(menuTargetContext({ type: "menu", item: "open-hub", source: "menu" }, read, {})).toEqual({
            path: "src/a.ts",
        });
        expect(menuTargetContext({ type: "menu", item: "open-file" }, read, {})).toEqual({ path: "src/a.ts" });
    });

    it("keeps a definite checkout answer for the page's life and asks again after a host failure", async () => {
        const replies: HostResponse[] = [
            { ok: false, code: "unavailable", error: "host down" },
            { ok: true, data: { root: "/tmp/x" } },
            { ok: false, code: "no-checkout", error: "none" },
        ];
        const asked: string[] = [];
        const known = checkoutCache(async (webBase) => {
            asked.push(webBase);
            const reply = replies.shift();

            if (!reply) {
                throw new Error(`asked again for ${webBase} after a definite answer`);
            }

            return reply;
        });

        expect(await known("https://github.com/a/b")).toBe(true);
        expect(await known("https://github.com/a/b")).toBe(true);
        expect(await known("https://github.com/a/b")).toBe(true);
        expect(await Promise.all([known("https://github.com/c/d"), known("https://github.com/c/d")])).toEqual([
            false,
            false,
        ]);
        expect(await known("https://github.com/c/d")).toBe(false);
        expect(asked).toEqual(["https://github.com/a/b", "https://github.com/a/b", "https://github.com/c/d"]);
    });

    it("says which pages still wait for a definite checkout answer, so focus can ask again", async () => {
        const replies: HostResponse[] = [
            { ok: false, code: "unavailable", error: "host down" },
            { ok: false, code: "no-checkout", error: "none" },
        ];
        const cache = checkoutCache(async () => replies.shift() ?? { ok: false, code: "failed", error: "none left" });

        expect(cache.answered("https://github.com/a/b")).toBe(false);
        await cache("https://github.com/a/b");
        // The host was down: nothing is kept, so a focus or a visible tab asks again.
        expect(cache.answered("https://github.com/a/b")).toBe(false);
        await cache("https://github.com/a/b");
        expect(cache.answered("https://github.com/a/b")).toBe(true);
    });

    it("sends focus to the page's main landmark when the dock disappears under it", () => {
        const attributes = new Map<string, string>();
        const main = {
            hasAttribute: (name: string) => attributes.has(name),
            setAttribute: (name: string, value: string) => {
                attributes.set(name, value);
            },
        };
        const body = { hasAttribute: () => true, setAttribute: () => undefined };

        expect(pageFocusTarget({ querySelector: () => main, body })).toBe(main);
        // A landmark only takes focus with a tabindex; -1 keeps it out of the tab order.
        expect(attributes.get("tabindex")).toBe("-1");
        expect(pageFocusTarget({ querySelector: () => null, body })).toBe(body);
    });

    it("recovers a checkout probe that throws instead of keeping the rejection", async () => {
        let calls = 0;
        const known = checkoutCache(async () => {
            calls++;

            if (calls === 1) {
                throw new Error("transport gone");
            }

            return { ok: false, code: "no-checkout", error: "none" };
        });

        expect(await known("https://github.com/a/b")).toBe(true);
        expect(await known("https://github.com/a/b")).toBe(false);
        expect(calls).toBe(2);
    });

    it("keeps a quick result open while it has the focus or the pointer", () => {
        const inside = "close button";
        const card = (hovered: boolean) => ({
            contains: (node: string | null) => node === inside,
            matches: (selector: string) => selector === ":hover" && hovered,
        });

        expect(quickCardMayClose(card(false), null)).toBe(true);
        expect(quickCardMayClose(card(false), inside)).toBe(false);
        expect(quickCardMayClose(card(true), null)).toBe(false);
    });

    it("hands focus to the new dock only when the replaced one held it", () => {
        const toggle = "GT toggle";
        const dock = { contains: (node: string | null) => node === toggle };

        expect(surfaceHoldsFocus(dock, toggle)).toBe(true);
        expect(surfaceHoldsFocus(dock, "a link on the page")).toBe(false);
        expect(surfaceHoldsFocus(dock, null)).toBe(false);
        expect(surfaceHoldsFocus(null, toggle)).toBe(false);
    });

    it("reads the PR head branch from GitHub's embedded page data only when it names this PR", () => {
        const data =
            '{"payload":{"pullRequest":{"number":424,"baseBranch":"master","headBranch":"feat/2026-09-26-enhancements"}}}';
        expect(headBranchFromEmbeddedData(data, 424)).toBe("feat/2026-09-26-enhancements");
        expect(headBranchFromEmbeddedData(data, 425)).toBeUndefined();
        expect(headBranchFromEmbeddedData(undefined, 424)).toBeUndefined();
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
            tools: () => ({ code: 0, stdout: "Usage: gitlab pr <iid> review [options]", stderr: "" }),
        });
        await startReview(deps, { url, branch: "feat/login" });
        const argv = calls.terminal[0]?.argv ?? [];
        expect(calls.terminal[0]?.cwd).toBe(worktree);
        const sentence = argv.at(-1) ?? "";
        expect(argv.slice(0, -1)).toEqual(parseConfig({}).agent.interactive);
        expect(sentence).toMatch(/^Read the task in .+-review-.+\.md and do it\.$/);
        const prompt = await Bun.file(sentence.replace(/^Read the task in (.+) and do it\.$/, "$1")).text();
        expect(prompt).toContain("tools gitlab pr 7 review --give --json");
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

describe("extension profiles", () => {
    it("finds a loaded, a disabled and an older build from Secure Preferences", () => {
        const home = makeTempDir("gt-ext-profiles-");
        const brave = join(home, "Library", "Application Support", "BraveSoftware", "Brave-Browser");
        const write = (profile: string, entry: unknown) => {
            mkdirSync(join(brave, profile), { recursive: true });
            writeFileSync(
                join(brave, profile, "Secure Preferences"),
                SafeJSON.stringify({ extensions: { settings: { abc: entry } } }, { strict: true })
            );
        };
        // 13435269976674978 µs since 1601 is 2026-09-30 19:26:16.674 UTC.
        write("Default", {
            granted_permissions: { explicit_host: ["https://a/*", "https://b/*"] },
            last_update_time: "13435269976674978",
        });
        write("Profile 4", {
            granted_permissions: { explicit_host: ["https://a/*", "https://b/*"] },
            last_update_time: "13435260000000000",
        });
        write("Profile 1", { granted_permissions: { explicit_host: ["https://a/*"] } });
        write("Profile 2", { disable_reasons: [1] });
        mkdirSync(join(brave, "Profile 3"), { recursive: true });

        const loadedAt = Date.UTC(2026, 8, 30, 19, 26, 16, 674);
        const builtAt = Date.UTC(2026, 8, 30, 19, 0, 0);
        const rows = extensionProfiles({ home, extensionId: "abc", wanted: ["https://a/*", "https://b/*"], builtAt });
        expect(rows).toEqual([
            { browser: "Brave", profile: "Default", loaded: true, stale: false, loadedAt },
            { browser: "Brave", profile: "Profile 1", loaded: true, stale: true, loadedAt: null },
            { browser: "Brave", profile: "Profile 2", loaded: false, stale: false, loadedAt: null },
            // Loaded before the build: the same hosts, but an older worker.
            { browser: "Brave", profile: "Profile 4", loaded: true, stale: true, loadedAt: expect.any(Number) },
        ]);
        rmSync(home, { recursive: true, force: true });
    });
});

function service(port: number, name: string, allowed: boolean): PlainNavigationService {
    return {
        port,
        name,
        allowExecuteByPlainBrowserNavigationMightBeDangerous: allowed,
        target: `http://localhost:${port}`,
    };
}

/** Never the machine's router config: a test must not depend on this Mac. */
const HOSTS: RouterHosts = {
    linkHost: "links.example.test",
    hosts: ["dashboard"],
    services: [
        service(3000, "Personal Dashboard", true),
        service(3096, "Artifact Library", true),
        service(8317, "AI Proxy", false),
    ],
};

/** What `tools browser-router explain --json` prints for a registered server's start and open. */
function serviceDecision(port: number, name: string, url: string): string {
    return SafeJSON.stringify({
        kind: "run",
        via: "route",
        argv: ["tools", "browser-router", "ensure", String(port)],
        url,
        service: { port, name },
    });
}

/** `explain` answers `decision`; `ensure` answers `ensured`, or THROWS when the test says nothing may start. */
function routerDeps({
    decision,
    ensured,
}: {
    decision: string;
    ensured?: { code: number; stdout: string; stderr: string };
}) {
    return fakeDeps({
        tools: (args) => {
            if (args[1] === "explain") {
                return { code: 0, stdout: decision, stderr: "" };
            }

            if (args[1] === "ensure" && ensured) {
                return ensured;
            }

            throw new Error(`nothing may start here, but it ran tools ${args.join(" ")}`);
        },
    });
}

describe("router", () => {
    it("hands a routed link to GenesisTools.app and keeps an unrouted one in the browser", async () => {
        const routed = fakeDeps({
            tools: () => ({ code: 0, stdout: '{"kind":"run","via":"route","argv":["tools","x"]}', stderr: "" }),
        });
        const explained = await explainLink(routed.deps, "https://links.example.test/tabs/work", HOSTS);
        expect(explained).toMatchObject({ handled: true, runs: true, routed: false, summary: "tools x" });
        expect(routed.calls.run).toEqual([]);
        expect(await routeLink(routed.deps, "https://links.example.test/tabs/work", HOSTS)).toMatchObject({
            routed: true,
        });
        expect(routed.calls.run[0]?.argv.slice(0, 3)).toEqual(["/usr/bin/open", "-b", "com.genesiscz.genesistools"]);
        // The link host takes plain http too, as the router's own link pattern does.
        expect(await explainLink(routed.deps, "http://links.example.test/tabs/work", HOSTS)).toMatchObject({
            handled: true,
        });

        const unrouted = fakeDeps({
            tools: () => ({
                code: 0,
                stdout: '{"kind":"open","via":"default","url":"https://links.example.test/x"}',
                stderr: "",
            }),
        });
        expect(await routeLink(unrouted.deps, "https://links.example.test/x", HOSTS)).toMatchObject({ handled: false });
        expect(unrouted.calls.run).toEqual([]);
        await expect(routeLink(unrouted.deps, "https://evil.example/x", HOSTS)).rejects.toThrow(
            "only the router's link host"
        );
    });

    it("takes a short service host and starts the server without asking for a click", async () => {
        const started = fakeDeps({
            tools: () => ({
                code: 0,
                stdout: '{"kind":"run","via":"route","argv":["tools","browser-router","ensure","3000"],"url":"http://localhost:3000/","service":{"port":3000,"name":"Personal Dashboard"}}',
                stderr: "",
            }),
        });
        expect(await explainLink(started.deps, "http://dashboard/", HOSTS)).toMatchObject({
            handled: true,
            runs: false,
            plainNavigation: true,
            summary: "start and open Personal Dashboard (http://localhost:3000/)",
        });
        // A saved route that runs something still waits for the click.
        const saved = fakeDeps({
            tools: () => ({ code: 0, stdout: '{"kind":"run","via":"route","argv":["tools","x"]}', stderr: "" }),
        });
        expect(await explainLink(saved.deps, "https://dashboard/", HOSTS)).toMatchObject({ runs: true });
        await expect(explainLink(saved.deps, "https://dashboardxyz/", HOSTS)).rejects.toThrow(
            "only the router's link host"
        );
        await expect(explainLink(saved.deps, "http://dashboard:8080/", HOSTS)).rejects.toThrow(
            "only the router's link host"
        );
    });

    it("reads a typed loopback address only when it is written out literally", () => {
        expect(loopbackPort("http://127.0.0.1:3096/")).toBe(3096);
        expect(loopbackPort("http://localhost:3096")).toBe(3096);
        expect(loopbackPort("http://localhost:3096/a/notes/index?x=1#top")).toBe(3096);

        for (const refused of [
            "https://127.0.0.1:3096/",
            "http://127.0.0.1:3096@evil.example/",
            "http://user:secret@127.0.0.1:3096/",
            "http://localhost.:3096/",
            "http://127.0.0.1.:3096/",
            "http://localhost.evil.example:3096/",
            "http://127.0.0.1.evil.example:3096/",
            "http://127.0.0.2:3096/",
            "http://0.0.0.0:3096/",
            "http://[::1]:3096/",
            "http://2130706433:3096/",
            "http://0x7f.0.0.1:3096/",
            "http://127.1:3096/",
            "http://LOCALHOST:3096/",
            "http://localhost:03096/",
            "http://localhost/",
            "http://localhost:80/",
            "http://localhost:3096\\a",
            "file:///etc/hosts",
            42,
        ]) {
            expect({ refused, port: loopbackPort(refused) }).toEqual({ refused, port: null });
        }
    });

    it("routes a loopback address only for a port whose downloaded flag is true", () => {
        expect(checkRouterLink("http://127.0.0.1:3096/", HOSTS)).toBe("http://127.0.0.1:3096/");
        expect(checkRouterLink("http://localhost:3096/a/notes/index?x=1#top", HOSTS)).toBe(
            "http://localhost:3096/a/notes/index?x=1#top"
        );

        for (const refused of [
            "http://127.0.0.1:8317/",
            "http://localhost:8317/",
            "http://127.0.0.1:3097/",
            "https://127.0.0.1:3096/",
            "http://127.0.0.1:3096@evil.example/",
            "http://localhost.:3096/",
            "http://localhost.evil.example:3096/",
            "http://127.0.0.1.evil.example:3096/",
            "http://127.0.0.2:3096/",
            "http://0.0.0.0:3096/",
            "http://[::1]:3096/",
            "http://2130706433:3096/",
        ]) {
            expect(() => checkRouterLink(refused, HOSTS)).toThrow("only the router's link host");
        }

        // The decision reads the downloaded list: the same address is refused once its flag reads false.
        const flipped = { ...HOSTS, services: [service(3096, "Artifact Library", false)] };
        expect(() => checkRouterLink("http://127.0.0.1:3096/", flipped)).toThrow("only the router's link host");
        expect(allowsPlainNavigation(flipped.services, 3096)).toBe(false);
    });

    it("never starts a server whose flag is false, even when explain names its service", async () => {
        const proxy = routerDeps({ decision: serviceDecision(8317, "AI Proxy", "http://localhost:8317/") });
        await expect(ensureLink(proxy.deps, "http://127.0.0.1:8317/", HOSTS)).rejects.toThrow(
            "only the router's link host"
        );
        await expect(explainLink(proxy.deps, "http://localhost:8317/", HOSTS)).rejects.toThrow(
            "only the router's link host"
        );
        expect(proxy.calls.tools).toEqual([]);

        // A dashboard name is the same decision: with its flag false it waits for a click and is never ensured here.
        const closed = { ...HOSTS, services: [service(3000, "Personal Dashboard", false)] };
        const named = routerDeps({ decision: serviceDecision(3000, "Personal Dashboard", "http://localhost:3000/") });
        expect(await explainLink(named.deps, "https://dashboard/", closed)).toMatchObject({
            runs: true,
            plainNavigation: false,
        });
        await expect(ensureLink(named.deps, "https://dashboard/", closed)).rejects.toThrow("needs a click");
        expect(named.calls.tools.filter((args) => args[1] === "ensure")).toEqual([]);

        // A loopback address must name the port of the server it starts.
        const elsewhere = routerDeps({
            decision: serviceDecision(3000, "Personal Dashboard", "http://localhost:3000/"),
        });
        await expect(ensureLink(elsewhere.deps, "http://127.0.0.1:3096/", HOSTS)).rejects.toThrow("needs a click");
        expect(elsewhere.calls.tools.filter((args) => args[1] === "ensure")).toEqual([]);
    });

    it("starts an allowed server and hands back the rewritten URL for the same tab, never to the app", async () => {
        const target = "http://localhost:3096/a/notes/index?x=1#top";
        const cold = routerDeps({
            decision: serviceDecision(3096, "Artifact Library", target),
            ensured: { code: 0, stdout: "started Artifact Library\n", stderr: "" },
        });
        expect(await ensureLink(cold.deps, "http://127.0.0.1:3096/a/notes/index?x=1#top", HOSTS)).toEqual({
            port: 3096,
            name: "Artifact Library",
            started: true,
            target,
        });
        expect(cold.calls.tools.map((args) => args.slice(0, 3))).toEqual([
            ["browser-router", "explain", "http://127.0.0.1:3096/a/notes/index?x=1#top"],
            ["browser-router", "ensure", "3096"],
        ]);
        expect(cold.calls.run).toEqual([]);
        // Handing it to GenesisTools.app would open a second tab.
        await expect(routeLink(cold.deps, "http://127.0.0.1:3096/", HOSTS)).rejects.toThrow("its own tab");
        expect(cold.calls.run).toEqual([]);

        // Something already listening is left alone and opened.
        const warm = routerDeps({
            decision: serviceDecision(3096, "Artifact Library", "http://localhost:3096/"),
            ensured: { code: 0, stdout: "Artifact Library is up\n", stderr: "" },
        });
        expect(await ensureLink(warm.deps, "http://localhost:3096/", HOSTS)).toMatchObject({ started: false });

        // A dashboard name whose flag is true starts the same way.
        const named = routerDeps({
            decision: serviceDecision(3000, "Personal Dashboard", "http://localhost:3000/"),
            ensured: { code: 0, stdout: "started Personal Dashboard\n", stderr: "" },
        });
        expect(await ensureLink(named.deps, "https://dashboard/", HOSTS)).toMatchObject({
            port: 3000,
            target: "http://localhost:3000/",
        });
    });

    it("a server that does not come up is an error naming its log, not a navigation", async () => {
        const dead = routerDeps({
            decision: serviceDecision(3096, "Artifact Library", "http://localhost:3096/"),
            ensured: {
                code: 1,
                stdout: "",
                stderr: "Artifact Library did not listen on 3096 within 20000ms. Log: /tmp/example/logs/day.log\n",
            },
        });
        await expect(ensureLink(dead.deps, "http://127.0.0.1:3096/", HOSTS)).rejects.toThrow(
            "Artifact Library did not start: Artifact Library did not listen on 3096 within 20000ms. Log: /tmp/example/logs/day.log"
        );
    });

    it("downloads the flag per port from the router config's service routes, true only when every route says so", () => {
        const route = (port: number, allowed?: boolean): RouteRule => ({
            pattern: `https?://example-${port}/(.*)`,
            action: {
                type: "service",
                port,
                name: `Server ${port}`,
                to: `http://localhost:${port}$1`,
                ...(allowed === undefined ? {} : { allowExecuteByPlainBrowserNavigationMightBeDangerous: allowed }),
            },
        });
        const config = {
            ...defaultRouterConfig(),
            routes: [
                route(3096, true),
                route(3096, true),
                route(3000, true),
                route(3000),
                route(8317),
                route(9886, false),
            ],
        };
        expect(plainNavigationServices(config)).toEqual([
            service(3000, "Server 3000", false),
            service(3096, "Server 3096", true),
            service(8317, "Server 8317", false),
            service(9886, "Server 9886", false),
        ]);
        expect(plainNavigationServices(null)).toEqual([]);
        // The reply the extension reads: anything that does not parse is dropped, and only a literal true counts.
        expect(
            readPlainNavigationServices({
                services: [
                    {
                        port: 3096,
                        name: "A",
                        target: "http://localhost:3096",
                        allowExecuteByPlainBrowserNavigationMightBeDangerous: true,
                    },
                    {
                        port: 3000,
                        name: "B",
                        target: "http://localhost:3000",
                        allowExecuteByPlainBrowserNavigationMightBeDangerous: "true",
                    },
                    { port: "8317", name: "C", target: "http://localhost:8317" },
                    { port: 70_000, name: "D", target: "http://localhost:70000" },
                ],
            })
        ).toEqual([service(3096, "A", true), service(3000, "B", false)]);
    });

    it("a build grants each allowed port its two loopback origins and never a wildcard", () => {
        const config = {
            ...defaultRouterConfig(),
            linkHost: "links.example.test",
            routes: [
                {
                    pattern: "x",
                    action: {
                        type: "service" as const,
                        port: 3096,
                        name: "Artifact Library",
                        to: "http://localhost:3096$1",
                        allowExecuteByPlainBrowserNavigationMightBeDangerous: true,
                    },
                },
                {
                    pattern: "y",
                    action: { type: "service" as const, port: 8317, name: "AI Proxy", to: "http://localhost:8317$1" },
                },
            ],
        };
        const granted = routerHostPermissions(config);
        expect(granted).toEqual([
            "https://links.example.test/*",
            "http://links.example.test/*",
            "http://127.0.0.1:3096/*",
            "http://localhost:3096/*",
        ]);
        expect(loopbackGrantCheck({ host_permissions: granted })).toMatchObject({
            ok: true,
            detail: "1 port(s): 3096",
        });

        for (const wide of [
            "http://127.0.0.1/*",
            "http://localhost/*",
            "http://*/*",
            "<all_urls>",
            "http://[::1]:3096/*",
        ]) {
            expect(loopbackGrantCheck({ host_permissions: [...granted, wide] })).toMatchObject({ ok: false });
        }

        expect(
            loopbackGrantCheck({
                host_permissions: granted,
                content_scripts: [{ matches: ["http://localhost:3096/*"] }],
            })
        ).toMatchObject({ ok: false });
        expect(loopbackGrantCheck({ host_permissions: ["http://127.0.0.1:3096/*"] })).toMatchObject({ ok: false });
        // The redirect names each port and both hosts, so a suffix host or another port never matches.
        const rule = new RegExp(loopbackRegex([3096, 3000]));
        expect(rule.test("http://127.0.0.1:3096/")).toBe(true);
        expect(rule.test("http://localhost:3000/a?b")).toBe(true);
        expect(rule.test("http://127.0.0.1:30960/")).toBe(false);
        expect(rule.test("http://localhost.evil.example:3096/")).toBe(false);
        expect(rule.test("http://127.0.0.1:8317/")).toBe(false);
    });

    it("the service list and the start are commands only the extension's own pages may send", () => {
        expect(EXTENSION_PAGE_COMMANDS).toContain("router.services");
        expect(EXTENSION_PAGE_COMMANDS).toContain("router.ensure");
    });
});

describe("extension freshness", () => {
    it("rebuild when dist is stale, reload when dist is newer than the running build, else current", () => {
        expect(freshnessOf("b1", { distBuildId: "b1", stale: true })).toBe("rebuild");
        expect(freshnessOf("b1", { distBuildId: "b2", stale: false })).toBe("reload");
        expect(freshnessOf("b1", { distBuildId: "b1", stale: false })).toBe("current");
    });

    it("names the commit range of an update, with the count behind", () => {
        const range = updateRangeFromReply({
            ok: true,
            data: { fromCommit: "a1b2c3d", toCommit: "e4f5a6b", behind: 12 },
        });
        expect(describeUpdateRange(range)).toBe("a1b2c3d → e4f5a6b (12 commits behind)");
        expect(describeUpdateRange({ fromCommit: "a1b2c3d", toCommit: "e4f5a6b", behind: 1 })).toBe(
            "a1b2c3d → e4f5a6b (1 commit behind)"
        );
        expect(describeUpdateRange({ fromCommit: "a1b2c3d", toCommit: "a1b2c3d", behind: null })).toBe(
            "a1b2c3d (local changes)"
        );
        expect(describeUpdateRange(updateRangeFromReply({ ok: false }))).toBeNull();
    });

    it("a build id maps to its commit through the history in build.json, and the history is capped", async () => {
        const dir = makeTempDir("gt-ext-commits-");
        writeFileSync(join(dir, "a.js"), "x");

        for (let i = 0; i < 32; i++) {
            await writeBuildInfo(dir, `build-${i}`, `sha${i}`);
        }

        const info = await readBuildInfo(dir);
        expect(info?.commit).toBe("sha31");
        expect(Object.keys(info?.commits ?? {})).toHaveLength(30);
        expect(info?.commits["build-2"]).toBe("sha2");
        expect(info?.commits["build-1"]).toBeUndefined();
    });

    it("two builds of the same inputs have the same stamp, and a changed file does not", async () => {
        const dir = makeTempDir("gt-ext-stamp-");
        writeFileSync(join(dir, "a.js"), 'const build = "id-one";');
        const first = await buildStamp(dir, "id-one");
        writeFileSync(join(dir, "a.js"), 'const build = "id-two";');
        expect(await buildStamp(dir, "id-two")).toBe(first);
        writeFileSync(join(dir, "a.js"), 'const build = "id-two"; const extra = 1;');
        expect(await buildStamp(dir, "id-two")).not.toBe(first);
        rmSync(dir, { recursive: true, force: true });
    });
});

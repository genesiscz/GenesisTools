import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerCmuxCommand } from "@app/claude/commands/cmux";
import { applyPresets, presets } from "@genesiscz/utils/browser-router/presets";
import { defaultRouterConfig, route } from "@genesiscz/utils/browser-router/route";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { Command } from "commander";
import {
    findInTranscript,
    pressesToOldest,
    searchCount,
    TRANSCRIPT_BANNER,
    type TranscriptIO,
} from "./transcript-find";

const PROMPT = "some reply\n────\n❯ \n────\n  ⏵⏵ auto mode on";
const BANNER = `some reply\n────\n  ${TRANSCRIPT_BANNER} · ctrl+o to toggle · ? for shortcuts      verbose`;

/** A fake Claude Code screen: ctrl+o opens the transcript, `/` the search bar, Enter shows `hit`. */
function fakeClaude({ opens = true, hit }: { opens?: boolean; hit: string }) {
    const typed: string[] = [];
    let screen = PROMPT;
    let query = "";
    let current = 0;

    const io: TranscriptIO = {
        screen: async () => screen,
        key: async (name) => {
            typed.push(`key:${name}`);

            if (name === "ctrl+o") {
                screen = screen === PROMPT ? (opens ? BANNER : PROMPT) : PROMPT;
            }

            if (name === "enter" && screen.endsWith(`/${query}`)) {
                screen = `${BANNER.split("\n  ")[0]}\n  ${hit}`;
                current = Number(hit.match(/(\d+)\/\d+$/)?.[1] ?? 0);
            }
        },
        text: async (value) => {
            typed.push(value);

            if (value === "/" && screen === BANNER) {
                screen = `${BANNER.split("\n  ")[0]}\n  /`;
            } else if (screen.endsWith("/")) {
                query = value;
                screen = `${screen}${value}`;
            } else if (value === "n") {
                const total = Number(hit.match(/\/(\d+)$/)?.[1] ?? 0);
                current = (current % total) + 1;
                screen = `ctrl+o to toggle · n/N to navigate   ${current}/${total}`;
            }
        },
        sleep: async () => {},
    };

    return { io, typed, current: () => current };
}

describe("transcript find", () => {
    test("free-text links parse as literal operands through the real cmux command", async () => {
        const host = "links.example.test";
        const chosen = { ...defaultRouterConfig(), linkHost: host, presets: { "claude-find": {} } };
        const config = { ...chosen, routes: applyPresets([], presets({ config: chosen, check: () => true })) };

        for (const query of ["--help", "--link", "--decision", "-n", "normal text"]) {
            const plan = route(`https://${host}/claude/find/session?q=${encodeURIComponent(query)}&at=oldest`, config);
            expect(plan.kind).toBe("run");

            if (plan.kind !== "run") {
                throw new Error("find link must run its command");
            }

            let parsed: unknown;
            const program = new Command().name("claude").exitOverride();
            registerCmuxCommand(program);
            const find = program.commands
                .find((command) => command.name() === "cmux")
                ?.commands.find((command) => command.name() === "find");

            if (!find) {
                throw new Error("the real cmux command must register find");
            }

            // Replace only the effectful action; arguments, flags and defaults stay the real command's.
            find.action((session, text, options) => {
                parsed = { session, text, options };
            });
            await program.parseAsync(plan.argv.slice(2), { from: "user" });
            expect(parsed).toEqual({
                session: "session",
                text: query,
                options: { at: "oldest", uses: "1", activate: true },
            });
        }
    });

    test("printed decision links preserve default and explicit positions through the real command", async () => {
        const host = "links.example.test";
        const gate = {
            version: 2,
            at: Date.now(),
            configMtimeMs: 0,
            installed: true,
            defaultHandler: true,
            httpsHandler: "fixture.router",
            configured: true,
            linkHost: host,
            presets: { "claude-find": { available: true, enabled: true, routed: true, missing: [] } },
        };
        const source = `
            import { mock } from "bun:test";
            const gates = await import("@genesiscz/utils/browser-router/link-gate");
            mock.module("@genesiscz/utils/browser-router/link-gate", () => ({
                ...gates, linkGate: () => (${SafeJSON.stringify(gate)}),
            }));
            const { findCommand } = await import("@app/claude/commands/cmux/find");
            const { out } = await import("@genesiscz/utils/logger");
            for (const at of [undefined, "oldest", "newest"]) {
                await findCommand("fixture", undefined, { decision: "7", at, link: true });
            }
            await out.flush();
        `;
        const proc = Bun.spawn([process.execPath, "-e", source], {
            cwd: join(import.meta.dir, "../../../.."),
            env: env.getProcessEnv(),
            stdout: "pipe",
            stderr: "pipe",
        });
        const [stdout, stderr, code] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);
        expect({ code, stderr }).toMatchObject({ code: 0 });
        const links = [...stdout.matchAll(/\]\((https:[^)]+)\)/g)].map((match) => match[1]);
        expect(links).toHaveLength(3);
        const chosen = { ...defaultRouterConfig(), linkHost: host, presets: { "claude-find": {} } };
        const config = { ...chosen, routes: applyPresets([], presets({ config: chosen, check: () => true })) };

        for (const [index, at] of [undefined, "oldest", "newest"].entries()) {
            expect(new URL(links[index]).searchParams.get("at")).toBe(at ?? null);
            const plan = route(links[index], config);
            expect(plan.kind).toBe("run");

            if (plan.kind !== "run") {
                throw new Error("decision link must run find");
            }

            let parsed: unknown;
            const program = new Command().name("claude").exitOverride();
            registerCmuxCommand(program);
            const find = program.commands
                .find((command) => command.name() === "cmux")
                ?.commands.find((command) => command.name() === "find");

            if (!find) {
                throw new Error("the real command must register find");
            }

            find.action((session, text, options) => {
                parsed = { session, text, decision: options.decision, at: options.at || undefined };
            });
            await program.parseAsync(plan.argv.slice(2), { from: "user" });
            expect(parsed).toEqual({ session: "fixture", text: undefined, decision: "7", at });
        }
    });

    test("reads the match counter and the no-match marker from the bottom line", () => {
        expect(searchCount("x\n  /DECISION 2                    no matches  ")).toBe("none");
        expect(searchCount("x\n  ctrl+o to toggle · n/N to navigate     3/4  ")).toEqual({ current: 3, total: 4 });
        expect(searchCount(BANNER)).toBeNull();
    });

    test("n wraps from the newest match to the first", () => {
        expect(pressesToOldest({ current: 4, total: 4 })).toBe(1);
        expect(pressesToOldest({ current: 2, total: 4 })).toBe(3);
        expect(pressesToOldest({ current: 1, total: 4 })).toBe(0);
    });

    test("lands on the oldest match", async () => {
        const claude = fakeClaude({ hit: "ctrl+o to toggle · n/N to navigate   4/4" });
        const outcome = await findInTranscript(claude.io, { query: "DECISION 7", oldest: true, timeoutMs: 0 });

        expect(outcome).toEqual({ found: true, current: 1, total: 4 });
        expect(claude.current()).toBe(1);
        expect(claude.typed).toEqual(["key:ctrl+o", "/", "DECISION 7", "key:enter", "n"]);
    });

    test("confirms delayed oldest navigation before reporting match one", async () => {
        const claude = fakeClaude({ hit: "ctrl+o to toggle · n/N to navigate   4/4" });
        const read = claude.io.screen;
        const type = claude.io.text;
        let waiting = false;
        let polls = 0;
        claude.io.text = async (text) => {
            await type(text);
            waiting = text === "n";
        };
        claude.io.screen = async () => {
            if (waiting && polls++ === 0) {
                return "ctrl+o to toggle · n/N to navigate   4/4";
            }

            return read();
        };

        expect(await findInTranscript(claude.io, { query: "DECISION 7", oldest: true })).toEqual({
            found: true,
            current: 1,
            total: 4,
        });
        expect(polls).toBe(2);
    });

    test("reports the observed counter when an oldest keypress is dropped", async () => {
        const claude = fakeClaude({ hit: "ctrl+o to toggle · n/N to navigate   4/4" });
        const type = claude.io.text;
        claude.io.text = async (text) => {
            if (text !== "n") {
                await type(text);
            }
        };

        expect(await findInTranscript(claude.io, { query: "DECISION 7", oldest: true, timeoutMs: 0 })).toEqual({
            found: true,
            current: 4,
            total: 4,
        });
    });

    test("types nothing after ctrl+o when the transcript view does not open", async () => {
        const claude = fakeClaude({ opens: false, hit: "1/1" });
        const outcome = await findInTranscript(claude.io, { query: "DECISION 7", oldest: true, timeoutMs: 0 });

        expect(outcome).toEqual({ found: false, reason: "no-transcript" });
        expect(claude.typed).toEqual(["key:ctrl+o"]);
    });

    test("waits through an intermediate transcript banner for the result", async () => {
        const claude = fakeClaude({ hit: "ctrl+o to toggle · n/N to navigate   2/2" });
        const read = claude.io.screen;
        let afterEnter = false;
        const key = claude.io.key;
        claude.io.key = async (name) => {
            await key(name);
            afterEnter = name === "enter";
        };
        claude.io.screen = async () => {
            if (afterEnter) {
                afterEnter = false;
                return BANNER;
            }

            return read();
        };
        const outcome = await findInTranscript(claude.io, { query: "needle", oldest: false });

        expect(outcome).toEqual({ found: true, current: 2, total: 2 });
        expect(claude.typed).toEqual(["key:ctrl+o", "/", "needle", "key:enter"]);
    });

    test("a banner without a result reaches the deadline", async () => {
        const claude = fakeClaude({ hit: TRANSCRIPT_BANNER });
        const outcome = await findInTranscript(claude.io, { query: "needle", oldest: false, timeoutMs: 0 });

        expect(outcome).toEqual({ found: false, reason: "no-result" });
        expect(claude.typed.at(-1)).toBe("key:ctrl+o");
    });

    test("the command sends literal backslashes through RPC and keeps Enter a named key", async () => {
        const dir = await mkdtemp(join(tmpdir(), "cmux-find-transport-"));
        const executable = join(dir, "cmux");
        const capture = join(dir, "args");
        await Bun.write(executable, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${capture}'\n`);
        await chmod(executable, 0o755);
        const query = String.raw`literal\nq\t`;
        const source = `
            import { mock } from "bun:test";
            mock.module("@app/claude/commands/cmux/read", () => ({
                locatePane: async () => ({ surfaceId: "surface:42", target: { workspaceId: "workspace:1" } }),
            }));
            mock.module("@app/claude/commands/cmux/focus", () => ({
                focusTarget: async () => {}, activateApp: async () => { throw new Error("must not activate"); },
            }));
            mock.module("@app/claude/lib/cmux/transcript-find", () => ({
                findInTranscript: async (io, { query }) => {
                    await io.text(query);
                    await io.key("enter");
                    return { found: true, current: 1, total: 1 };
                },
            }));
            const { findCommand } = await import("@app/claude/commands/cmux/find");
            await findCommand("fixture", ${SafeJSON.stringify(query)}, { activate: false });
            await findCommand("fixture", "line\\n\\ttext", { activate: false });
        `;
        const proc = Bun.spawn([process.execPath, "-e", source], {
            cwd: join(import.meta.dir, "../../../.."),
            env: { ...env.getProcessEnv(), PATH: `${dir}:${env.getProcessEnv().PATH ?? ""}` },
            stdout: "pipe",
            stderr: "pipe",
        });
        const [stdout, stderr, code] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);
        expect({ code, stdout, stderr }).toMatchObject({ code: 0 });
        const args = (await Bun.file(capture).text()).trimEnd().split("\n");
        expect(args.slice(0, 2)).toEqual(["rpc", "surface.send_text"]);
        expect(SafeJSON.parse(args[2])).toEqual({ surface_id: "surface:42", text: query });
        expect(args[3]).toBe("send-key");
        expect(args).not.toContain("send");
        expect(args).toContain("enter");
        const second = args.indexOf("rpc", 3);
        expect(SafeJSON.parse(args[second + 2])).toEqual({ surface_id: "surface:42", text: "line  text" });
    });

    test("search-bar failure restores only a transcript this call opened", async () => {
        for (const alreadyOpen of [false, true]) {
            const claude = fakeClaude({ hit: "ctrl+o to toggle · n/N to navigate   1/1" });

            if (alreadyOpen) {
                await claude.io.key("ctrl+o");
                claude.typed.length = 0;
            }

            const read = claude.io.screen;
            claude.io.screen = async () => {
                const screen = await read();
                return screen.endsWith("/") ? BANNER : screen;
            };
            expect(await findInTranscript(claude.io, { query: "needle", oldest: false, timeoutMs: 0 })).toEqual({
                found: false,
                reason: "no-search-bar",
            });
            expect(claude.typed).toEqual(alreadyOpen ? ["/"] : ["key:ctrl+o", "/", "key:ctrl+o"]);
        }
    });

    test("a miss closes the transcript view it opened", async () => {
        const claude = fakeClaude({ hit: "ctrl+o to toggle · n/N to navigate      no matches" });
        const outcome = await findInTranscript(claude.io, { query: "nothing", oldest: true, timeoutMs: 0 });

        expect(outcome).toEqual({ found: false, reason: "no-match" });
        expect(claude.typed.at(-1)).toBe("key:ctrl+o");
    });
});

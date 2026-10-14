import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isProcessAlive } from "@genesiscz/utils/process-alive";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { processFixture } from "./__tests__/process-fixture";
import {
    type BackgroundLaunch,
    CdpLaunchError,
    COLD_PROFILE_TIMEOUT_MS,
    closeBrowserOnPort,
    DEFAULT_LAUNCH_TIMEOUT_MS,
    launchArgs,
    launchCdpBrowser,
    openBackgroundWindow,
    type QuitDeps,
    quitOwnedBrowser,
    withDisabledFeatures,
} from "./launch.ts";
import type { ExecFn } from "./platform.ts";
import { openRecordingBrowser } from "./recording-browser";

/** An `lsof -nP -iTCP -sTCP:LISTEN` row for `pid` on `port`. */
const listener = (pid: number, address = "127.0.0.1", port = 9333) =>
    `Google ${pid} work 50u IPv4 0x1 0t0 TCP ${address}:${port} (LISTEN)`;

/**
 * A fake machine: these listener rows for `lsof`, these `pid ppid command` rows for `ps`. `ps -o comm= -p <pid>`
 * answers the row's executable, which these rows keep before their first ` --` flag.
 */
function machine(listeners: string[], processes: string[]): ExecFn {
    return processFixture((argv) => {
        const pidAt = argv.indexOf("-p");

        if (argv[0] === "ps" && pidAt !== -1) {
            const row = processes.find((r) => r.trim().split(/\s+/)[0] === argv[pidAt + 1]);
            const executable = row?.replace(/^\s*\d+\s+\d+\s+/, "").split(" --")[0];

            return { exitCode: executable ? 0 : 1, stdout: executable ?? "", stderr: "" };
        }

        return { exitCode: 0, stdout: (argv[0] === "lsof" ? listeners : processes).join("\n"), stderr: "" };
    });
}

/** A quit path must never reach a real browser: one listens on 9222 on a developer's Mac. */
const noBrowser: QuitDeps = {
    connect: async () => {
        throw new Error("no browser in tests");
    },
    exec: machine([], []),
    platform: "darwin",
};

describe("launchArgs (PR #326 review — the profile-isolation rule, pinned)", () => {
    test("a plain launch carries the debug port and NO --user-data-dir (the real profile)", () => {
        const args = launchArgs(9222, {});
        expect(args).toContain("--remote-debugging-port=9222");
        expect(args.some((a) => a.startsWith("--user-data-dir"))).toBe(false);
        expect(args.some((a) => a.startsWith("--load-extension"))).toBe(false);
    });

    test("the real profile NEVER gets the private-network downgrade flag, only the code-sign-clone switch", () => {
        expect(launchArgs(9222, {}).filter((a) => a.startsWith("--disable-features"))).toEqual([
            "--disable-features=MacAppCodeSignClone",
        ]);
    });

    test("--fresh isolates into a unique /tmp profile so the user's own profile stays untouched", () => {
        // A fixed /tmp/cdp-profile-9223 used to be reused on every run, so a --fresh profile was
        // never really throwaway: see freshProfileDir's own uniqueness test in resolve-attach.test.ts.
        const args = launchArgs(9223, { fresh: true });
        expect(args.find((a) => a.startsWith("--user-data-dir="))).toMatch(/^--user-data-dir=\/tmp\/cdp-profile-9223-/);
        expect(args).toContain(
            "--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks,MacAppCodeSignClone"
        );
    });

    test("--extension implies its own profile and restricts loaded extensions to the one given", () => {
        const args = launchArgs(9333, { extension: "/dist/ext" });
        expect(args.find((a) => a.startsWith("--user-data-dir="))).toMatch(/^--user-data-dir=\/tmp\/cdp-profile-9333-/);
        expect(args).toContain("--load-extension=/dist/ext");
        expect(args).toContain("--disable-extensions-except=/dist/ext");
    });
});

describe("launchArgs — --profile-directory", () => {
    test("names the profile so a multi-profile browser opens no picker", () => {
        const args = launchArgs(9222, { profileDirectory: "Profile 1" });
        expect(args).toContain("--profile-directory=Profile 1");
        // It selects a profile INSIDE the real user-data-dir, so it must not drag
        // the launch off the user's own profile the way --fresh does.
        expect(args.some((a) => a.startsWith("--user-data-dir"))).toBe(false);
    });

    test("is absent unless asked for, so `open` keeps its previous behaviour", () => {
        expect(launchArgs(9222, {}).some((a) => a.startsWith("--profile-directory"))).toBe(false);
    });
});

describe("launchArgs — an explicit profile dir", () => {
    test("isolates using the dir given instead of /tmp/cdp-profile-<port>", () => {
        const args = launchArgs(9333, { userDataDir: "/tmp/genesis-yt-devtools-chrome-abc", extension: "/dist/ext" });
        expect(args).toContain("--user-data-dir=/tmp/genesis-yt-devtools-chrome-abc");
        expect(args.some((a) => a === "--user-data-dir=/tmp/cdp-profile-9333")).toBe(false);
    });

    test("a caller that made the dir for this launch declares it disposable and gets the downgrade", () => {
        const args = launchArgs(9333, {
            userDataDir: "/tmp/genesis-yt-devtools-chrome-abc",
            extension: "/dist/ext",
            disposableProfile: true,
        });
        expect(args).toContain(
            "--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks,MacAppCodeSignClone"
        );
    });

    test("a persistent --user-data-dir alone keeps the network protections: it holds logins like the real profile", () => {
        const args = launchArgs(9444, { userDataDir: "/Users/x/.genesis-tools/chrome-devtools/chrome/profile" });
        expect(args).toContain("--user-data-dir=/Users/x/.genesis-tools/chrome-devtools/chrome/profile");
        expect(args.filter((a) => a.startsWith("--disable-features"))).toEqual([
            "--disable-features=MacAppCodeSignClone",
        ]);
    });

    // PR #374 review: --extension and --fresh both used to force the downgrade, and
    // the explicit dir won the path, so `open --user-data-dir <logins> --extension x`
    // ran the credential-bearing profile with the protections off.
    test("--extension or --fresh beside a persistent --user-data-dir still keeps the protections", () => {
        const profile = "/Users/x/.genesis-tools/chrome-devtools/chrome/profile";
        for (const opts of [{ extension: "/dist/ext" }, { fresh: true }, { fresh: true, extension: "/dist/ext" }]) {
            const args = launchArgs(9445, { ...opts, userDataDir: profile });
            expect(args).toContain(`--user-data-dir=${profile}`);
            expect(args.filter((a) => a.startsWith("--disable-features"))).toEqual([
                "--disable-features=MacAppCodeSignClone",
            ]);
        }
    });
});

const okLaunch = () => ({ ok: true, message: "launched" });
const liveProbe = async (port: number) => ({ port, browser: "Chrome/151", pages: [{ url: "about:blank" }] });
const deadProbe = async () => null;
const neverUp = async () => false;
const cameUp = async () => true;

describe("launchCdpBrowser", () => {
    test("a plain launch goes through launchBrowser and reports the probed browser", async () => {
        const seen: string[][] = [];
        const result = await launchCdpBrowser({
            port: 9222,
            url: "https://example.com",
            launch: (o) => {
                seen.push([...o.args, ...(o.url === undefined ? [] : [o.url])]);

                return okLaunch();
            },
            probe: liveProbe,
            waitFor: cameUp,
        });
        expect(result).toEqual({ pid: null, port: 9222, userDataDir: null, browser: "Chrome/151", pages: 1 });
        expect(seen[0]).toEqual([
            "--remote-debugging-port=9222",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-features=MacAppCodeSignClone",
            "https://example.com",
        ]);
    });

    test("a refused spawn throws stage 'spawn' carrying the launcher's own message", async () => {
        const err = await launchCdpBrowser({
            port: 9222,
            launch: () => ({ ok: false, message: "brave is not installed" }),
            probe: liveProbe,
            waitFor: cameUp,
        }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(CdpLaunchError);
        expect((err as CdpLaunchError).stage).toBe("spawn");
        expect((err as CdpLaunchError).message).toBe("brave is not installed");
    });

    test("an unknown browser id throws instead of falling back to chrome", async () => {
        const err = await launchCdpBrowser({ port: 9222, browser: "bave", waitFor: cameUp }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(CdpLaunchError);
        expect((err as CdpLaunchError).message).toContain("bave");
    });

    test("with a logPath it spawns the binary itself, so the caller gets a real pid", async () => {
        const spawned: { cmd: string[]; logPath: string }[] = [];
        const result = await launchCdpBrowser({
            port: 9333,
            extension: "/dist/ext",
            userDataDir: "/tmp/profile",
            url: "https://www.youtube.com",
            logPath: "/tmp/profile.log",
            spawnLogged: (cmd, logPath) => {
                spawned.push({ cmd, logPath });

                return { pid: 4242, kill: () => {} };
            },
            probe: liveProbe,
            waitFor: cameUp,
        });
        expect(result.pid).toBe(4242);
        expect(result.userDataDir).toBe("/tmp/profile");
        expect(spawned[0].logPath).toBe("/tmp/profile.log");
        expect(spawned[0].cmd).toContain("--load-extension=/dist/ext");
        expect(spawned[0].cmd.at(-1)).toBe("https://www.youtube.com");
    });

    test("a port that never answers kills the child and throws with the log tail", async () => {
        let killed = false;
        const err = await launchCdpBrowser({
            port: 9333,
            logPath: "/tmp/profile.log",
            spawnLogged: () => ({
                pid: 7,
                kill: () => {
                    killed = true;
                },
            }),
            probe: deadProbe,
            waitFor: neverUp,
            readLog: async () => "[0903/101500] ERROR: could not load extension\n",
            quit: noBrowser,
        }).catch((e: unknown) => e);
        expect(killed).toBe(true);
        expect(err).toBeInstanceOf(CdpLaunchError);
        expect((err as CdpLaunchError).stage).toBe("timeout");
        expect((err as CdpLaunchError).childQuit).toBe(true);
        expect((err as CdpLaunchError).logTail).toContain("could not load extension");
        expect((err as CdpLaunchError).message).toContain("could not load extension");
    });

    test("an unreadable log still produces an error, never an unhandled throw", async () => {
        const err = await launchCdpBrowser({
            port: 9333,
            logPath: "/tmp/gone.log",
            spawnLogged: () => ({ pid: 7, kill: () => {} }),
            probe: deadProbe,
            waitFor: neverUp,
            readLog: async () => {
                throw new Error("ENOENT");
            },
            quit: noBrowser,
        }).catch((e: unknown) => e);
        expect((err as CdpLaunchError).logTail).toBe("(log unreadable)");
    });

    test("--fresh: the reported userDataDir is the SAME directory the browser was actually launched with", async () => {
        // Regression test: #454 — freshProfileDir() now returns a unique path per call. launchArgs
        // and launchCdpBrowser each used to call it separately for the --fresh/--extension case, so
        // the returned `userDataDir` and the real `--user-data-dir=` flag could name two different
        // directories once the function stopped being deterministic.
        const seen: string[][] = [];
        const result = await launchCdpBrowser({
            port: 9224,
            fresh: true,
            launch: (o) => {
                seen.push(o.args);

                return okLaunch();
            },
            probe: liveProbe,
            waitFor: cameUp,
        });
        const flag = seen[0]?.find((a) => a.startsWith("--user-data-dir="));
        expect(flag).toBe(`--user-data-dir=${result.userDataDir}`);
    });

    test("a cold profile waits 30s; the user's real profile waits 20s", async () => {
        const waits: number[] = [];
        const waitFor = async (o: { timeoutMs?: number }) => {
            waits.push(o.timeoutMs ?? -1);

            return true;
        };
        await launchCdpBrowser({ port: 9222, launch: okLaunch, probe: liveProbe, waitFor });
        await launchCdpBrowser({ port: 9223, fresh: true, launch: okLaunch, probe: liveProbe, waitFor });
        expect(waits).toEqual([DEFAULT_LAUNCH_TIMEOUT_MS, COLD_PROFILE_TIMEOUT_MS]);
        expect(COLD_PROFILE_TIMEOUT_MS).toBe(30_000);
    });

    test("an explicit timeoutMs wins over both defaults", async () => {
        const waits: number[] = [];
        await launchCdpBrowser({
            port: 9222,
            timeoutMs: 5_000,
            launch: okLaunch,
            probe: liveProbe,
            waitFor: async (o: { timeoutMs?: number }) => {
                waits.push(o.timeoutMs ?? -1);

                return true;
            },
        });
        expect(waits).toEqual([5_000]);
    });
});

describe("one --disable-features flag (Chrome reads only the last one)", () => {
    test("every list merges into one flag at the first one's place, without duplicates", () => {
        expect(
            withDisabledFeatures(
                ["--a", "--disable-features=One,Two", "--b", "--disable-features=Two,Three"],
                ["MacAppCodeSignClone"]
            )
        ).toEqual(["--a", "--disable-features=One,Two,Three,MacAppCodeSignClone", "--b"]);
        expect(withDisabledFeatures(["--a"], ["MacAppCodeSignClone"])).toEqual([
            "--a",
            "--disable-features=MacAppCodeSignClone",
        ]);
    });

    test("launchArgs emits exactly one flag for every profile kind", () => {
        for (const opts of [
            {},
            { fresh: true },
            { extension: "/dist/ext" },
            { userDataDir: "/x", disposableProfile: true },
        ]) {
            expect(launchArgs(9222, opts).filter((a) => a.startsWith("--disable-features"))).toHaveLength(1);
        }
    });
});

describe("background launch (the user keeps focus, macOS)", () => {
    const windowArgs = ["--window-position=-1280,0", "--window-size=1280,775"];
    const fakeBackground = () => {
        const opened: Array<{ port: number; url: string }> = [];
        const background: BackgroundLaunch = {
            windowArgs: async () => windowArgs,
            openWindow: async (port, url) => {
                opened.push({ port, url });
            },
        };

        return { background, opened };
    };
    const spawnInto = (spawned: string[][]) => (cmd: string[]) => {
        spawned.push(cmd);

        return { pid: 4242, kill: () => {} };
    };

    test.each([false, true])("an occupied port refuses background launch before spawn, owned=%s", async (logged) => {
        for (const address of ["127.0.0.1", "[::1]"]) {
            const { background, opened } = fakeBackground();
            let spawned = 0;
            let waited = 0;
            const launching = launchCdpBrowser({
                port: 9555,
                fresh: true,
                url: "https://example.com/private",
                platform: "darwin",
                background,
                ...(logged ? { logPath: "/tmp/profile.log" } : {}),
                quit: { ...noBrowser, exec: machine([listener(5353, address, 9555)], []) },
                spawnLogged: () => {
                    spawned++;
                    throw new Error("occupied port reached the owned spawn");
                },
                launch: () => {
                    spawned++;
                    throw new Error("occupied port reached Launch Services");
                },
                waitFor: async () => {
                    waited++;
                    return true;
                },
                probe: liveProbe,
            });
            await expect(launching).rejects.toMatchObject({ stage: "spawn", childQuit: false });
            await expect(launching).rejects.toThrow("already occupied");
            expect(spawned).toBe(0);
            expect(waited).toBe(0);
            expect(opened).toEqual([]);
        }
    });

    test("an isolated profile starts without a window and opens the url inactive once CDP answers", async () => {
        const { background, opened } = fakeBackground();
        const spawned: string[][] = [];
        await launchCdpBrowser({
            port: 9555,
            fresh: true,
            url: "https://example.com/app",
            logPath: "/tmp/profile.log",
            platform: "darwin",
            background,
            quit: noBrowser,
            spawnLogged: spawnInto(spawned),
            probe: liveProbe,
            waitFor: cameUp,
        });
        expect(spawned[0]).toContain("--no-startup-window");
        expect(spawned[0]).toEqual(expect.arrayContaining(windowArgs));
        expect(spawned[0]).not.toContain("https://example.com/app");
        expect(opened).toEqual([{ port: 9555, url: "https://example.com/app" }]);
    });

    test("through `open` it asks Launch Services not to bring the app forward, and passes no url", async () => {
        const { background } = fakeBackground();
        const launches: Array<{ url?: string; background?: boolean }> = [];
        await launchCdpBrowser({
            port: 9556,
            fresh: true,
            platform: "darwin",
            background,
            quit: noBrowser,
            launch: (o) => {
                launches.push({ url: o.url, background: o.background });

                return okLaunch();
            },
            probe: liveProbe,
            waitFor: cameUp,
        });
        expect(launches).toEqual([{ url: undefined, background: true }]);
    });

    test("the real profile and other platforms launch exactly as before", async () => {
        for (const run of [
            { platform: "darwin" as const, fresh: false },
            { platform: "linux" as const, fresh: true },
        ]) {
            const { background, opened } = fakeBackground();
            const spawned: string[][] = [];
            await launchCdpBrowser({
                port: 9557,
                fresh: run.fresh,
                url: "https://example.com/app",
                logPath: "/tmp/profile.log",
                platform: run.platform,
                background,
                spawnLogged: spawnInto(spawned),
                probe: liveProbe,
                waitFor: cameUp,
            });
            expect(spawned[0]).not.toContain("--no-startup-window");
            expect(spawned[0].at(-1)).toBe("https://example.com/app");
            expect(opened).toEqual([]);
        }
    });

    test("off-macOS background requests log one fallback and skip the placement probe", async () => {
        const oldLevel = logger.level;
        const chunks: string[] = [];
        const stderr = spyOn(process.stderr, "write").mockImplementation((chunk) => {
            chunks.push(String(chunk));
            return true;
        });
        logger.level = "debug";
        let placements = 0;
        try {
            await launchCdpBrowser({
                port: 9557,
                fresh: true,
                platform: "linux",
                background: {
                    windowArgs: async () => {
                        placements++;
                        return windowArgs;
                    },
                    openWindow: async () => {
                        throw new Error("background window must not open");
                    },
                },
                launch: okLaunch,
                probe: liveProbe,
                waitFor: cameUp,
            });
            await Bun.sleep(20);
            expect(placements).toBe(0);
            expect(chunks.join("").match(/background window placement is macOS-only/g)).toHaveLength(1);
        } finally {
            logger.level = oldLevel;
            stderr.mockRestore();
        }
    });

    test("empty placement preserves the startup window for both launch paths and separate profile kinds", async () => {
        for (const profile of [{ fresh: true }, { extension: "/dist/ext" }, { userDataDir: "/tmp/persistent" }]) {
            for (const logged of [false, true]) {
                const commands: string[][] = [];
                const { background, opened } = fakeBackground();
                background.windowArgs = async () => [];
                let launchBackground: boolean | undefined;
                await launchCdpBrowser({
                    port: 9557,
                    ...profile,
                    url: "https://example.com/app",
                    platform: "darwin",
                    background,
                    ...(logged ? { logPath: "/tmp/profile.log" } : {}),
                    spawnLogged: spawnInto(commands),
                    launch: (o) => {
                        commands.push([...o.args, ...(o.url ? [o.url] : [])]);
                        launchBackground = o.background;
                        return okLaunch();
                    },
                    probe: liveProbe,
                    waitFor: cameUp,
                });
                expect(commands[0]).not.toContain("--no-startup-window");
                expect(commands[0].some((arg) => arg.startsWith("--window-"))).toBe(false);
                expect(commands[0].at(-1)).toBe("https://example.com/app");
                expect(opened).toEqual([]);

                if (!logged) {
                    expect(launchBackground).toBe(false);
                }
            }
        }
    });

    test.each([false, true])("both first-window creation paths failing reject the launch, owned=%s", async (logged) => {
        const requests: string[] = [];
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: (request, server) => {
                const pathname = new URL(request.url).pathname;
                requests.push(`${request.method} ${pathname}`);

                if (pathname === "/browser" && server.upgrade(request)) {
                    return;
                }

                if (pathname === "/json/version") {
                    return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/browser` });
                }

                return new Response("fixture window refused", { status: 500 });
            },
            websocket: {
                message: (socket, message) => {
                    const request: { id: number; method: string } = SafeJSON.parse(String(message));
                    requests.push(request.method);
                    socket.send(SafeJSON.stringify({ id: request.id, error: { message: "inactive window refused" } }));
                },
            },
        });
        let killed = 0;
        let probed = 0;
        let logsRead = 0;
        try {
            const port = server.port;
            if (port === undefined) {
                throw new Error("fixture server has no listening port");
            }

            const launching = launchCdpBrowser({
                port,
                fresh: true,
                platform: "darwin",
                background: { windowArgs: async () => windowArgs, openWindow: openBackgroundWindow },
                quit: noBrowser,
                ...(logged ? { logPath: "/tmp/profile.log" } : {}),
                readLog: async () => {
                    logsRead++;
                    return "fixture browser diagnostic\n";
                },
                launch: okLaunch,
                spawnLogged: () => ({
                    pid: 4242,
                    kill: () => {
                        killed++;
                    },
                }),
                probe: async (port) => {
                    probed++;
                    return { port, browser: "Chrome/151", pages: [] };
                },
                waitFor: cameUp,
            });
            await expect(launching).rejects.toThrow("fixture window refused");
            await expect(launching).rejects.toMatchObject({
                name: "CdpLaunchError",
                stage: "window",
                logTail: logged ? "fixture browser diagnostic\n" : null,
            });
            expect(logsRead).toBe(logged ? 1 : 0);
            expect(requests).toContain("Target.createTarget");
            expect(requests).toContain("PUT /json/new");
            expect(killed).toBe(logged ? 1 : 0);
            expect(probed).toBe(0);
        } finally {
            await server.stop(true);
        }
    });

    test("the normal-window fallback still succeeds when inactive creation fails", async () => {
        const requests: string[] = [];
        const url = "https://example.com/app?a=1&b=2";
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: (request) => {
                requests.push(`${request.method} ${new URL(request.url).pathname}`);

                if (new URL(request.url).pathname === "/json/version") {
                    return Response.json({});
                }

                expect(decodeURIComponent(new URL(request.url).search.slice(1))).toBe(url);
                return Response.json({ id: "fixture-page", type: "page", url });
            },
        });
        try {
            const port = server.port;
            if (port === undefined) {
                throw new Error("fixture server has no listening port");
            }

            await openBackgroundWindow(port, url);
            expect(requests).toEqual(["GET /json/version", "PUT /json/new"]);
        } finally {
            await server.stop(true);
        }
    });

    test("a browser whose port never answers gets no window request", async () => {
        const { background, opened } = fakeBackground();
        await launchCdpBrowser({
            port: 9558,
            fresh: true,
            logPath: "/tmp/profile.log",
            platform: "darwin",
            background,
            quit: noBrowser,
            spawnLogged: () => ({ pid: 7, kill: () => {} }),
            probe: deadProbe,
            waitFor: neverUp,
            readLog: async () => "",
        }).catch(() => undefined);
        expect(opened).toEqual([]);
    });
});

describe("separate recording browser onboarding", () => {
    const installed = () => [{ id: "chrome", name: "Google Chrome" }];
    let snapshot: ReturnType<typeof env.testing.snapshot>;
    beforeEach(async () => {
        snapshot = env.testing.snapshot();
        env.testing.set("GENESIS_TOOLS_HOME", await mkdtemp(join(tmpdir(), "recording-browser-")));
    });
    afterEach(() => {
        env.testing.restore(snapshot);
    });
    test("opens the selected installed browser on the allocated endpoint with a unique separate profile", async () => {
        const commands: string[][] = [];
        let killed = 0;
        const result = await openRecordingBrowser({
            browserId: "chrome",
            url: "http://localhost:1234/fixture",
            dependencies: {
                installed,
                freePort: async () => 45678,
                probe: liveProbe,
                background: false,
                spawnLogged: (command) => {
                    commands.push(command);
                    return {
                        pid: 4242,
                        kill: () => {
                            killed++;
                        },
                    };
                },
            },
        });
        expect(result.browserId).toBe("chrome");
        expect(result.pid).toBe(4242);
        expect(result.port).toBe(45678);
        expect(commands[0]).toContain("--remote-debugging-port=45678");
        expect(commands[0]).toContain(`--user-data-dir=${result.userDataDir}`);
        expect(commands[0].at(-1)).toBe("http://localhost:1234/fixture");
        expect(killed).toBe(0);
    });
    test("refuses an uninstalled choice and executable URL before allocating or spawning", async () => {
        let allocated = 0;
        let spawned = 0;
        const dependencies = {
            installed,
            spawnLogged: () => {
                spawned++;
                throw new Error("Irreversible spawn unexpectedly reached");
            },
            freePort: async () => {
                allocated++;
                return 45678;
            },
        };
        await expect(openRecordingBrowser({ browserId: "missing", dependencies })).rejects.toThrow("installed");
        await expect(
            openRecordingBrowser({ browserId: "chrome", url: "javascript:alert(1)", dependencies })
        ).rejects.toThrow("HTTP");
        expect(allocated).toBe(0);
        expect(spawned).toBe(0);
    });
    test("pre-cancelled startup never allocates a port or launches", async () => {
        const controller = new AbortController();
        controller.abort();
        let allocated = 0;
        let spawned = 0;
        await expect(
            openRecordingBrowser({
                browserId: "chrome",
                signal: controller.signal,
                dependencies: {
                    installed,
                    spawnLogged: () => {
                        spawned++;
                        throw new Error("Irreversible spawn unexpectedly reached");
                    },
                    freePort: async () => {
                        allocated++;
                        return 45678;
                    },
                },
            })
        ).rejects.toThrow();
        expect(allocated).toBe(0);
        expect(spawned).toBe(0);
    });
    test("cancelling readiness terminates exactly the process returned by the owned spawn", async () => {
        const controller = new AbortController();
        let killed = 0;
        const pending = openRecordingBrowser({
            browserId: "chrome",
            signal: controller.signal,
            dependencies: {
                installed,
                freePort: async () => 45678,
                background: false,
                spawnLogged: () => ({
                    pid: 4242,
                    kill: () => {
                        killed++;
                    },
                }),
                probe: async () => {
                    controller.abort();
                    return null;
                },
                quit: noBrowser,
            },
        });
        await expect(pending).rejects.toThrow();
        expect(killed).toBe(1);
    });
    test("a readiness timeout quits the owned browser once: the cleanup does not quit it again", async () => {
        let killed = 0;
        const err = await openRecordingBrowser({
            browserId: "chrome",
            dependencies: {
                installed,
                freePort: async () => 45678,
                timeoutMs: 0,
                probe: async () => null,
                spawnLogged: () => ({
                    pid: 4242,
                    kill: () => {
                        killed++;
                    },
                }),
                quit: noBrowser,
            },
        }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(CdpLaunchError);
        expect((err as CdpLaunchError).stage).toBe("timeout");
        expect(killed).toBe(1);
    });
    test("spawn refusal reaches the caller without starting a replacement browser", async () => {
        let attempted = 0;
        await expect(
            openRecordingBrowser({
                browserId: "chrome",
                dependencies: {
                    installed,
                    freePort: async () => 45678,
                    probe: liveProbe,
                    background: false,
                    spawnLogged: () => {
                        attempted++;
                        throw new Error("fixture spawn refused");
                    },
                },
            })
        ).rejects.toThrow("fixture spawn refused");
        expect(attempted).toBe(1);
        expect(await readdir(toolDataDir("chrome-devtools", "recording-browsers"))).toEqual([]);
    });
});

describe("quitting a browser so macOS deletes its 1.4 GB app copy", () => {
    function fakeBrowser(onClose: () => void) {
        const sent: string[] = [];
        const connect: QuitDeps["connect"] = async () => ({
            send: async (method: string) => {
                sent.push(method);
                onClose();
                return {};
            },
            close: () => {},
        });

        return { sent, connect };
    }

    function fakeClock(): Pick<QuitDeps, "now" | "sleep"> {
        let t = 0;

        return {
            now: () => t,
            sleep: async (ms: number) => {
                t += ms;
            },
        };
    }

    const killLeaks = () => {
        throw new Error("kill reached: it leaves the app copy behind");
    };

    /** The machine where `pid` is the one process listening on 9333. */
    const ownedBy = (pid: number): Pick<QuitDeps, "exec" | "platform"> => ({
        exec: machine([listener(pid)], []),
        platform: "darwin",
    });

    test("a browser that exits after Browser.close is never killed", async () => {
        let running = true;
        const browser = fakeBrowser(() => {
            running = false;
        });
        const result = await quitOwnedBrowser({
            port: 9333,
            pid: 4242,
            kill: killLeaks,
            deps: { connect: browser.connect, alive: () => running, ...fakeClock(), ...ownedBy(4242) },
        });
        expect(result).toBe("closed");
        expect(browser.sent).toEqual(["Browser.close"]);
    });

    test("a browser still running after the deadline is killed", async () => {
        let killed = 0;
        const browser = fakeBrowser(() => {});
        const result = await quitOwnedBrowser({
            port: 9333,
            pid: 4242,
            kill: () => {
                killed++;
            },
            deps: { connect: browser.connect, alive: () => true, ...fakeClock(), ...ownedBy(4242) },
        });
        expect(result).toBe("killed");
        expect(browser.sent).toEqual(["Browser.close"]);
        expect(killed).toBe(1);
    });

    test("a port another browser also listens on never gets Browser.close; the owned child is killed", async () => {
        for (const listeners of [[listener(5353)], [listener(4242), listener(5353, "[::1]")]]) {
            let killed = 0;
            const browser = fakeBrowser(() => {});
            const result = await quitOwnedBrowser({
                port: 9333,
                pid: 4242,
                kill: () => {
                    killed++;
                },
                deps: { connect: browser.connect, exec: machine(listeners, []), platform: "darwin", ...fakeClock() },
            });
            expect(result).toBe("killed");
            expect(browser.sent).toEqual([]);
            expect(killed).toBe(1);
        }
    });

    test("a browser that never answered CDP is killed without waiting", async () => {
        let killed = 0;
        const result = await quitOwnedBrowser({
            port: 9333,
            pid: 4242,
            kill: () => {
                killed++;
            },
            deps: {
                ...noBrowser,
                ...ownedBy(4242),
                alive: () => {
                    throw new Error("waited on a browser that cannot be asked to quit");
                },
            },
        });
        expect(result).toBe("killed");
        expect(killed).toBe(1);
    });

    test("the child's own exit decides, because an unreaped child still answers a pid probe", async () => {
        const browser = fakeBrowser(() => {});
        const result = await quitOwnedBrowser({
            port: 9333,
            pid: 4242,
            kill: killLeaks,
            exited: Promise.resolve(0),
            deps: {
                connect: browser.connect,
                alive: () => {
                    throw new Error("probed the pid although the exit promise was given");
                },
                sleep: () => new Promise(() => {}),
                ...ownedBy(4242),
            },
        });
        expect(result).toBe("closed");
    });

    test("a launch that timed out but answers CDP by now quits through Browser.close", async () => {
        let running = true;
        const browser = fakeBrowser(() => {
            running = false;
        });
        const err = await launchCdpBrowser({
            port: 9333,
            logPath: "/tmp/profile.log",
            spawnLogged: () => ({ pid: 7, kill: killLeaks }),
            probe: deadProbe,
            waitFor: neverUp,
            readLog: async () => "",
            quit: { connect: browser.connect, alive: () => running, ...fakeClock(), ...ownedBy(7) },
        }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(CdpLaunchError);
        expect(browser.sent).toEqual(["Browser.close"]);
    });

    describe("closeBrowserOnPort", () => {
        const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
        const throwaway = machine(
            [listener(4242)],
            [`4242 1 ${chrome} --remote-debugging-port=9333 --user-data-dir=/tmp/cdp-profile-9333-a about:blank`]
        );
        const ownProfile = machine([listener(4242)], [`4242 1 ${chrome} --remote-debugging-port=9333 about:blank`]);

        test("closes a throwaway-profile browser and waits for its exit", async () => {
            let running = true;
            const browser = fakeBrowser(() => {
                running = false;
            });
            const result = await closeBrowserOnPort({
                port: 9333,
                deps: {
                    exec: throwaway,
                    args: () => [chrome, "--user-data-dir=/tmp/cdp-profile-9333-a", "about:blank"],
                    platform: "darwin",
                    connect: browser.connect,
                    alive: () => running,
                    ...fakeClock(),
                },
            });
            expect(result).toEqual({ status: "closed", pid: 4242 });
            expect(browser.sent).toEqual(["Browser.close"]);
        });

        test("a space and profile flag inside one URL argument never authorizes Browser.close", async () => {
            const url = "https://example.test/?q= --user-data-dir=/tmp/fixture";
            let attempts = 0;
            const result = await closeBrowserOnPort({
                port: 9333,
                deps: {
                    exec: machine([listener(4242)], [`4242 1 ${chrome} --remote-debugging-port=9333 ${url}`]),
                    args: () => [chrome, "--remote-debugging-port=9333", url],
                    platform: "darwin",
                    alive: () => false,
                    connect: async () => {
                        attempts++;
                        throw new Error("main-profile browser must not be contacted");
                    },
                },
            });
            expect(result).toMatchObject({ status: "main-profile", pid: 4242 });
            expect(attempts).toBe(0);
        });

        test("the profile flag counts only as an argument of its own, never as text inside a URL", async () => {
            const browser = fakeBrowser(() => {});
            const result = await closeBrowserOnPort({
                port: 9333,
                deps: {
                    exec: machine(
                        [listener(4242)],
                        [`4242 1 ${chrome} --remote-debugging-port=9333 https://example.com/?--user-data-dir=x`]
                    ),
                    platform: "darwin",
                    connect: browser.connect,
                },
            });
            expect(result).toMatchObject({ status: "main-profile", pid: 4242 });
            expect(browser.sent).toEqual([]);
        });

        test("reports a browser still running at the deadline and never kills it", async () => {
            const browser = fakeBrowser(() => {});
            const result = await closeBrowserOnPort({
                port: 9333,
                deps: {
                    exec: throwaway,
                    args: () => [chrome, "--user-data-dir=/tmp/cdp-profile-9333-a", "about:blank"],
                    platform: "darwin",
                    connect: browser.connect,
                    alive: () => true,
                    ...fakeClock(),
                },
            });
            expect(result).toEqual({ status: "still-running", pid: 4242 });
        });

        test("unreadable, empty and positional profile switches never authorize a close", async () => {
            for (const args of [
                null,
                [chrome, "--user-data-dir="],
                [chrome, "--user-data-dir", ""],
                [chrome, "--user-data-dir", "/tmp/fixture"],
                [chrome, "--user-data-dir", "--remote-debugging-port=9333"],
                [chrome, "--", "--user-data-dir=/tmp/fixture"],
                [chrome, "--user-data-dir=/tmp/fixture", "--user-data-dir="],
            ]) {
                let attempts = 0;
                const result = await closeBrowserOnPort({
                    port: 9333,
                    deps: {
                        exec: throwaway,
                        platform: "darwin",
                        args: () => args,
                        connect: async () => {
                            attempts++;
                            throw new Error("unsafe profile must not be contacted");
                        },
                    },
                });
                expect(result).toMatchObject({ status: "main-profile" });
                expect(attempts).toBe(0);
            }
        });

        test("a profile value preserves spaces and authorizes a close", async () => {
            const browser = fakeBrowser(() => {});
            const result = await closeBrowserOnPort({
                port: 9333,
                deps: {
                    exec: throwaway,
                    platform: "darwin",
                    args: () => [chrome, "--user-data-dir=/tmp/fixture with spaces"],
                    connect: browser.connect,
                    alive: () => false,
                },
            });
            expect(result).toEqual({ status: "closed", pid: 4242 });
            expect(browser.sent).toEqual(["Browser.close"]);
        });

        test.each(["darwin", "linux", "win32"] as const)(
            "%s normalizes the final profile switch before authorizing Browser.close",
            async (platform) => {
                const exec: ExecFn =
                    platform === "win32"
                        ? (argv) => ({
                              exitCode: 0,
                              stdout:
                                  argv[0] === "netstat"
                                      ? "TCP 127.0.0.1:9333 0.0.0.0:0 LISTENING 4242"
                                      : argv[3].endsWith(".Name")
                                        ? "chrome.exe"
                                        : '[{"ProcessId":4242,"CommandLine":"chrome.exe"}]',
                              stderr: "",
                          })
                        : throwaway;
                const valid = "--user-data-dir=/tmp/fixture";
                const refused = [
                    [chrome, valid, "-user-data-dir="],
                    [chrome, valid, " --user-data-dir= "],
                    [chrome, " -- ", valid],
                    [chrome, valid, " -user-data-dir "],
                    [valid, chrome], // argv[0] is the program, never a switch.
                ];
                if (platform === "win32") {
                    refused.push(
                        [chrome, valid, "/USER-DATA-DIR="],
                        [chrome, valid, "-USER-DATA-DIR="],
                        [chrome, valid, "\u0085--user-data-dir=\u0085"]
                    );
                } else {
                    refused.push([chrome, `\u00a0${valid}`]);
                }
                for (const args of refused) {
                    let attempts = 0;
                    const result = await closeBrowserOnPort({
                        port: 9333,
                        deps: {
                            exec,
                            platform,
                            args: () => args,
                            alive: () => false,
                            connect: async () => {
                                attempts++;
                                throw new Error("normalized main profile must not be contacted");
                            },
                        },
                    });
                    expect(result.status, args.join(" | ")).toBe("main-profile");
                    expect(attempts).toBe(0);
                }
                const accepted = [
                    [chrome, " -user-data-dir=/tmp/fixture "],
                    [chrome, " --user-data-dir=/tmp/fixture "],
                ];
                if (platform === "win32") {
                    accepted.push([chrome, " /USER-DATA-DIR=/tmp/fixture "]);
                } else {
                    // POSIX switch names remain case-sensitive; an uppercase override does not replace this one.
                    accepted.push([chrome, valid, "--USER-DATA-DIR="]);
                }
                for (const args of accepted) {
                    const browser = fakeBrowser(() => {});
                    const result = await closeBrowserOnPort({
                        port: 9333,
                        deps: { exec, platform, args: () => args, alive: () => false, connect: browser.connect },
                    });
                    expect(result.status, args.join(" | ")).toBe("closed");
                    expect(browser.sent).toEqual(["Browser.close"]);
                }
            }
        );

        test("the user's own profile needs allowMainProfile", async () => {
            const refused = fakeBrowser(() => {});
            expect(
                await closeBrowserOnPort({
                    port: 9333,
                    deps: { exec: ownProfile, platform: "darwin", connect: refused.connect },
                })
            ).toMatchObject({ status: "main-profile", pid: 4242 });
            expect(refused.sent).toEqual([]);

            let running = true;
            const allowed = fakeBrowser(() => {
                running = false;
            });
            const result = await closeBrowserOnPort({
                port: 9333,
                allowMainProfile: true,
                deps: {
                    exec: ownProfile,
                    platform: "darwin",
                    connect: allowed.connect,
                    alive: () => running,
                    ...fakeClock(),
                },
            });
            expect(result).toEqual({ status: "closed", pid: 4242 });
        });

        test("refuses a port that two processes listen on, since CDP reaches only one", async () => {
            const browser = fakeBrowser(() => {});
            const result = await closeBrowserOnPort({
                port: 9333,
                deps: {
                    exec: machine([listener(4242), listener(5353, "[::1]")], []),
                    platform: "darwin",
                    connect: browser.connect,
                },
            });
            expect(result).toEqual({ status: "several-listeners", pids: [4242, 5353] });
            expect(browser.sent).toEqual([]);
        });

        test("reports an empty port and a listener that is not a browser", async () => {
            const browser = fakeBrowser(() => {});
            expect(
                await closeBrowserOnPort({
                    port: 9333,
                    deps: { exec: machine([], []), platform: "darwin", connect: browser.connect },
                })
            ).toEqual({ status: "nothing-listening" });
            expect(
                await closeBrowserOnPort({
                    port: 9333,
                    deps: {
                        exec: machine([listener(4242)], ["4242 1 node server.js --port 9333"]),
                        platform: "darwin",
                        connect: browser.connect,
                    },
                })
            ).toMatchObject({ status: "not-a-browser", pid: 4242 });
            expect(browser.sent).toEqual([]);
        });

        test("only the executable counts: a process whose arguments name a browser is not one", async () => {
            const browser = fakeBrowser(() => {});
            const result = await closeBrowserOnPort({
                port: 9333,
                deps: {
                    exec: machine(
                        [listener(4242)],
                        [`4242 1 /usr/local/bin/cdp-proxy --target=${chrome} --user-data-dir=/tmp/cdp-profile-9333-a`]
                    ),
                    platform: "darwin",
                    connect: browser.connect,
                },
            });
            expect(result).toMatchObject({ status: "not-a-browser", pid: 4242 });
            expect(browser.sent).toEqual([]);
        });
    });
});

test.skipIf(process.platform === "win32")(
    "one-shot browser launcher exits while its owned browser keeps running",
    async () => {
        await mkdir("/tmp/cc/GenesisTools/bug-to-test", { recursive: true });
        const directory = await mkdtemp("/tmp/cc/GenesisTools/bug-to-test/browser-exit-");
        const script = join(directory, "launch.ts");
        await Bun.write(
            script,
            `import { defaultSpawnLogged } from ${SafeJSON.stringify(join(import.meta.dir, "launch.ts"))};
const child = defaultSpawnLogged([process.execPath, '-e', 'setInterval(() => {}, 1000)'], ${SafeJSON.stringify(join(directory, "browser.log"))});
console.log('OWNED:' + child.pid);
`
        );
        const cli = spawn(process.execPath, [script], {
            cwd: process.cwd(),
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        let errors = "";
        cli.stdout.on("data", (chunk) => {
            output += chunk.toString();
        });
        cli.stderr.on("data", (chunk) => {
            errors += chunk.toString();
        });
        let expired = false;
        let cleanupFailure: unknown;
        const timer = setTimeout(() => {
            expired = true;
            cli.kill("SIGKILL");
        }, 1500);
        try {
            const exit = await new Promise<number>((accept, reject) => {
                cli.once("error", reject);
                cli.once("close", (code) => accept(code ?? -1));
            });
            expect(errors).toBe("");
            expect(expired).toBe(false);
            expect(exit).toBe(0);
            const pid = Number(output.match(/OWNED:(\d+)/)?.[1]);
            expect(pid).toBeGreaterThan(0);
            expect(isProcessAlive(pid)).toBe(true);
        } finally {
            clearTimeout(timer);
            cli.kill("SIGKILL");
            const pid = Number(output.match(/OWNED:(\d+)/)?.[1]);
            if (pid > 0) {
                try {
                    process.kill(pid, "SIGTERM");
                } catch (error) {
                    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
                        cleanupFailure = error;
                    }
                }
            }
        }
        expect(cleanupFailure).toBeUndefined();
    },
    5000
);

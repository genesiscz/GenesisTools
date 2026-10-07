import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { isProcessAlive } from "@genesiscz/utils/process-alive";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import {
    CdpLaunchError,
    COLD_PROFILE_TIMEOUT_MS,
    DEFAULT_LAUNCH_TIMEOUT_MS,
    launchArgs,
    launchCdpBrowser,
} from "./launch.ts";
import { openRecordingBrowser } from "./recording-browser";

describe("launchArgs (PR #326 review — the profile-isolation rule, pinned)", () => {
    test("a plain launch carries the debug port and NO --user-data-dir (the real profile)", () => {
        const args = launchArgs(9222, {});
        expect(args).toContain("--remote-debugging-port=9222");
        expect(args.some((a) => a.startsWith("--user-data-dir"))).toBe(false);
        expect(args.some((a) => a.startsWith("--load-extension"))).toBe(false);
    });

    test("the real profile NEVER gets the private-network downgrade flag", () => {
        expect(launchArgs(9222, {}).some((a) => a.startsWith("--disable-features"))).toBe(false);
    });

    test("--fresh isolates into a unique /tmp profile so the user's own profile stays untouched", () => {
        // A fixed /tmp/cdp-profile-9223 used to be reused on every run, so a --fresh profile was
        // never really throwaway: see freshProfileDir's own uniqueness test in resolve-attach.test.ts.
        const args = launchArgs(9223, { fresh: true });
        expect(args.find((a) => a.startsWith("--user-data-dir="))).toMatch(/^--user-data-dir=\/tmp\/cdp-profile-9223-/);
        expect(args).toContain("--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks");
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
        expect(args).toContain("--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks");
    });

    test("a persistent --user-data-dir alone keeps the network protections: it holds logins like the real profile", () => {
        const args = launchArgs(9444, { userDataDir: "/Users/x/.genesis-tools/chrome-devtools/chrome/profile" });
        expect(args).toContain("--user-data-dir=/Users/x/.genesis-tools/chrome-devtools/chrome/profile");
        expect(args.some((a) => a.startsWith("--disable-features"))).toBe(false);
    });

    // PR #374 review: --extension and --fresh both used to force the downgrade, and
    // the explicit dir won the path, so `open --user-data-dir <logins> --extension x`
    // ran the credential-bearing profile with the protections off.
    test("--extension or --fresh beside a persistent --user-data-dir still keeps the protections", () => {
        const profile = "/Users/x/.genesis-tools/chrome-devtools/chrome/profile";
        for (const opts of [{ extension: "/dist/ext" }, { fresh: true }, { fresh: true, extension: "/dist/ext" }]) {
            const args = launchArgs(9445, { ...opts, userDataDir: profile });
            expect(args).toContain(`--user-data-dir=${profile}`);
            expect(args.some((a) => a.startsWith("--disable-features"))).toBe(false);
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
                seen.push([...o.args, o.url]);

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
        }).catch((e: unknown) => e);
        expect(killed).toBe(true);
        expect(err).toBeInstanceOf(CdpLaunchError);
        expect((err as CdpLaunchError).stage).toBe("timeout");
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
            },
        });
        await expect(pending).rejects.toThrow();
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

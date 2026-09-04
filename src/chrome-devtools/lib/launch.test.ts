import { describe, expect, test } from "bun:test";
import {
    CdpLaunchError,
    COLD_PROFILE_TIMEOUT_MS,
    DEFAULT_LAUNCH_TIMEOUT_MS,
    launchArgs,
    launchCdpBrowser,
} from "./launch.ts";

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

    test("--fresh isolates into a /tmp profile so the user's own profile stays untouched", () => {
        const args = launchArgs(9223, { fresh: true });
        expect(args).toContain("--user-data-dir=/tmp/cdp-profile-9223");
        expect(args).toContain("--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks");
    });

    test("--extension implies its own profile and restricts loaded extensions to the one given", () => {
        const args = launchArgs(9333, { extension: "/dist/ext" });
        expect(args).toContain("--user-data-dir=/tmp/cdp-profile-9333");
        expect(args).toContain("--load-extension=/dist/ext");
        expect(args).toContain("--disable-extensions-except=/dist/ext");
    });
});

describe("launchArgs — an explicit profile dir", () => {
    test("isolates like --fresh, using the dir given instead of /tmp/cdp-profile-<port>", () => {
        const args = launchArgs(9333, { userDataDir: "/tmp/genesis-yt-devtools-chrome-abc", extension: "/dist/ext" });
        expect(args).toContain("--user-data-dir=/tmp/genesis-yt-devtools-chrome-abc");
        expect(args).toContain("--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks");
        expect(args.some((a) => a === "--user-data-dir=/tmp/cdp-profile-9333")).toBe(false);
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

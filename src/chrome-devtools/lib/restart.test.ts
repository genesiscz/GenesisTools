import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import type { Target } from "./cdp.ts";
import { quitBrowser } from "./resolve-attach.ts";
import {
    findProfilePicker,
    formatVerification,
    isProfilePickerTarget,
    isSafeProfileDirectory,
    localStatePath,
    parseLastUsedProfile,
    QUIT_DEADLINE_MS,
    resolveLastUsedProfile,
    restartSucceeded,
    slowQuitNote,
    userDataDirFor,
    verifyRestart,
} from "./restart.ts";

const HOME = "/home/tester";

function target(over: Partial<Target>): Target {
    return {
        id: over.id ?? "t1",
        type: over.type ?? "page",
        title: over.title ?? "",
        url: over.url ?? "https://app.example.com/",
        webSocketDebuggerUrl: over.webSocketDebuggerUrl ?? "ws://127.0.0.1:9222/devtools/page/t1",
    };
}

describe("profile directory safety", () => {
    test("accepts the directory names browsers actually use", () => {
        for (const name of ["Default", "Profile 1", "Profile 10", "System Profile"]) {
            expect(isSafeProfileDirectory(name)).toBe(true);
        }
    });

    test("refuses anything that would escape the user-data-dir or read as another flag", () => {
        // The value goes onto a command line, so a leading dash is flag injection
        // and a separator points the browser at a directory it does not own.
        for (const name of ["--disable-web-security", "-Default", "../../etc", "Profile/1", "Profile\\1", "..", ""]) {
            expect(isSafeProfileDirectory(name)).toBe(false);
        }
    });
});

describe("Local State", () => {
    test("the user-data-dir is the DevToolsActivePort file's own directory", () => {
        expect(userDataDirFor("brave", "darwin", HOME)).toBe(
            `${HOME}/Library/Application Support/BraveSoftware/Brave-Browser`
        );
        expect(localStatePath("brave", "darwin", HOME)).toBe(
            `${HOME}/Library/Application Support/BraveSoftware/Brave-Browser/Local State`
        );
    });

    test("an unknown browser has no known layout rather than a guessed path", () => {
        expect(userDataDirFor("dia", "darwin", HOME)).toBeNull();
        expect(localStatePath("dia", "darwin", HOME)).toBeNull();
    });

    test("reads profile.last_used out of a real-shaped document", () => {
        const text = SafeJSON.stringify(
            {
                profile: { last_used: "Profile 3", info_cache: { Default: {}, "Profile 3": {} } },
                browser: { enabled_labs_experiments: [] },
            },
            { strict: true }
        );
        expect(parseLastUsedProfile(text)).toBe("Profile 3");
    });

    test("a missing, malformed or unsafe last_used yields null instead of a bad flag", () => {
        expect(parseLastUsedProfile("{}")).toBeNull();
        expect(parseLastUsedProfile('{"profile":{}}')).toBeNull();
        expect(parseLastUsedProfile("not json at all")).toBeNull();
        expect(parseLastUsedProfile('{"profile":{"last_used":42}}')).toBeNull();
        expect(parseLastUsedProfile('{"profile":{"last_used":"--headless"}}')).toBeNull();
        expect(parseLastUsedProfile('{"profile":{"last_used":"../../Other"}}')).toBeNull();
    });

    test("resolves the last-used profile when the directory is really there", () => {
        const r = resolveLastUsedProfile({
            browser: "brave",
            platform: "darwin",
            home: HOME,
            readFile: () => '{"profile":{"last_used":"Profile 1"}}',
            exists: () => true,
        });
        expect(r.directory).toBe("Profile 1");
        expect(r.reason).toBeNull();
    });

    test("a last_used naming a profile that is not on disk is refused, so no empty profile is created", () => {
        // Passing --profile-directory for a directory the browser does not have
        // makes it create a fresh empty one, which looks exactly like the
        // logged-out browser this whole flag exists to avoid.
        const r = resolveLastUsedProfile({
            browser: "brave",
            platform: "darwin",
            home: HOME,
            readFile: () => '{"profile":{"last_used":"Profile 9"}}',
            exists: () => false,
        });
        expect(r.directory).toBeNull();
        expect(r.reason).toContain("Profile 9");
    });

    test("an unreadable Local State degrades to no flag and says which file", () => {
        const r = resolveLastUsedProfile({
            browser: "brave",
            platform: "darwin",
            home: HOME,
            readFile: () => null,
            exists: () => true,
        });
        expect(r.directory).toBeNull();
        expect(r.reason).toContain("Local State");
    });
});

describe("profile picker detection", () => {
    test("recognises the picker across the Chromium family, without any Accessibility grant", () => {
        expect(isProfilePickerTarget({ url: "chrome://profile-picker/" })).toBe(true);
        expect(isProfilePickerTarget({ url: "brave://profile-picker/" })).toBe(true);
        expect(isProfilePickerTarget({ url: "edge://profile-picker/" })).toBe(true);
    });

    test("an ordinary tab is never mistaken for the picker", () => {
        expect(isProfilePickerTarget({ url: "https://app.example.com/profile-picker" })).toBe(false);
        expect(isProfilePickerTarget({ url: "https://app.example.com/" })).toBe(false);
        // A host that merely STARTS with the marker is a website, not the WebUI page, and a
        // false picker makes restart exit non-zero about a browser that came up correctly.
        expect(isProfilePickerTarget({ url: "https://profile-picker.example.com/" })).toBe(false);
        expect(findProfilePicker([target({ url: "https://app.example.com/" })])).toBeNull();
    });

    test("the marker embedded later in a URL is not the picker either", () => {
        // A real page whose query string or fragment happens to CONTAIN the marker text is
        // still an ordinary tab, not the WebUI page. The marker must anchor the scheme.
        expect(isProfilePickerTarget({ url: "https://app.example.com/login?next=chrome://profile-picker/" })).toBe(
            false
        );
        expect(isProfilePickerTarget({ url: "https://example.com/#chrome://profile-picker" })).toBe(false);
    });

    test("the picker is still found with a query, a fragment or no trailing slash", () => {
        // Missing a real picker is the worse error of the two: restart would report a browser
        // as ready while it is still sitting behind "Who's using …?".
        expect(isProfilePickerTarget({ url: "chrome://profile-picker/?startup=true" })).toBe(true);
        expect(isProfilePickerTarget({ url: "chrome://profile-picker" })).toBe(true);
        expect(isProfilePickerTarget({ url: "brave://profile-picker#main" })).toBe(true);
    });

    test("finds the picker among ordinary tabs", () => {
        const found = findProfilePicker([
            target({ id: "a", url: "https://app.example.com/" }),
            target({ id: "b", url: "brave://profile-picker/", title: "Who's using Brave?" }),
        ]);
        expect(found?.id).toBe("b");
    });
});

describe("quit deadline", () => {
    /** A clock the test advances itself, so a 45s deadline costs no real seconds. */
    function fakeClock() {
        let t = 1_000_000;

        return { now: () => t, advance: (ms: number) => (t += ms) };
    }

    test("a beforeunload quit that takes 30s succeeds without ever force-killing", async () => {
        const clock = fakeClock();
        const argvLog: string[][] = [];
        const exec = (argv: string[]) => {
            argvLog.push(argv);

            if (argv[0] === "pgrep") {
                // Alive until 30s in — the reported beforeunload case.
                const alive = clock.now() < 1_000_000 + 30_000;

                return alive ? { exitCode: 0, stdout: "1030\n", stderr: "" } : { exitCode: 1, stdout: "", stderr: "" };
            }

            return { exitCode: 0, stdout: "", stderr: "" };
        };

        const notices: number[] = [];
        const r = await quitBrowser({
            app: "Brave Browser",
            exec,
            platform: "darwin",
            now: clock.now,
            sleep: async (ms) => {
                clock.advance(ms);
            },
            timeoutMs: QUIT_DEADLINE_MS,
            onWaiting: (ms) => notices.push(ms),
        });

        expect(r).toEqual({ exited: true, usedForce: false });
        // The whole bug: the old 15s window called this a failure and recommended kill -KILL.
        expect(argvLog.some((a) => a[0] === "kill")).toBe(false);
        expect(notices.length).toBeGreaterThan(0);
    });

    test("the old 15s window is what reported that same healthy quit as a failure", async () => {
        const clock = fakeClock();
        const exec = (argv: string[]) => {
            if (argv[0] === "pgrep") {
                const alive = clock.now() < 1_000_000 + 30_000;

                return alive ? { exitCode: 0, stdout: "1030\n", stderr: "" } : { exitCode: 1, stdout: "", stderr: "" };
            }

            return { exitCode: 0, stdout: "", stderr: "" };
        };

        const r = await quitBrowser({
            app: "Brave Browser",
            exec,
            platform: "darwin",
            now: clock.now,
            sleep: async (ms) => {
                clock.advance(ms);
            },
            timeoutMs: 15_000,
        });

        expect(r.exited).toBe(false);
    });

    test("a browser that truly never exits still returns without force when --force is absent", async () => {
        const clock = fakeClock();
        const argvLog: string[][] = [];
        const exec = (argv: string[]) => {
            argvLog.push(argv);

            return argv[0] === "pgrep"
                ? { exitCode: 0, stdout: "1030\n", stderr: "" }
                : { exitCode: 0, stdout: "", stderr: "" };
        };

        const r = await quitBrowser({
            app: "Brave Browser",
            exec,
            platform: "darwin",
            now: clock.now,
            sleep: async (ms) => {
                clock.advance(ms);
            },
            timeoutMs: QUIT_DEADLINE_MS,
        });

        expect(r).toEqual({ exited: false, usedForce: false });
        expect(argvLog.some((a) => a[0] === "kill")).toBe(false);
    });

    // browse.ts branches its guidance on this: after a kill -KILL that did not take,
    // printing "re-run with --force" would name the remedy the operator just used.
    test("a survivor of kill -KILL reports usedForce, so the CLI stops suggesting --force", async () => {
        const clock = fakeClock();
        const argvLog: string[][] = [];
        const exec = (argv: string[]) => {
            argvLog.push(argv);

            if (argv[0] === "pgrep") {
                return { exitCode: 0, stdout: "1030\n", stderr: "" };
            }

            return { exitCode: 0, stdout: "", stderr: "" };
        };

        const r = await quitBrowser({
            app: "Brave Browser",
            exec,
            platform: "darwin",
            now: clock.now,
            sleep: async (ms) => {
                clock.advance(ms);
            },
            timeoutMs: QUIT_DEADLINE_MS,
            force: true,
        });

        expect(r).toEqual({ exited: false, usedForce: true });
        expect(argvLog.some((a) => a[0] === "kill" && a[1] === "-KILL")).toBe(true);
    });

    test("the slow-quit note names beforeunload and refuses to call it stuck", () => {
        const note = slowQuitNote(12_000);
        expect(note).toContain("beforeunload");
        expect(note).toContain("12s");
        expect(note).toContain("not stuck");
    });
});

describe("end-state verification", () => {
    const versionOk = async (): Promise<string | null> => "Brave/152.1.94.117";

    test("counts ordinary tabs only — DevTools windows and the picker are not tabs", async () => {
        const v = await verifyRestart({
            port: 9222,
            version: versionOk,
            targets: async () => [
                target({ id: "a", url: "https://app.example.com/" }),
                target({ id: "b", url: "https://shop.example.com/" }),
                target({ id: "c", url: "devtools://devtools/bundled/devtools_app.html", title: "DevTools - app" }),
                target({ id: "d", url: "brave://profile-picker/" }),
            ],
        });

        expect(v.cdpReachable).toBe(true);
        expect(v.pageTargets).toBe(2);
        expect(v.devtoolsWindows).toBe(1);
        expect(v.picker?.url).toBe("brave://profile-picker/");
    });

    test("a dead port is reported as unreachable rather than as an empty browser", async () => {
        const v = await verifyRestart({ port: 9222, version: async () => null, targets: async () => [] });
        expect(v.cdpReachable).toBe(false);
        expect(formatVerification(v, { appName: "Brave Browser" }).join("\n")).toContain("NOT answering CDP");
    });

    test("a failed target list does not downgrade an endpoint that answered /json/version", async () => {
        const v = await verifyRestart({
            port: 9222,
            version: versionOk,
            targets: async () => {
                throw new Error("list stalled");
            },
        });

        expect(v.cdpReachable).toBe(true);
        // The counts are unknown, not zero, and the report must not claim otherwise.
        expect(v.targetsListed).toBe(false);

        const text = formatVerification(v, { appName: "Brave Browser" }).join("\n");
        expect(text).toContain("UNKNOWN");
        expect(text).not.toContain("no profile picker is open");
        expect(text).not.toContain("0 page target(s)");
    });

    // `probe()` wraps /json/version AND /json/list in one try, so a stalled list returns
    // null. Injecting it here would report a live browser as "no debuggable browser" and
    // make `restart` exit 1 — the verification failing the thing it was added to confirm.
    test("verification asks for the version alone, so a stalled tab list cannot fake a dead port", async () => {
        const v = await verifyRestart({
            port: 9222,
            version: versionOk,
            targets: async () => {
                throw new Error("/json/list timed out");
            },
        });

        expect(v.cdpReachable).toBe(true);
        expect(v.browser).toBe("Brave/152.1.94.117");
        expect(formatVerification(v, { appName: "Brave Browser" }).join("\n")).not.toContain("NOT answering CDP");
    });

    test("a clean restart says so in one line and names no picker", async () => {
        const v = await verifyRestart({
            port: 9222,
            version: versionOk,
            targets: async () => [target({ id: "a", url: "https://app.example.com/" })],
        });
        const text = formatVerification(v, { appName: "Brave Browser" }).join("\n");
        expect(text).toContain("port 9222 answers");
        expect(text).toContain("1 page target(s)");
        expect(text).toContain("no profile picker is open");
    });

    // browse.ts exits on this predicate, so every branch here is an exit code.
    test("the exit verdict refuses to call an unlisted tab set a success", async () => {
        const stalled = await verifyRestart({
            port: 9222,
            version: versionOk,
            targets: async () => {
                throw new Error("list stalled");
            },
        });

        // picker === null here only because the check never ran. Reading that as
        // "no picker" is what let a half-verified restart exit 0.
        expect(stalled.picker).toBeNull();
        expect(restartSucceeded(stalled)).toBe(false);
    });

    test("the exit verdict is true only for a reachable, listed, picker-free browser", async () => {
        const clean = await verifyRestart({
            port: 9222,
            version: versionOk,
            targets: async () => [target({ id: "a", url: "https://app.example.com/" })],
        });
        expect(restartSucceeded(clean)).toBe(true);

        const dead = await verifyRestart({ port: 9222, version: async () => null, targets: async () => [] });
        expect(restartSucceeded(dead)).toBe(false);

        const behindPicker = await verifyRestart({
            port: 9222,
            version: versionOk,
            targets: async () => [target({ id: "d", url: "brave://profile-picker/", title: "Who's using Brave?" })],
        });
        expect(restartSucceeded(behindPicker)).toBe(false);
    });

    test("a picker left open is reported with a copy-pasteable dismissal, not passed off as success", async () => {
        const v = await verifyRestart({
            port: 9222,
            version: versionOk,
            targets: async () => [target({ id: "d", url: "brave://profile-picker/", title: "Who's using Brave?" })],
        });
        const text = formatVerification(v, { appName: "Brave Browser" }).join("\n");
        expect(text).toContain("STILL OPEN");
        expect(text).toContain("osascript");
        expect(text).toContain("Who's using");
        expect(text).toContain("Brave Browser");
    });
});

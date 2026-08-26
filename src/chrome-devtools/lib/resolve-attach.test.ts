import { describe, expect, test } from "bun:test";
import { env } from "@genesiscz/utils/env";
import {
    browserById,
    browsersWithEmptyDebugFlag,
    classifyProcessName,
    discoverListeningCdpPorts,
    isPortSpecified,
    launchBrowser,
    listRunningBrowsers,
    ownerOfPort,
    parseRemoteDebuggingPort,
    parseTasklistImages,
    planAttach,
    quitBrowser,
    readDevToolsActivePorts,
    renderAttachPlan,
    waitForCdp,
} from "./resolve-attach.ts";

// Regression heritage: the original skill's attach listed only CDP ports, so an
// open Brave without --remote-debugging-port vanished and agents attached to
// Chrome instead. These tests pin the refusal plus the per-platform primitives.

const CHROME_LOCALHOST = {
    port: 9222,
    browser: "Chrome/151.0.7922.172",
    owner: "chrome" as const,
    pages: [{ title: "portal", url: "http://localhost:3000/" }],
};

const suggest = (add: string[]) => `tools chrome-devtools ${add.join(" ")}`;

/** One combined ps/lsof fake: pid ppid command triples + lsof listener lines. */
function posixExec(opts: { procs?: string; lsof?: string }) {
    return (argv: string[]) => {
        if (argv[0] === "ps" && argv.includes("pid=,ppid=,command=")) {
            return { exitCode: 0, stdout: opts.procs ?? "", stderr: "" };
        }

        if (argv[0] === "lsof") {
            return { exitCode: 0, stdout: opts.lsof ?? "", stderr: "" };
        }

        return { exitCode: 1, stdout: "", stderr: `unexpected ${argv.join(" ")}` };
    };
}

describe("listRunningBrowsers", () => {
    test("darwin: includes Brave from pgrep -x on the app name even when it has no CDP port", () => {
        const exec = (argv: string[]) => {
            const name = argv.at(-1);
            if (argv[0] === "pgrep" && argv.includes("-x") && (name === "Google Chrome" || name === "Brave Browser")) {
                return { exitCode: 0, stdout: "123\n", stderr: "" };
            }

            return { exitCode: 1, stdout: "", stderr: "" };
        };

        expect(listRunningBrowsers(exec, "darwin")).toEqual(["chrome", "brave"]);
    });

    test("darwin: omits Brave when pgrep -x does not find it", () => {
        const exec = (argv: string[]) => {
            if (argv[0] === "pgrep" && argv.at(-1) === "Google Chrome") {
                return { exitCode: 0, stdout: "1\n", stderr: "" };
            }

            return { exitCode: 1, stdout: "", stderr: "" };
        };

        expect(listRunningBrowsers(exec, "darwin")).toEqual(["chrome"]);
    });

    test("linux: matches bin names, not macOS app names", () => {
        const exec = (argv: string[]) => {
            if (argv[0] === "pgrep" && (argv.at(-1) === "google-chrome" || argv.at(-1) === "brave-browser")) {
                return { exitCode: 0, stdout: "42\n", stderr: "" };
            }

            return { exitCode: 1, stdout: "", stderr: "" };
        };

        expect(listRunningBrowsers(exec, "linux")).toEqual(["chrome", "brave"]);
    });

    test("win32: matches tasklist image names", () => {
        const exec = (argv: string[]) => {
            if (argv[0] === "tasklist") {
                return {
                    exitCode: 0,
                    stdout: '"chrome.exe","1234","Console","1","150,000 K"\n"msedge.exe","77","Console","1","90,000 K"\n"notepad.exe","5","Console","1","9,000 K"\n',
                    stderr: "",
                };
            }

            return { exitCode: 1, stdout: "", stderr: "" };
        };

        expect(listRunningBrowsers(exec, "win32")).toEqual(["chrome", "edge"]);
        expect(parseTasklistImages('"brave.exe","9"\n')).toEqual(new Set(["brave.exe"]));
    });
});

describe("ownerOfPort", () => {
    test("classifies via the process command line of the listening pid", () => {
        const exec = posixExec({
            lsof: "Google   52730 Martin  43u  IPv4 TCP 127.0.0.1:9222 (LISTEN)\n",
            procs: "  52730 1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=browser\n",
        });

        expect(ownerOfPort(9222, exec, "darwin")).toBe("chrome");
    });

    test("maps a Brave listening pid to brave, and a linux chrome path to chrome", () => {
        const braveExec = posixExec({
            lsof: "Brave   1030 Martin  43u  IPv4 TCP 127.0.0.1:9224 (LISTEN)\n",
            procs: "  1030 1 /Applications/Brave Browser.app/Contents/MacOS/Brave Browser\n",
        });
        expect(ownerOfPort(9224, braveExec, "darwin")).toBe("brave");

        const linuxExec = posixExec({
            lsof: "chrome   77 martin  43u  IPv4 TCP 127.0.0.1:9222 (LISTEN)\n",
            procs: "  77 1 /opt/google/chrome/chrome --remote-debugging-port=9222\n",
        });
        expect(ownerOfPort(9222, linuxExec, "linux")).toBe("chrome");
    });

    test("returns null when nothing listens on the port", () => {
        expect(ownerOfPort(9222, posixExec({}), "darwin")).toBe(null);
    });
});

describe("classifyProcessName", () => {
    test("maps macOS bundle paths and bare names", () => {
        expect(classifyProcessName("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")).toBe("chrome");
        expect(classifyProcessName("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser")).toBe("brave");
        expect(classifyProcessName("Google Chrome")).toBe("chrome");
        expect(classifyProcessName("Brave Browser")).toBe("brave");
        expect(classifyProcessName("Safari")).toBe(null);
    });

    test("maps linux binaries and windows image names", () => {
        expect(classifyProcessName("/opt/google/chrome/chrome --type=renderer")).toBe("chrome");
        expect(classifyProcessName("/usr/bin/brave-browser --remote-debugging-port=9222")).toBe("brave");
        expect(classifyProcessName("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe --type=browser")).toBe(
            "chrome"
        );
        expect(classifyProcessName("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe")).toBe("edge");
        expect(classifyProcessName("Firefox")).toBe(null);
    });

    test("maps Edge, Arc, and Chrome Canary; does not treat Safari as attachable", () => {
        expect(classifyProcessName("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")).toBe("edge");
        expect(classifyProcessName("Arc")).toBe("arc");
        expect(classifyProcessName("/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary")).toBe(
            "chrome-canary"
        );
    });
});

describe("planAttach", () => {
    test("refuses to pick a browser when Chrome has CDP and Brave is open without it", () => {
        const plan = planAttach({
            running: ["chrome", "brave"],
            endpoints: [CHROME_LOCALHOST],
        });

        expect(plan.status).toBe("ambiguous");
        expect(plan.undebugged).toEqual(["brave"]);

        const { text, exitCode } = renderAttachPlan(plan, {
            cmd: "tools chrome-devtools",
            suggestCommand: suggest,
            platform: "darwin",
        });

        expect(exitCode).toBe(1);
        expect(text).toContain("Brave Browser");
        expect(text).toContain("debugging port is not on");
        expect(text).toContain("osascript -e 'quit app \"Brave Browser\"'");
        expect(text).toContain('open -na "Brave Browser" --args --remote-debugging-port=9223');
        expect(text).toContain("tools chrome-devtools attach --port 9222");
    });

    test("non-darwin render offers the tool's restart, not osascript", () => {
        const plan = planAttach({ running: ["chrome", "brave"], endpoints: [CHROME_LOCALHOST] });
        const { text } = renderAttachPlan(plan, {
            cmd: "tools chrome-devtools",
            suggestCommand: suggest,
            platform: "linux",
        });

        expect(text).toContain("restart --browser brave");
        expect(text).not.toContain("osascript");
        expect(text).not.toContain("open -na");
    });

    test("explicit --port lists that endpoint instead of refusing", () => {
        const plan = planAttach(
            { running: ["chrome", "brave"], endpoints: [CHROME_LOCALHOST] },
            { explicitPort: 9222 }
        );

        expect(plan.status).toBe("list");
        expect(
            renderAttachPlan(plan, { cmd: "tools chrome-devtools", suggestCommand: suggest, platform: "darwin" })
                .exitCode
        ).toBe(0);
    });

    test("explicit --port does not list the other browser as debugging on with no pages", () => {
        const plan = planAttach(
            {
                running: ["chrome", "brave"],
                endpoints: [
                    {
                        port: 9223,
                        browser: "Chrome/151.0.7922.138",
                        owner: "chrome",
                        pages: [{ title: "IdP", url: "https://idp.example.com/" }],
                    },
                    {
                        port: 9222,
                        browser: "Chrome/151.0.7922.173",
                        owner: "brave",
                        pages: [{ title: "portal", url: "https://app.example.com/portal" }],
                    },
                ],
            },
            { explicitPort: 9223 }
        );

        const { text, exitCode } = renderAttachPlan(plan, {
            cmd: "tools chrome-devtools",
            suggestCommand: suggest,
            platform: "darwin",
        });
        expect(exitCode).toBe(0);
        expect(text).toContain("9223");
        expect(text).not.toContain("Brave Browser");
        expect(text).not.toContain("app.example.com");
    });

    test("refuses when both Chrome and Brave have CDP", () => {
        const plan = planAttach({
            running: ["chrome", "brave"],
            endpoints: [
                {
                    port: 9223,
                    browser: "Chrome/151.0.7922.138",
                    owner: "chrome",
                    pages: [{ title: "IdP", url: "https://idp.example.com/" }],
                },
                {
                    port: 9222,
                    browser: "Chrome/151.0.7922.173",
                    owner: "brave",
                    pages: [{ title: "portal", url: "https://app.example.com/portal" }],
                },
            ],
        });

        expect(plan.status).toBe("ambiguous");
        expect(plan.undebugged).toEqual([]);
        const { text, exitCode } = renderAttachPlan(plan, {
            cmd: "tools chrome-devtools",
            suggestCommand: suggest,
            platform: "darwin",
        });
        expect(exitCode).toBe(1);
        expect(text).toContain("Google Chrome");
        expect(text).toContain("Brave Browser");
        expect(text).toContain("tools chrome-devtools attach --port 9222");
        expect(text).toContain("tools chrome-devtools attach --port 9223");
        expect(text).not.toContain("debugging port is not on");
    });

    test("refuses Chrome plus Edge the same way as Chrome plus Brave", () => {
        const plan = planAttach({
            running: ["chrome", "edge"],
            endpoints: [CHROME_LOCALHOST],
        });

        expect(plan.status).toBe("ambiguous");
        expect(plan.undebugged).toEqual(["edge"]);

        const { text, exitCode } = renderAttachPlan(plan, {
            cmd: "tools chrome-devtools",
            suggestCommand: suggest,
            platform: "darwin",
        });

        expect(exitCode).toBe(1);
        expect(text).toContain("Microsoft Edge");
        expect(text).toContain("debugging port is not on");
        expect(text).toContain("nothing is picked silently");
    });

    test("does not refuse when only Chrome is running", () => {
        const plan = planAttach({ running: ["chrome"], endpoints: [CHROME_LOCALHOST] });

        expect(plan.status).toBe("list");
        const { text, exitCode } = renderAttachPlan(plan, {
            cmd: "tools chrome-devtools",
            suggestCommand: suggest,
            platform: "darwin",
        });
        expect(exitCode).toBe(0);
        expect(text).not.toContain("nothing is picked silently");
    });
});

describe("isPortSpecified", () => {
    test("treats --port and --port= as an explicit choice", () => {
        expect(isPortSpecified(["bun", "index.ts", "attach"])).toBe(false);
        expect(isPortSpecified(["bun", "index.ts", "cookies", "--port", "9222"])).toBe(true);
        expect(isPortSpecified(["bun", "index.ts", "eval", "--port=9223", "() => 1"])).toBe(true);
    });
});

describe("parseRemoteDebuggingPort", () => {
    test("treats --remote-debugging-port= with no value as empty", () => {
        expect(parseRemoteDebuggingPort("Brave Browser --remote-debugging-port=")).toEqual({
            present: true,
            empty: true,
            port: null,
        });
        expect(parseRemoteDebuggingPort("Brave Browser --remote-debugging-port=9222")).toEqual({
            present: true,
            empty: false,
            port: 9222,
        });
        expect(parseRemoteDebuggingPort("Brave Browser --no-first-run")).toEqual({
            present: false,
            empty: false,
            port: null,
        });
    });
});

describe("browsersWithEmptyDebugFlag", () => {
    test("finds Brave when the process list shows --remote-debugging-port= with no value", () => {
        const exec = posixExec({
            procs: [
                "  10 1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9223",
                "  11 1 /Applications/Brave Browser.app/Contents/MacOS/Brave Browser --remote-debugging-port=",
                "  12 1 /usr/local/bin/bun --watch",
            ].join("\n"),
        });

        expect(browsersWithEmptyDebugFlag(exec, "darwin")).toEqual(["brave"]);
    });
});

describe("discoverListeningCdpPorts", () => {
    test("includes a browser listener on 9333 and skips bun on 9876", () => {
        const exec = posixExec({
            lsof: [
                "Brave   1030 Martin  43u  IPv4 TCP 127.0.0.1:9333 (LISTEN)",
                "bun     1823 Martin  10u  IPv4 TCP 127.0.0.1:9876 (LISTEN)",
            ].join("\n"),
            procs: [
                "  1030 1 /Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
                "  1823 1 bun run something",
            ].join("\n"),
        });

        expect(discoverListeningCdpPorts(exec, "darwin")).toEqual([9333]);
    });

    test("win32 uses netstat listeners with the same classification", () => {
        const exec = (argv: string[]) => {
            if (argv[0] === "netstat") {
                return {
                    exitCode: 0,
                    stdout: "  TCP    127.0.0.1:9222         0.0.0.0:0              LISTENING       4321\n",
                    stderr: "",
                };
            }

            if (argv[0] === "powershell") {
                return {
                    exitCode: 0,
                    stdout: '[{"ProcessId":4321,"ParentProcessId":1,"CommandLine":"C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe --remote-debugging-port=9222","Name":"chrome.exe"}]',
                    stderr: "",
                };
            }

            return { exitCode: 1, stdout: "", stderr: "" };
        };

        expect(discoverListeningCdpPorts(exec, "win32")).toEqual([9222]);
    });
});

describe("readDevToolsActivePorts", () => {
    test("reads the first line of a Brave DevToolsActivePort file (darwin)", () => {
        const ports = readDevToolsActivePorts({
            home: "/Users/someone",
            platform: "darwin",
            readFile: (abs) => {
                if (abs.endsWith("BraveSoftware/Brave-Browser/DevToolsActivePort")) {
                    return "9333\n/devtools/browser/abc\n";
                }

                return null;
            },
        });

        expect(ports).toEqual([9333]);
    });

    test("linux and windows use their own relpaths", () => {
        const linux = readDevToolsActivePorts({
            home: "/home/someone",
            platform: "linux",
            readFile: (abs) => (abs.endsWith(".config/google-chrome/DevToolsActivePort") ? "9222\nx\n" : null),
        });
        expect(linux).toEqual([9222]);

        const win = readDevToolsActivePorts({
            home: "C:/Users/someone/AppData/Local",
            platform: "win32",
            readFile: (abs) => (abs.endsWith("Google/Chrome/User Data/DevToolsActivePort") ? "9224\nx\n" : null),
        });
        expect(win).toEqual([9224]);
    });
});

describe("waitForCdp", () => {
    test("polls until probe succeeds instead of sleeping once", async () => {
        let n = 0;
        const ok = await waitForCdp({
            port: 9222,
            timeoutMs: 5000,
            probe: async () => {
                n++;
                return n >= 3;
            },
            sleep: async () => {},
        });

        expect(ok).toBe(true);
        expect(n).toBe(3);
    });
});

describe("quitBrowser", () => {
    test("darwin: returns after pgrep goes quiet without sending KILL", async () => {
        let pgrepCalls = 0;
        const argvLog: string[][] = [];
        const exec = (argv: string[]) => {
            argvLog.push(argv);
            if (argv[0] === "osascript") {
                return { exitCode: 0, stdout: "", stderr: "" };
            }

            if (argv[0] === "pgrep") {
                pgrepCalls++;
                if (pgrepCalls < 3) {
                    return { exitCode: 0, stdout: "1030\n", stderr: "" };
                }

                return { exitCode: 1, stdout: "", stderr: "" };
            }

            return { exitCode: 1, stdout: "", stderr: `unexpected ${argv.join(" ")}` };
        };

        expect(await quitBrowser({ app: "Brave Browser", exec, sleep: async () => {}, platform: "darwin" })).toEqual({
            exited: true,
            usedForce: false,
        });
        expect(argvLog.some((a) => a[0] === "kill")).toBe(false);
    });

    test("darwin: sends kill -KILL only when force is set and quit stuck", async () => {
        let live = true;
        const exec = (argv: string[]) => {
            if (argv[0] === "osascript") {
                return { exitCode: 0, stdout: "", stderr: "" };
            }

            if (argv[0] === "pgrep") {
                return live ? { exitCode: 0, stdout: "1030\n", stderr: "" } : { exitCode: 1, stdout: "", stderr: "" };
            }

            if (argv[0] === "kill" && argv.includes("-KILL") && argv.includes("1030")) {
                live = false;
                return { exitCode: 0, stdout: "", stderr: "" };
            }

            return { exitCode: 1, stdout: "", stderr: `unexpected ${argv.join(" ")}` };
        };

        expect(
            await quitBrowser({
                app: "Brave Browser",
                force: true,
                timeoutMs: 0,
                exec,
                sleep: async () => {},
                platform: "darwin",
            })
        ).toEqual({ exited: true, usedForce: true });
    });

    test("linux: pkill -TERM the bins, then pgrep until quiet", async () => {
        const argvLog: string[][] = [];
        let alive = true;
        const exec = (argv: string[]) => {
            argvLog.push(argv);
            if (argv[0] === "pkill") {
                alive = false;
                return { exitCode: 0, stdout: "", stderr: "" };
            }

            if (argv[0] === "pgrep") {
                return alive ? { exitCode: 0, stdout: "5\n", stderr: "" } : { exitCode: 1, stdout: "", stderr: "" };
            }

            return { exitCode: 1, stdout: "", stderr: "" };
        };

        const brave = { id: "brave", app: "Brave Browser", match: ["brave"], linuxBins: ["brave-browser", "brave"] };
        expect(
            await quitBrowser({ app: "Brave Browser", browser: brave, exec, sleep: async () => {}, platform: "linux" })
        ).toEqual({ exited: true, usedForce: false });
        expect(argvLog.some((a) => a[0] === "pkill" && a.includes("-TERM"))).toBe(true);
        expect(argvLog.some((a) => a[0] === "osascript")).toBe(false);
    });

    test("win32: taskkill /IM without /F, then tasklist until the image is gone", async () => {
        const argvLog: string[][] = [];
        let alive = true;
        const exec = (argv: string[]) => {
            argvLog.push(argv);
            if (argv[0] === "taskkill") {
                alive = false;
                return { exitCode: 0, stdout: "", stderr: "" };
            }

            if (argv[0] === "tasklist") {
                return {
                    exitCode: 0,
                    stdout: alive ? '"chrome.exe","1234"\n' : "INFO: No tasks are running.\n",
                    stderr: "",
                };
            }

            return { exitCode: 1, stdout: "", stderr: "" };
        };

        const chrome = { id: "chrome", app: "Google Chrome", match: ["chrome"], winExes: ["chrome.exe"] };
        expect(
            await quitBrowser({ app: "Google Chrome", browser: chrome, exec, sleep: async () => {}, platform: "win32" })
        ).toEqual({ exited: true, usedForce: false });
        const kill = argvLog.find((a) => a[0] === "taskkill");
        expect(kill).toEqual(["taskkill", "/IM", "chrome.exe"]);
    });
});

describe("empty debug flag render", () => {
    test("says the debugging flag is empty when Brave has --remote-debugging-port=", () => {
        const plan = planAttach({
            running: ["chrome", "brave"],
            endpoints: [CHROME_LOCALHOST],
            emptyDebugFlag: ["brave"],
        });
        const { text } = renderAttachPlan(plan, {
            cmd: "tools chrome-devtools",
            suggestCommand: suggest,
            platform: "darwin",
        });
        expect(text).toContain("debugging flag is empty");
        expect(text).toContain("restart --browser brave --port 9223");
    });
});

describe("launchBrowser", () => {
    const chrome = browserById("chrome");
    if (!chrome) {
        throw new Error("chrome missing from BROWSERS");
    }

    const okExec = () => ({ exitCode: 0, stdout: "", stderr: "" });

    test("darwin: goes through `open -na <app> --args`", () => {
        const argvLog: string[][] = [];
        const exec = (argv: string[]) => {
            argvLog.push(argv);

            return okExec();
        };

        const r = launchBrowser({
            browser: chrome,
            args: ["--remote-debugging-port=9222"],
            url: "about:blank",
            exec,
            platform: "darwin",
            spawnDetached: () => {
                throw new Error("darwin must not Bun.spawn");
            },
        });
        expect(r.ok).toBe(true);
        expect(argvLog[0]).toEqual([
            "open",
            "-na",
            "Google Chrome",
            "--args",
            "--remote-debugging-port=9222",
            "about:blank",
        ]);
    });

    test("linux: picks the first bin that `which` finds and spawns it detached", () => {
        const spawned: string[][] = [];
        const exec = (argv: string[]) =>
            argv[0] === "which" && argv[1] === "google-chrome-stable"
                ? okExec()
                : { exitCode: 1, stdout: "", stderr: "" };

        const r = launchBrowser({
            browser: chrome,
            args: ["--remote-debugging-port=9222"],
            url: "about:blank",
            exec,
            platform: "linux",
            spawnDetached: (cmd) => spawned.push(cmd),
        });
        expect(r.ok).toBe(true);
        expect(spawned[0]).toEqual(["google-chrome-stable", "--remote-debugging-port=9222", "about:blank"]);
    });

    test("linux: no bin on PATH is an error naming every candidate, and spawns nothing", () => {
        const r = launchBrowser({
            browser: chrome,
            args: [],
            url: "about:blank",
            exec: () => ({ exitCode: 1, stdout: "", stderr: "" }),
            platform: "linux",
            spawnDetached: () => {
                throw new Error("must not spawn without a bin");
            },
        });
        expect(r.ok).toBe(false);
        expect(r.message).toContain("google-chrome");
        expect(r.message).toContain("google-chrome-stable");
    });

    test("win32: uses the known install path when it exists", async () => {
        const spawned: string[][] = [];
        await env.testing.withOverrides({ ProgramFiles: "C:/Program Files" }, () => {
            launchBrowser({
                browser: chrome,
                args: ["--remote-debugging-port=9222"],
                url: "about:blank",
                platform: "win32",
                spawnDetached: (cmd) => spawned.push(cmd),
                fileExists: (p) => p.includes("Google/Chrome/Application/chrome.exe"),
            });
        });
        expect(spawned[0]?.[0]).toContain("Google/Chrome/Application/chrome.exe");
    });

    test("win32: falls back to the bare exe name (PATH) when no install root has it", () => {
        const spawned: string[][] = [];
        const r = launchBrowser({
            browser: chrome,
            args: [],
            url: "about:blank",
            platform: "win32",
            spawnDetached: (cmd) => spawned.push(cmd),
            fileExists: () => false,
        });
        expect(r.ok).toBe(true);
        expect(spawned[0]?.[0]).toBe("chrome.exe");
    });

    test("win32: a browser with no exe mapping errors instead of guessing", () => {
        const r = launchBrowser({
            browser: { id: "chromium", app: "Chromium", match: ["chromium"] },
            args: [],
            url: "about:blank",
            platform: "win32",
            spawnDetached: () => {
                throw new Error("must not spawn without a mapping");
            },
        });
        expect(r.ok).toBe(false);
        expect(r.message).toContain("no Windows executable mapping");
    });
});

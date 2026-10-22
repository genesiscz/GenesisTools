import { describe, expect, it, spyOn } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import * as processes from "@genesiscz/utils/process/processes";
import { skip } from "@genesiscz/utils/test/skip";
import {
    deleteRetiredStamps,
    describeSource,
    listRetiredStamps,
    parseCodesignInfo,
    pickCodesignIdentity,
    readSourceInfo,
    retiredStampsToDelete,
    signByHashes,
    signStagedBundle,
    staleAppFacePids,
    staleRegistrations,
    stampInfoPlist,
    timedSteps,
} from "./app";
import { isPermissionKind, PERMISSION_KINDS, permissionStatusLabel } from "./kinds";
import {
    type AppProcess,
    describePromptProcesses,
    groupOldBuilds,
    localNetworkAnswer,
    parseLocalNetworkPrompts,
    parseLocalNetworkRules,
    promptsFromLogShow,
    retiredAtOf,
    withoutPreloads,
} from "./local-network";
import {
    ALL_PART_IDS,
    bundleStepsFor,
    installedParts,
    parsePartsFlag,
    partForFace,
    partsEnvValue,
    partsForBuild,
    scratchName,
} from "./parts";
import { collectProblems, grantsFor, launchdJobsOutsideApp } from "./report";
import { readTccRows, TCC_SERVICES, type TccReadResult, tccAuthLabel } from "./tcc";

const FIND_IDENTITY = `Policy: Code Signing
  Matching identities
  1) 59C58A980E277336F7FE8C9FAEF0F2D4ABE68601 "Apple Development: dev@example.com (TEAM1)"
  2) 00B19497EBBEEB0723ECDE42FD6312677BEF2A29 "Developer ID Application: Example Person (TEAM2)"
     2 valid identities found`;

describe("pickCodesignIdentity", () => {
    it("prefers Developer ID over Apple Development", () => {
        expect(pickCodesignIdentity(FIND_IDENTITY)).toEqual({
            kind: "developer-id",
            name: "Developer ID Application: Example Person (TEAM2)",
        });
    });

    it("takes Apple Development when that is all there is", () => {
        const onlyDev = FIND_IDENTITY.split("\n")
            .filter((l) => !l.includes("Developer ID"))
            .join("\n");
        expect(pickCodesignIdentity(onlyDev).kind).toBe("apple-development");
    });

    it("falls back to ad-hoc, and honours an explicit override", () => {
        expect(pickCodesignIdentity("0 valid identities found")).toEqual({ kind: "adhoc" });
        expect(pickCodesignIdentity(FIND_IDENTITY, "-")).toEqual({ kind: "adhoc" });
        expect(pickCodesignIdentity(FIND_IDENTITY, "My Cert")).toEqual({ kind: "custom", name: "My Cert" });
    });

    // Two certificates with one name made `codesign --sign <name>` fail "ambiguous" after a 7-minute build.
    it("keeps the hash of every certificate that shares the picked name", () => {
        const twice = `  1) ${"A".repeat(40)} "Apple Development: dev@example.com (TEAM1)"
  2) ${"B".repeat(40)} "Apple Development: dev@example.com (TEAM1)"
     2 valid identities found`;
        expect(pickCodesignIdentity(twice)).toEqual({
            kind: "apple-development",
            name: "Apple Development: dev@example.com (TEAM1)",
            hashes: ["A".repeat(40), "B".repeat(40)],
        });
    });
});

describe("signStagedBundle", () => {
    it("times out a stalled certificate and retries without blocking progress", async () => {
        const hashes: string[] = [];
        const deadlines: number[] = [];
        let progressed = false;
        const timer = setTimeout(() => {
            progressed = true;
        }, 10);
        try {
            await signStagedBundle({
                stagedBundle: "/fixture/App.app",
                identity: { kind: "custom", name: "Dev", hashes: ["AAA", "BBB"] },
                step: () => {},
                timeoutMs: 100,
                runCommand: async (options) => {
                    expect(options.command[0]).toBe("codesign");
                    expect(options.command.at(-1)).toBe("/fixture/App.app");
                    const hash = options.command[options.command.indexOf("--sign") + 1];
                    hashes.push(hash);
                    deadlines.push(options.timeoutMs);
                    if (hash === "AAA") {
                        return boundedCommand({
                            command: [
                                process.execPath,
                                "-e",
                                'process.on("SIGTERM", () => {}); setTimeout(() => {}, 1000);',
                            ],
                            timeoutMs: options.timeoutMs,
                        });
                    }

                    return { status: 0, signal: null, stdout: "", stderr: "" };
                },
            });
            expect(hashes).toEqual(["AAA", "BBB"]);
            expect(deadlines).toEqual([100, 100]);
            expect(progressed).toBe(true);
        } finally {
            clearTimeout(timer);
        }
    });

    it.each([{ kind: "adhoc" as const }, { kind: "custom" as const, name: "Dev" }])(
        "reports an actionable bounded failure for a single identity %j",
        async (identity) => {
            const attempts: string[][] = [];
            await expect(
                signStagedBundle({
                    stagedBundle: "/fixture/App.app",
                    identity,
                    step: () => {},
                    runCommand: async (options) => {
                        attempts.push(options.command);
                        expect(options.timeoutMs).toBe(10_000);
                        return {
                            status: null,
                            signal: null,
                            stdout: "",
                            stderr: "partial signing output",
                            error: Object.assign(new Error("deadline"), { code: "ETIMEDOUT" }),
                        };
                    },
                })
            ).rejects.toThrow("codesign attempt timed out after 10000 ms and was terminated");
            expect(attempts).toHaveLength(1);
            expect(attempts[0][attempts[0].indexOf("--sign") + 1]).toBe(identity.kind === "adhoc" ? "-" : "Dev");
        }
    );

    it("reports every timed-out certificate when no retry can sign", async () => {
        const hashes: string[] = [];
        await expect(
            signStagedBundle({
                stagedBundle: "/fixture/App.app",
                identity: { kind: "custom", name: "Dev", hashes: ["AAA", "BBB"] },
                step: () => {},
                runCommand: async (options) => {
                    hashes.push(options.command[options.command.indexOf("--sign") + 1]);
                    return {
                        status: null,
                        signal: null,
                        stdout: "",
                        stderr: "",
                        error: Object.assign(new Error("deadline"), { code: "ETIMEDOUT" }),
                    };
                },
            })
        ).rejects.toThrow("codesign failed with every certificate named");
        expect(hashes).toEqual(["AAA", "BBB"]);
    });
});

describe("signByHashes", () => {
    const quiet = () => {};

    it("signs with the first certificate that works, in keychain order", async () => {
        const tried: string[] = [];
        const signed = await signByHashes({
            name: "Dev",
            hashes: ["AAA", "BBB", "CCC"],
            sign: async (hash) => {
                tried.push(hash);
                return hash === "BBB" ? { code: 0, stderr: "" } : { code: 1, stderr: "expired" };
            },
            step: quiet,
        });
        expect(signed).toBe("BBB");
        expect(tried).toEqual(["AAA", "BBB"]);
    });

    it("asks which certificate once the failed attempts took more than 10 s", async () => {
        let clock = 0;
        const asked: string[][] = [];
        const tried: string[] = [];
        const signed = await signByHashes({
            name: "Dev",
            hashes: ["AAA", "BBB", "CCC"],
            sign: async (hash) => {
                tried.push(hash);
                clock += 11_000;
                return hash === "CCC" ? { code: 0, stderr: "" } : { code: 1, stderr: "slow failure" };
            },
            step: quiet,
            choose: async (_name, left) => {
                asked.push(left);
                return "CCC";
            },
            now: () => clock,
        });
        expect(signed).toBe("CCC");
        expect(tried).toEqual(["AAA", "CCC"]);
        expect(asked).toEqual([["BBB", "CCC"]]);
    });

    it("names every failure when no certificate signs", async () => {
        await expect(
            signByHashes({
                name: "Dev",
                hashes: ["AAA", "BBB"],
                sign: () => ({ code: 1, stderr: "nope" }),
                step: quiet,
            })
        ).rejects.toThrow("AAA: nope\nBBB: nope");
    });
});

describe("parseCodesignInfo", () => {
    it("reads a Developer ID signature", () => {
        const info = parseCodesignInfo(
            "Identifier=com.genesiscz.genesistools\nAuthority=Developer ID Application: Example (TEAM2)\nAuthority=Developer ID Certification Authority\nTeamIdentifier=TEAM2\n"
        );
        expect(info.adhoc).toBe(false);
        expect(info.authority).toBe("Developer ID Application: Example (TEAM2)");
        expect(info.teamId).toBe("TEAM2");
    });

    it("flags ad-hoc signatures", () => {
        const info = parseCodesignInfo(
            "Identifier=com.genesiscz.genesistools\nSignature=adhoc\nTeamIdentifier=not set\n"
        );
        expect(info.adhoc).toBe(true);
        expect(info.authority).toBe("adhoc");
        expect(info.teamId).toBeUndefined();
    });
});

describe("tccAuthLabel", () => {
    it("names Calendar levels and generic levels differently", () => {
        expect(tccAuthLabel("kTCCServiceCalendar", 4)).toBe("Add Only");
        expect(tccAuthLabel("kTCCServiceCalendar", 2)).toBe("Full Access");
        expect(tccAuthLabel("kTCCServiceReminders", 2)).toBe("allowed");
        expect(tccAuthLabel("kTCCServiceReminders", 0)).toBe("denied");
    });
});

describe("readTccRows", () => {
    it("reports an unreadable database instead of an empty grant list", () => {
        const result = readTccRows({ dbPath: "/nonexistent/TCC.db", services: ["kTCCServiceCalendar"] });
        expect(result.readable).toBe(false);
        expect(result.rows).toEqual([]);
        expect(result.error).toBeTruthy();
    });
});

describe("grantsFor", () => {
    const calendar = TCC_SERVICES.find((s) => s.id === "kTCCServiceCalendar");
    const fda = TCC_SERVICES.find((s) => s.id === "kTCCServiceSystemPolicyAllFiles");

    if (!calendar || !fda) {
        throw new Error("service table changed");
    }

    const user: TccReadResult = {
        readable: true,
        rows: [
            {
                service: "kTCCServiceCalendar",
                client: "com.genesiscz.genesistools",
                clientType: 0,
                authValue: 4,
                label: "Add Only",
                lastModified: "2026-09-03T00:00:00.000Z",
            },
        ],
    };

    it("marks granted, partial and unknown states", () => {
        const grants = grantsFor("com.genesiscz.genesistools", user, { readable: false, rows: [] }, [calendar, fda]);
        expect(grants[0]).toMatchObject({ granted: false, label: "Add Only" });
        expect(grants[1].granted).toBeUndefined();
        expect(grants[1].label).toContain("not readable");
    });

    it("says not asked yet when no row exists", () => {
        const grants = grantsFor("com.other", user, user, [calendar]);
        expect(grants[0]).toMatchObject({ granted: false, label: "not asked yet" });
    });
});

function processRows(text: string): Array<{ pid: number; command: string }> {
    return text.split("\n").flatMap((line) => {
        const match = line.trim().match(/^(\d+)\s+(.*)$/);
        return match ? [{ pid: Number(match[1]), command: match[2] }] : [];
    });
}

describe("staleAppFacePids", () => {
    const launcher = "/Users/example/Applications/GenesisTools.app/Contents/MacOS/GenesisTools";

    it("kills the settings window, --rpc, and --window, and leaves the launcher alone", () => {
        const stdout = [
            `  111 ${launcher}`,
            `  222 ${launcher} --rpc '{"method":"notify.post"}'`,
            `  333 ${launcher} --window`,
            `  444 ${launcher} /opt/homebrew/bin/bun tools foo`,
            "  555 /usr/bin/osascript -e hi",
            `  666 ${launcher} --notify`,
        ].join("\n");

        expect(staleAppFacePids(processRows(stdout), launcher)).toEqual(["111", "222", "333", "666"]);
    });

    it("kills a link router that outlived its link, but not a launcher whose program takes a URL", () => {
        const stdout = [
            `  111 ${launcher} https://example.com/a%20b`,
            `  222 ${launcher} http://example.com/`,
            `  333 ${launcher} /opt/homebrew/bin/bun tools open https://example.com/`,
            `  444 ${launcher} genesis-tools://hub?mode=prs`,
        ].join("\n");

        expect(staleAppFacePids(processRows(stdout), launcher)).toEqual(["111", "222"]);
    });

    it("ignores unrelated processes and empty listings", () => {
        expect(staleAppFacePids([], launcher)).toEqual([]);
        expect(staleAppFacePids([{ pid: 1, command: "/sbin/launchd" }], launcher)).toEqual([]);
    });

    it("never takes a sibling binary whose name only starts with the launcher's", () => {
        const stdout = [`  777 ${launcher}-helper`, `  888 ${launcher}-helper --rpc`, `  999 ${launcher} --rpc`].join(
            "\n"
        );

        expect(staleAppFacePids(processRows(stdout), launcher)).toEqual(["999"]);
    });
});

describe("stampInfoPlist", () => {
    const template =
        "<key>CFBundleShortVersionString</key>\n\t<string>0.0.0</string>\n\t<key>CFBundleVersion</key>\n\t<string>1</string>\n";

    it("stamps both the version and the build number", () => {
        const out = stampInfoPlist(template, 1700000000);
        expect(out).toContain("<string>1.0</string>");
        expect(out).toContain("<key>CFBundleVersion</key>\n\t<string>1700000000</string>");
        expect(out).not.toContain("<string>0.0.0</string>");
    });

    it("refuses a template that lost either marker", () => {
        expect(() => stampInfoPlist(template.replace("<string>1</string>", "<string>2</string>"), 1)).toThrow(
            /CFBundleVersion/
        );
        expect(() => stampInfoPlist(template.replace("0.0.0", "9.9.9"), 1)).toThrow(/0\.0\.0/);
    });
});

// macOS only: launchdJobsOutsideApp reads each plist through `plutil` (report.ts:80), a binary that
// ships with macOS and exists nowhere else. On Linux every plist reads back as zero ProgramArguments,
// so a wrapped job looks bare and an escaped launcher path never matches.
describe.skipIf(skip.unlessMac)("launchdJobsOutsideApp", () => {
    /** A real plist, since the scan reads ProgramArguments through `plutil` rather than the text. */
    function writePlist(dir: string, label: string, programArguments: string[], extra = ""): void {
        const args = programArguments.map((arg) => `    <string>${arg.replace(/&/g, "&amp;")}</string>`).join("\n");
        writeFileSync(
            join(dir, `${label}.plist`),
            `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
${extra}</dict>
</plist>
`
        );
    }

    const launcher = "/Users/x/Applications/GenesisTools.app/Contents/MacOS/GenesisTools";

    it("lists com.genesis-tools plists that do not go through the launcher", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-launchd-"));
        writePlist(dir, "com.genesis-tools.bare", ["/Users/x/.bun/bin/bun", "run", "x.ts"]);
        writePlist(dir, "com.genesis-tools.wrapped", [launcher, "/Users/x/.bun/bin/bun", "run", "x.ts"]);
        writePlist(dir, "dev.other", ["/Users/x/.bun/bin/bun"]);
        expect(launchdJobsOutsideApp(launcher, dir)).toEqual(["com.genesis-tools.bare"]);
    });

    it("does not count the launcher path outside ProgramArguments as migrated", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-launchd-strings-"));
        // The path appears in the file, but the job still runs the bare command.
        writePlist(
            dir,
            "com.genesis-tools.logpath",
            ["/Users/x/.bun/bin/bun", "run", "x.ts"],
            `  <key>StandardOutPath</key><string>${launcher}.log</string>\n`
        );
        expect(launchdJobsOutsideApp(launcher, dir)).toEqual(["com.genesis-tools.logpath"]);
    });

    it("matches a launcher path that the writer had to XML-escape", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-launchd-escape-"));
        const odd = "/Users/x/Apps & Tools/GenesisTools.app/Contents/MacOS/GenesisTools";
        writePlist(dir, "com.genesis-tools.escaped", [odd, "/Users/x/.bun/bin/bun"]);
        expect(launchdJobsOutsideApp(odd, dir)).toEqual([]);
    });

    it("returns nothing for a missing LaunchAgents dir", () => {
        expect(launchdJobsOutsideApp("/x/GenesisTools", "/nonexistent/LaunchAgents")).toEqual([]);
    });
});

describe("collectProblems", () => {
    const base = {
        identity: { kind: "genesis-app" as const, bundleId: "com.genesiscz.genesistools" },
        grants: [],
        localNetwork: "allowed" as const,
        oldBuilds: [],
        launchdJobsOutsideApp: [],
        disabledByMarker: false,
        userDb: { readable: true },
        systemDb: { readable: true },
    };
    const builtApp = {
        bundlePath: "/x/GenesisTools.app",
        launcherPath: "/x/GenesisTools.app/Contents/MacOS/GenesisTools",
        built: true,
        stale: false,
        parts: [],
        identityStable: true,
    };

    it("is quiet when the signed app runs this process", () => {
        expect(collectProblems({ ...base, app: builtApp })).toEqual([]);
    });

    it("names the missing app, the ad-hoc signature and the stale build", () => {
        expect(collectProblems({ ...base, app: { ...builtApp, built: false } })[0]).toContain("not built");
        expect(collectProblems({ ...base, app: { ...builtApp, identityStable: false } })[0]).toContain("ad-hoc");
        expect(collectProblems({ ...base, app: { ...builtApp, stale: true } })[0]).toContain("sources changed");
    });

    it("reads an unreadable TCC.db under GenesisTools.app as missing Full Disk Access", () => {
        const problems = collectProblems({
            ...base,
            app: builtApp,
            userDb: { readable: false, error: "unable to open" },
        });
        expect(problems[0]).toContain("Full Disk Access is not granted");
        expect(problems[0]).toContain("full-disk-access");
        expect(problems[0]).toContain("Applications");
    });

    it("names launchd jobs that still bypass the launcher", () => {
        const problems = collectProblems({
            ...base,
            app: builtApp,
            launchdJobsOutsideApp: ["com.genesis-tools.dev-dashboard"],
        });
        expect(problems[0]).toContain("com.genesis-tools.dev-dashboard");
        expect(problems[0]).toContain("next start");
    });

    it("explains a switched-off launcher instead of blaming the process", () => {
        const problems = collectProblems({
            ...base,
            identity: { kind: "host-app", bundleId: "com.x" },
            app: builtApp,
            disabledByMarker: true,
        });
        expect(problems[0]).toContain("switched off");
        expect(problems.some((p) => p.includes("not running under GenesisTools.app"))).toBe(false);
    });

    it("flags a process that bypassed the launcher", () => {
        const problems = collectProblems({ ...base, identity: { kind: "host-app", bundleId: "com.x" }, app: builtApp });
        expect(problems[0]).toContain("not running under GenesisTools.app");
    });
});
describe("grantsFor: Automation is per target", () => {
    const automation = TCC_SERVICES.find((s) => s.id === "kTCCServiceAppleEvents");

    if (!automation) {
        throw new Error("service table changed");
    }

    const user: TccReadResult = {
        readable: true,
        rows: [
            {
                service: "kTCCServiceAppleEvents",
                client: "com.genesiscz.genesistools",
                clientType: 0,
                authValue: 0,
                authReason: 9,
                target: "com.apple.Notes",
                label: "prompt timed out (never answered)",
                lastModified: "2026-09-09T21:06:00.000Z",
            },
            {
                service: "kTCCServiceAppleEvents",
                client: "com.genesiscz.genesistools",
                clientType: 0,
                authValue: 2,
                authReason: 3,
                target: "com.apple.systemevents",
                label: "allowed",
                lastModified: "2026-09-07T12:10:00.000Z",
            },
        ],
    };

    it("does not let one unanswered prompt read as a global denial", () => {
        const [grant] = grantsFor("com.genesiscz.genesistools", user, user, [automation]);
        expect(grant.granted).toBe(true);
        expect(grant.label).toBe("1 of 2 targets allowed");
        expect(grant.targets).toEqual([
            { target: "com.apple.Notes", granted: false, label: "prompt timed out (never answered)" },
            { target: "com.apple.systemevents", granted: true, label: "allowed" },
        ]);
    });

    it("stays not asked yet with no rows at all", () => {
        const [grant] = grantsFor("com.other", user, user, [automation]);
        expect(grant).toMatchObject({ granted: false, label: "not asked yet" });
        expect(grant.targets).toBeUndefined();
    });
});

describe("tccAuthLabel with a reason", () => {
    it("names a timed-out prompt instead of calling it denied", () => {
        expect(tccAuthLabel("kTCCServiceAppleEvents", 0, 9)).toBe("prompt timed out (never answered)");
        expect(tccAuthLabel("kTCCServiceAppleEvents", 0, 3)).toBe("denied");
        expect(tccAuthLabel("kTCCServiceAppleEvents", 0)).toBe("denied");
    });
});

describe("build source record", () => {
    it("names the branch, the commit and a dirty tree in one line", () => {
        const line = describeSource({
            sourceRoot: "/work/checkout",
            sourceBranch: "feat/x",
            sourceCommit: "1a2b3c4d5e6f7a8b9c0d",
            sourceDirty: true,
        });

        expect(line).toBe("feat/x @ 1a2b3c4d5e6f+dirty (/work/checkout)");
        expect(describeSource({ sourceRoot: "/r", sourceBranch: "main", sourceCommit: "abcdef0123456789" })).toBe(
            "main @ abcdef012345 (/r)"
        );
    });

    it("answers undefined for a build that predates the record", () => {
        expect(describeSource(undefined)).toBeUndefined();
        expect(describeSource({ sourceRoot: "/r" })).toBeUndefined();
    });

    it("reads this checkout's commit, and nothing for a folder outside git", async () => {
        const info = await readSourceInfo();
        expect(info.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
        expect(info.sourceRoot).toBeTruthy();
        expect(await readSourceInfo(mkdtempSync(join(tmpdir(), "no-git-")))).toEqual({});
    });

    it("an uncommitted edit in GenesisKit alone marks the build dirty; one outside the build inputs does not", async () => {
        const repo = realpathSync(mkdtempSync(join(tmpdir(), "app-source-")));
        const app = join(repo, "src/macos/GenesisTools");
        const kit = join(repo, "src/macos/GenesisKit");
        const git = (...args: string[]) =>
            spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
                cwd: repo,
                env: process.env,
            });

        mkdirSync(join(app, "Sources"), { recursive: true });
        mkdirSync(join(kit, "Sources"), { recursive: true });
        writeFileSync(join(app, "Package.swift"), "// app\n");
        writeFileSync(join(kit, "Sources/Kit.swift"), "let a = 1\n");
        writeFileSync(join(repo, "README.md"), "x\n");
        git("init", "-q", "-b", "main");
        git("add", ".");
        git("commit", "-q", "-m", "base");

        writeFileSync(join(repo, "README.md"), "changed\n");
        expect(await readSourceInfo(app)).toMatchObject({ sourceRoot: repo, sourceBranch: "main", sourceDirty: false });

        writeFileSync(join(kit, "Sources/Kit.swift"), "let a = 2\n");
        expect((await readSourceInfo(app)).sourceDirty).toBe(true);

        git("checkout", "--", ".");
        git("mv", join(kit, "Sources/Kit.swift"), join(repo, "Kit.swift"));
        expect((await readSourceInfo(app)).sourceDirty).toBe(true);

        // A wholly untracked package: `git status -unormal` would show only `src/macos/GenesisKit/`.
        git("reset", "-q", "--hard");
        git("rm", "-r", "-q", "--cached", "src/macos/GenesisKit");
        git("commit", "-q", "-m", "kit untracked");
        expect((await readSourceInfo(app)).sourceDirty).toBe(true);
    });
});

describe("staleRegistrations", () => {
    const block = (path: string, id: string, extra = "") =>
        `bundle id:                  GenesisTools (0x19e08)\n${extra}path:                       ${path} (0x1f4d8)\nname:                       GenesisTools\nidentifier:                 ${id}\nversion:                    1.0\n`;
    const dump = [
        block(
            "/apps/old/retired.noindex/1790969791633/GenesisTools.app",
            "com.example.tools",
            "Bundle node not found on disk: fnfErr\n"
        ),
        block("/apps/GenesisTools.app", "com.example.tools"),
        block("/apps/Other.app", "com.example.other"),
        block("/apps/old/retired.noindex/1791133057805/GenesisTools.app", "com.example.tools"),
    ].join("\n--------------------------------------------------------------------------------\n");

    it("lists every record of the bundle id except the installed path, missing bundles included", () => {
        expect(staleRegistrations(dump, "com.example.tools", "/apps/GenesisTools.app")).toEqual([
            "/apps/old/retired.noindex/1790969791633/GenesisTools.app",
            "/apps/old/retired.noindex/1791133057805/GenesisTools.app",
        ]);
    });

    it("keeps the installed record and other apps", () => {
        expect(
            staleRegistrations(
                block("/apps/GenesisTools.app", "com.example.tools"),
                "com.example.tools",
                "/apps/GenesisTools.app"
            )
        ).toEqual([]);
        expect(staleRegistrations(dump, "com.example.other", "/apps/Other.app")).toEqual([]);
    });
});

describe("retired copies", () => {
    it("lists a missing root as empty and an unreadable one as unknown", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-retired-"));
        try {
            mkdirSync(join(dir, "root", "100"), { recursive: true });
            mkdirSync(join(dir, "root", "300"));
            mkdirSync(join(dir, "root", "notes"));
            writeFileSync(join(dir, "file"), "");
            expect(listRetiredStamps(join(dir, "root"))).toEqual(["300", "100"]);
            expect(listRetiredStamps(join(dir, "missing"))).toEqual([]);
            expect(listRetiredStamps(join(dir, "file"))).toBeNull();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("never deletes a copy a running process still executes, nor any when the processes are unknown", () => {
        const inodes: Record<string, number | null> = { "4": 40, "3": 30, "2": 20, "1": 10, "0": null };
        const plan = (running: Set<number> | null) =>
            retiredStampsToDelete({ stamps: ["4", "3", "2", "1", "0"], keep: 2, running, inodeOf: (s) => inodes[s] });
        expect(plan(new Set([10]))).toEqual(["2"]);
        expect(plan(new Set())).toEqual(["2", "1"]);
        expect(plan(null)).toEqual([]);
    });

    it("keeps deleting after one copy fails", () => {
        if (process.getuid?.() === 0) {
            return;
        }

        const root = mkdtempSync(join(tmpdir(), "gt-retired-rm-"));
        const locked = join(root, "2", "inner");
        try {
            mkdirSync(locked, { recursive: true });
            writeFileSync(join(locked, "file"), "");
            mkdirSync(join(root, "1"));
            chmodSync(locked, 0o500);
            expect(deleteRetiredStamps(root, ["2", "1"])).toEqual(["1"]);
            expect(existsSync(join(root, "1"))).toBe(false);
            expect(existsSync(join(root, "2"))).toBe(true);
        } finally {
            chmodSync(locked, 0o700);
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("timedSteps", () => {
    it("times each step until the next one and lists them slowest first", () => {
        let clock = 0;
        const reported: string[] = [];
        const timer = timedSteps(
            (message) => reported.push(message),
            () => clock
        );
        timer.step("swift build -c release");
        clock = 58_700;
        timer.step("codesign");
        clock = 60_700;
        timer.step("install bundle");
        clock = 61_000;

        expect(reported).toEqual(["swift build -c release", "codesign", "install bundle"]);
        expect(timer.summary()).toBe("build 61.0s: swift build -c release 58.7s, codesign 2.0s, install bundle 0.3s");
    });
});

describe("Local Network answers", () => {
    const retiredBinary =
        "/Users/example/.genesis-tools/app/retired.noindex/1/GenesisTools.app/Contents/MacOS/GenesisTools";
    const rules = parseLocalNetworkRules(
        `{"readable":true,"rules":[{"allowed":true},{"allowed":true,"path":"${retiredBinary}"},{"allowed":false,"path":"/other"}]}\n`
    );

    it("reads the rules face and answers per executable path", () => {
        expect(rules?.rules).toEqual([
            { allowed: true, path: undefined },
            { allowed: true, path: retiredBinary },
            { allowed: false, path: "/other" },
        ]);
        expect(localNetworkAnswer(rules)).toBe("allowed");
        expect(localNetworkAnswer(rules, retiredBinary)).toBe("allowed");
        expect(localNetworkAnswer(rules, "/other")).toBe("denied");
        expect(localNetworkAnswer(rules, "/never/asked")).toBe("asks");
    });

    it("knows nothing when the store or the face output could not be read", () => {
        expect(localNetworkAnswer(parseLocalNetworkRules(`{"readable":false,"rules":[]}`))).toBe("unknown");
        expect(parseLocalNetworkRules("GenesisTools: unknown face")).toBeNull();
        expect(parseLocalNetworkRules(`{"rules":[]}`)).toBeNull();
        expect(localNetworkAnswer(null)).toBe("unknown");
    });

    it("reads the prompting pid and build from nehelper's log", () => {
        const log = [
            "Timestamp               Ty Process[PID:TID]",
            "2026-10-21 22:16:06.926 I  nehelper[419:2a66e2b] [com.apple.networkextension:] Found new path /Users/x/.genesis-tools/app/retired.noindex/1792613086315/GenesisTools.app/Contents/MacOS/GenesisTools for PID 97417, allowing a new prompt",
            "2026-10-21 22:16:06.930 I  nehelper[419:2a66e2b] [com.apple.networkextension:] Local network preference not yet set, prompting for GenesisTools (com.genesiscz.genesistools)",
            "2026-10-21 22:17:01.100 I  nehelper[419:2a66e2b] [com.apple.networkextension:] Found new path /Applications/Other.app/Contents/MacOS/Other for PID 51200, allowing a new prompt",
        ].join("\n");
        const [prompt, ...rest] = parseLocalNetworkPrompts(log);
        expect(rest).toEqual([]);
        expect(prompt).toEqual({
            at: "2026-10-21 22:16:06",
            pid: 97417,
            executable:
                "/Users/x/.genesis-tools/app/retired.noindex/1792613086315/GenesisTools.app/Contents/MacOS/GenesisTools",
        });
        expect(retiredAtOf(prompt.executable)?.getTime()).toBe(1792613086315);
        expect(retiredAtOf("/Users/x/Applications/GenesisTools.app/Contents/MacOS/GenesisTools")).toBeNull();
        expect(withoutPreloads("gt-cc --preload /a.ts --preload /b.ts --resume abc")).toBe("gt-cc --resume abc");
    });

    it("tells a failed log show from a quiet one", () => {
        const bytes = (text: string) => new TextEncoder().encode(text);
        const failed = { since: "2x", exitCode: 64, stdout: bytes(""), stderr: bytes("log: invalid duration") };
        expect(promptsFromLogShow(failed)).toBeNull();
        expect(promptsFromLogShow({ ...failed, exitCode: null })).toBeNull();
        expect(
            promptsFromLogShow({ since: "5m", exitCode: 0, stdout: bytes("Timestamp\n"), stderr: bytes("") })
        ).toEqual([]);
    });

    it("reads no process table when no prompt names a pid", () => {
        const list = spyOn(processes, "listProcesses").mockImplementation(() => {
            throw new Error("the process table was read");
        });
        try {
            expect(describePromptProcesses("/x/GenesisTools", []).size).toBe(0);
            expect(() => describePromptProcesses("/x/GenesisTools", [1])).toThrow("the process table was read");
        } finally {
            list.mockRestore();
        }
    });
});

describe("old builds still running", () => {
    const launcher = "/Users/example/Applications/GenesisTools.app/Contents/MacOS/GenesisTools";
    const ps = [
        `  101 Mon Oct  5 09:03:04 2026     ${launcher} --link-relay`,
        `  202 Mon Oct 12 19:06:23 2026     ${launcher} /Users/example/.genesis-tools/bin/gt-claude --preload x.ts run work`,
        `  303 Mon Oct 12 20:41:21 2026     ${launcher}`,
        `  404 Mon Oct 12 20:50:00 2026     /usr/bin/ssh-agent -l`,
        `  505 Mon Oct 12 20:55:00 2026     ${launcher}-helper --hub`,
    ].join("\n");

    const PS_LINE = /^\s*(\d+)\s+(\w{3} \w{3}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$/;

    /** The GenesisTools processes in `ps -Ao pid=,lstart=,args=`, as the live listing yields them. */
    function genesisAppProcesses(psStdout: string, launcherPath: string): AppProcess[] {
        return psStdout.split("\n").flatMap((line): AppProcess[] => {
            const match = PS_LINE.exec(line);

            if (!match || (match[3] !== launcherPath && !match[3].startsWith(`${launcherPath} `))) {
                return [];
            }

            const rest = match[3].slice(launcherPath.length).trim();
            const [program, ...args] = rest.split(" ");
            const command = !program
                ? "(window)"
                : program.startsWith("-")
                  ? rest
                  : [basename(program), ...args].join(" ");
            return [{ pid: Number(match[1]), started: new Date(match[2]), command }];
        });
    }

    it("groups the processes per retired build and answers for that build's path", () => {
        const builds = groupOldBuilds({
            processes: genesisAppProcesses(ps, launcher),
            inodesByPid: new Map([
                [101, new Set([11])],
                [202, new Set([11])],
                [303, new Set([33])],
            ]),
            retired: [
                { bundle: "/r/2/GenesisTools.app", binary: "/r/2/bin", retiredAt: new Date(2_000), inode: 22 },
                { bundle: "/r/1/GenesisTools.app", binary: retiredBinaryFor(1), retiredAt: new Date(1_000), inode: 11 },
            ],
            rules: parseLocalNetworkRules(`{"readable":true,"rules":[{"allowed":true}]}`),
        });
        expect(builds.map((b) => [b.bundle, b.processes.map((p) => p.pid), b.localNetwork])).toEqual([
            ["/r/1/GenesisTools.app", [101, 202], "asks"],
        ]);
    });

    function retiredBinaryFor(ms: number): string {
        return `/r/${ms}/GenesisTools.app/Contents/MacOS/GenesisTools`;
    }
});

describe("permission kinds", () => {
    it("lists exactly the raw values of GenesisKit's PermissionKind", async () => {
        const source = await Bun.file(
            join(import.meta.dir, "../../GenesisKit/Sources/GenesisKitBase/Permissions/PermissionKind.swift")
        ).text();
        const body = source.slice(source.indexOf("public enum PermissionKind"), source.indexOf("public var id"));
        const swiftKinds = [...body.matchAll(/^\s+case (\w+)(?: = "([\w-]+)")?$/gm)].map((m) => m[2] ?? m[1]);
        expect(swiftKinds).toEqual([...PERMISSION_KINDS]);
        expect(isPermissionKind("local-network")).toBe(true);
        expect(isPermissionKind("lan")).toBe(false);
    });

    it("reads the status face's wire values", () => {
        expect(permissionStatusLabel("granted\n")).toBe("granted");
        expect(permissionStatusLabel("notDetermined")).toBe("not asked yet");
        expect(permissionStatusLabel("partial:Add Only")).toBe("Add Only");
        expect(permissionStatusLabel("")).toBe("no answer");
    });
});

describe("app parts", () => {
    it("keeps the installed parts and adds the requested ones (D15 a)", () => {
        expect(partsForBuild({ installed: [] })).toEqual([]);
        expect(partsForBuild({ installed: [], add: ["markdown"] })).toEqual(["markdown"]);
        expect(partsForBuild({ installed: ["markdown"], add: ["markdown"] })).toEqual(["markdown"]);
        expect(partsForBuild({ installed: ["hub"], exactly: [] })).toEqual([]);
    });

    it("builds the feature settings window with every part that has pages in it, and no part needs another", () => {
        expect(partsForBuild({ installed: [], add: ["clicky"] })).toEqual(["clicky", "features"]);
        expect(partsForBuild({ installed: ["markdown"], exactly: ["clicky"] })).toEqual(["clicky", "features"]);
        expect(partsForBuild({ installed: ["markdown"], add: ["hub"] })).toEqual(["features", "hub", "markdown"]);
        // A manifest written by a build from before the features part: its next build adds the window.
        expect(partsForBuild({ installed: ["widget"] })).toEqual(["features", "widget"]);
    });

    it("reads a manifest from before parts existed as a full build, and no manifest as nothing", () => {
        expect(installedParts(undefined)).toEqual([]);
        expect(installedParts({})).toEqual([...ALL_PART_IDS].sort());
        expect(installedParts({ parts: [] })).toEqual([]);
        expect(installedParts({ parts: ["markdown", "hub"] })).toEqual(["hub", "markdown"]);
    });

    it("gives each parts set its own scratch folder, and the full set the old one", () => {
        expect(scratchName(ALL_PART_IDS)).toBe("opt");
        expect(scratchName([])).toBe("opt-host");
        expect(scratchName(["markdown", "hub"])).toBe("opt-hub-markdown");
    });

    it("parses --parts and --add-part, and refuses an unknown part", () => {
        expect(parsePartsFlag("host")).toEqual([]);
        expect(parsePartsFlag("all")).toEqual([...ALL_PART_IDS].sort());
        expect(parsePartsFlag(" hub, markdown ,hub")).toEqual(["hub", "markdown"]);
        expect(() => parsePartsFlag("hub,nope")).toThrow("Unknown app part nope");
        expect(() => parsePartsFlag("all,nope")).toThrow("Unknown app part nope");
        // A manifest from a newer checkout may name a part this one does not know.
        expect(installedParts({ parts: ["hub", "flow", " "] })).toEqual(["hub"]);
        expect(partsEnvValue(["markdown", "hub"])).toBe("hub,markdown");
    });

    it("runs a part's bundle steps only when the part is built", () => {
        expect([...bundleStepsFor([])]).toEqual([]);
        expect(bundleStepsFor(["hub"]).has("diff-viewer")).toBe(true);
        expect(bundleStepsFor(["hub"]).has("clicky-library")).toBe(false);
        expect(bundleStepsFor(["clicky"]).has("clicky-library")).toBe(true);
        expect(partForFace("--review")).toBe("hub");
        expect(partForFace("--rpc")).toBeUndefined();
    });
});

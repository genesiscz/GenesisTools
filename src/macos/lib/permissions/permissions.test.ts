import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skip } from "@genesiscz/utils/test/skip";
import {
    describeSource,
    parseCodesignInfo,
    pickCodesignIdentity,
    readSourceInfo,
    staleAppFacePids,
    staleRegistrations,
    stampInfoPlist,
    timedSteps,
} from "./app";
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

        expect(staleAppFacePids(stdout, launcher)).toEqual(["111", "222", "333", "666"]);
    });

    it("kills a link router that outlived its link, but not a launcher whose program takes a URL", () => {
        const stdout = [
            `  111 ${launcher} https://example.com/a%20b`,
            `  222 ${launcher} http://example.com/`,
            `  333 ${launcher} /opt/homebrew/bin/bun tools open https://example.com/`,
            `  444 ${launcher} genesis-tools://hub?mode=prs`,
        ].join("\n");

        expect(staleAppFacePids(stdout, launcher)).toEqual(["111", "222"]);
    });

    it("ignores unrelated processes and empty listings", () => {
        expect(staleAppFacePids("", launcher)).toEqual([]);
        expect(staleAppFacePids("  1 /sbin/launchd", launcher)).toEqual([]);
    });

    it("never takes a sibling binary whose name only starts with the launcher's", () => {
        const stdout = [`  777 ${launcher}-helper`, `  888 ${launcher}-helper --rpc`, `  999 ${launcher} --rpc`].join(
            "\n"
        );

        expect(staleAppFacePids(stdout, launcher)).toEqual(["999"]);
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

import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCodesignInfo, pickCodesignIdentity, stampInfoPlist } from "./app";
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

describe("launchdJobsOutsideApp", () => {
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

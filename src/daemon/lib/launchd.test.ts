import { describe, expect, test } from "bun:test";
import { generatePlist } from "./launchd";

describe("launchd plist log paths", () => {
    test("StandardOutPath and StandardErrorPath point at the same file", () => {
        const plist = generatePlist();
        const stdoutMatch = plist.match(/<key>StandardOutPath<\/key><string>([^<]+)<\/string>/);
        const stderrMatch = plist.match(/<key>StandardErrorPath<\/key><string>([^<]+)<\/string>/);

        expect(stdoutMatch?.[1]).toBeDefined();
        expect(stderrMatch?.[1]).toBeDefined();
        expect(stdoutMatch?.[1]).toBe(stderrMatch?.[1]);
        expect(stdoutMatch?.[1]).toContain("daemon-stderr.log");
    });

    test("the job runs at Standard process type; only low-priority tasks ask for background QoS", () => {
        expect(generatePlist()).toContain("<key>ProcessType</key><string>Standard</string>");
        expect(generatePlist()).not.toContain("<string>Background</string>");
    });
});

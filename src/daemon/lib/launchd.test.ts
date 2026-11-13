import { describe, expect, test } from "bun:test";
import { generatePlist } from "./launchd";

function plistString(plist: string, key: string): string | undefined {
    return plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))?.[1];
}

describe("daemon launchd plist", () => {
    test("StandardOutPath and StandardErrorPath point at the same file", () => {
        const plist = generatePlist();

        expect(plistString(plist, "StandardOutPath")).toBeDefined();
        expect(plistString(plist, "StandardOutPath")).toBe(plistString(plist, "StandardErrorPath"));
        expect(plistString(plist, "StandardOutPath")).toContain("daemon-stderr.log");
    });

    test("the job runs at Standard process type; only low-priority tasks ask for background QoS", () => {
        expect(plistString(generatePlist(), "ProcessType")).toBe("Standard");
        expect(generatePlist()).not.toContain("<string>Background</string>");
    });
});

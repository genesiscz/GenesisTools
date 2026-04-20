import { describe, expect, it } from "bun:test";
import { archivedLogCommand, buildSystemCacheFinding } from "@app/doctor/analyzers/system-caches";

describe("buildSystemCacheFinding", () => {
    it("blocks blacklisted cache paths and emits no actions", () => {
        const finding = buildSystemCacheFinding({
            name: "JetBrains",
            path: "/Users/me/Library/Caches/JetBrains",
            displayPath: "~/Library/Caches/JetBrains",
            bytes: 100 * 1024 * 1024,
        });

        expect(finding.severity).toBe("blocked");
        expect(finding.actions).toHaveLength(0);
        expect(finding.blacklistReason).toContain("JetBrains");
    });

    it("allows generic caches with a cautious delete action", () => {
        const finding = buildSystemCacheFinding({
            name: "com.example.cache",
            path: "/Users/me/Library/Caches/com.example.cache",
            displayPath: "~/Library/Caches/com.example.cache",
            bytes: 80 * 1024 * 1024,
        });

        expect(finding.severity).toBe("cautious");
        expect(finding.reclaimableBytes).toBe(80 * 1024 * 1024);
        expect(finding.actions[0]?.id).toBe("delete-cache");
    });
});

describe("archivedLogCommand", () => {
    it("uses an explicit sudo command with shell-quoted paths", () => {
        const command = archivedLogCommand(["/var/log/app one.log.gz", "/var/log/install.log.0.bz2"]);

        expect(command).toContain("# Execute this");
        expect(command).toContain("sudo /bin/rm --");
        expect(command).toContain("'/var/log/app one.log.gz'");
        expect(command).toContain("'/var/log/install.log.0.bz2'");
    });
});

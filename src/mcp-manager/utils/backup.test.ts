import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { BackupManager } from "./backup.ts";

describe("BackupManager.createBackup", () => {
    test("a backup of a world-readable config is still 0600", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-backup-"));
        env.testing.set("GENESIS_TOOLS_HOME", home);

        try {
            const configPath = join(home, "loose-config.json");
            // The shape that makes this matter: a config carrying the gateway bearer
            // token, left group/other-readable by an external tool or by a write whose
            // 0600 tighten had not run yet. copyFile PRESERVES that mode.
            writeFileSync(configPath, '{"mcpServers":{"r":{"headers":{"X-Genesis-Mcp-Gateway":"secret"}}}}', {
                mode: 0o644,
            });
            // The `mode` option above is masked by the process umask at creation time
            // (POSIX open(2) semantics), so under a restrictive umask (e.g. 0o077) the
            // file would land at 0600 and this setup would silently stop reproducing the
            // world-readable case the test exists for. chmodSync applies the mode
            // unconditionally, after the fact.
            chmodSync(configPath, 0o644);
            expect(statSync(configPath).mode & 0o077).not.toBe(0);

            const backupPath = await new BackupManager().createBackup(configPath, "claude");

            expect(backupPath).not.toBe("");
            expect(statSync(backupPath).mode & 0o777).toBe(0o600);
        } finally {
            env.testing.unset("GENESIS_TOOLS_HOME");
        }
    });

    test("a missing config produces no backup rather than an error", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-backup-"));
        env.testing.set("GENESIS_TOOLS_HOME", home);

        try {
            expect(await new BackupManager().createBackup(join(home, "nope.json"), "claude")).toBe("");
        } finally {
            env.testing.unset("GENESIS_TOOLS_HOME");
        }
    });

    test("never leaves an intermediate copy-then-chmod window on the backup file", () => {
        const source = readFileSync(new URL("./backup.ts", import.meta.url), "utf-8");
        const bodyStart = source.indexOf("async createBackup(");
        const bodyEnd = source.indexOf("/**", bodyStart);
        const body = source.slice(bodyStart, bodyEnd);

        // copyFile() creates the destination carrying the SOURCE file's mode (verified: Node
        // preserves it regardless of umask), and the backup directory itself lands
        // world-traversable under this machine's default umask (verified: ~/.mcp-manager/backups
        // is 0755). A copyFile()-then-chmod(0o600) shape therefore leaves the backup briefly as
        // readable as whatever the source config's mode happened to be. Writing the backup with
        // its final restrictive mode from the very first write closes that window entirely.
        expect(body).not.toContain("copyFile(");
    });
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { NOTIFICATION_LEDGER_MAX_BYTES, notificationLedgerPath, recordNotification } from "./ledger";

describe("notification ledger", () => {
    const saved = process.env.GENESIS_TOOLS_HOME;

    beforeEach(() => {
        process.env.GENESIS_TOOLS_HOME = mkdtempSync(join(tmpdir(), "ledger-"));
    });

    afterEach(() => {
        process.env.GENESIS_TOOLS_HOME = saved;
    });

    it("appends one JSON line per notification with the writer and time", () => {
        recordNotification({ source: "hub", channel: "macos", outcome: "posted", title: "Merged", body: "#561" });
        recordNotification({ source: "hub", channel: "telegram", outcome: "failed", title: "Merged" });
        const lines = readFileSync(notificationLedgerPath(), "utf8")
            .trim()
            .split("\n")
            .map((l) => SafeJSON.parse(l));
        expect(lines).toHaveLength(2);
        expect(lines[0]).toMatchObject({ source: "hub", channel: "macos", outcome: "posted", body: "#561" });
        expect(lines[1].writer.app).toBe("tools");
        expect(Number.isNaN(Date.parse(lines[0].at))).toBe(false);
    });

    it("moves a full file aside before writing", () => {
        recordNotification({ source: "x", channel: "macos", outcome: "posted" });
        writeFileSync(notificationLedgerPath(), "x".repeat(NOTIFICATION_LEDGER_MAX_BYTES + 1));
        recordNotification({ source: "y", channel: "macos", outcome: "posted" });
        expect(readFileSync(notificationLedgerPath(), "utf8").trim().split("\n")).toHaveLength(1);
        expect(readFileSync(`${notificationLedgerPath()}.1`, "utf8").length).toBeGreaterThan(
            NOTIFICATION_LEDGER_MAX_BYTES
        );
    });
});

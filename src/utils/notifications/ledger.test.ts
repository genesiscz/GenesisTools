import { dlopen, FFIType } from "bun:ffi";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import type { notificationsConfig } from "./config";
import { unconfiguredChannel } from "./dispatch";
import { NOTIFICATION_LEDGER_MAX_BYTES, notificationLedgerPath, recordNotification } from "./ledger";

describe("notification ledger", () => {
    const saved = process.env.GENESIS_TOOLS_HOME;

    beforeEach(() => {
        process.env.GENESIS_TOOLS_HOME = mkdtempSync(join(tmpdir(), "ledger-"));
    });

    afterEach(() => {
        process.env.GENESIS_TOOLS_HOME = saved;
    });

    it("appends one JSON line per notification with the writer and time", async () => {
        await recordNotification({ source: "hub", channel: "macos", outcome: "posted", title: "Merged", body: "#561" });
        await recordNotification({ source: "hub", channel: "telegram", outcome: "failed", title: "Merged" });
        const lines = readFileSync(notificationLedgerPath(), "utf8")
            .trim()
            .split("\n")
            .map((l) => SafeJSON.parse(l));
        expect(lines).toHaveLength(2);
        expect(lines[0]).toMatchObject({ source: "hub", channel: "macos", outcome: "posted", body: "#561" });
        expect(lines[1].writer.app).toBe("tools");
        expect(Number.isNaN(Date.parse(lines[0].at))).toBe(false);
    });

    it("an enabled channel without its token, chat or URL counts as unconfigured, so its line says suppressed", () => {
        const channels = {
            system: { enabled: false },
            telegram: { enabled: true },
            webhook: { enabled: true },
            say: { enabled: false },
        } as Awaited<ReturnType<typeof notificationsConfig.getChannels>>;
        expect(unconfiguredChannel("telegram", channels)).toBe(true);
        expect(unconfiguredChannel("webhook", channels)).toBe(true);
        expect(unconfiguredChannel("system", channels)).toBe(false);
        const ready = {
            ...channels,
            telegram: { enabled: true, botToken: "token", chatId: "chat" },
            webhook: { enabled: true, url: "http://127.0.0.1:9/hook" },
        } as Awaited<ReturnType<typeof notificationsConfig.getChannels>>;
        expect(unconfiguredChannel("telegram", ready)).toBe(false);
        expect(unconfiguredChannel("webhook", ready)).toBe(false);
    });

    it.if(process.platform === "darwin")(
        "serializes independent writers and rotation with Swift's flock protocol",
        async () => {
            await recordNotification({ source: "seed", channel: "macos", outcome: "posted" });
            const file = notificationLedgerPath();
            const full = "x".repeat(NOTIFICATION_LEDGER_MAX_BYTES + 1);
            writeFileSync(file, full);
            const library = dlopen("/usr/lib/libSystem.B.dylib", {
                flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
            });
            const fd = openSync(`${file}.lock`, "a");
            expect(library.symbols.flock(fd, 2 | 4)).toBe(0);
            const writers = Array.from({ length: 4 }, (_, i) =>
                Bun.spawn(
                    [
                        process.execPath,
                        "-e",
                        `
            import { recordNotification } from ${SafeJSON.stringify(join(import.meta.dir, "ledger.ts"))};
            const writing = recordNotification({ source: "writer-${i}", channel: "macos", outcome: "posted" });
            process.stdout.write("ready\\n");
            await writing;
        `,
                    ],
                    { env: env.getProcessEnv(), stdout: "pipe", stderr: "pipe" }
                )
            );
            try {
                await Promise.all(
                    writers.map(async (writer) => {
                        const reader = writer.stdout.getReader();
                        const ready = await reader.read();
                        expect(new TextDecoder().decode(ready.value)).toContain("ready");
                        reader.releaseLock();
                    })
                );
                expect(readFileSync(file, "utf8")).toBe(full);
            } finally {
                library.symbols.flock(fd, 8);
                closeSync(fd);
                library.close();
            }
            const results = await Promise.all(
                writers.map(async (writer) => ({
                    code: await writer.exited,
                    stderr: await new Response(writer.stderr).text(),
                }))
            );
            expect(results.every((r) => r.code === 0)).toBe(true);
            const lines = readFileSync(file, "utf8")
                .trim()
                .split("\n")
                .map((line) => SafeJSON.parse(line));
            expect(lines.map((line) => line.source).sort()).toEqual(["writer-0", "writer-1", "writer-2", "writer-3"]);
            expect(readFileSync(`${file}.1`, "utf8")).toBe(full);
        }
    );

    it("moves a full file aside before writing", async () => {
        await recordNotification({ source: "x", channel: "macos", outcome: "posted" });
        writeFileSync(notificationLedgerPath(), "x".repeat(NOTIFICATION_LEDGER_MAX_BYTES + 1));
        await recordNotification({ source: "y", channel: "macos", outcome: "posted" });
        expect(readFileSync(notificationLedgerPath(), "utf8").trim().split("\n")).toHaveLength(1);
        expect(readFileSync(`${notificationLedgerPath()}.1`, "utf8").length).toBeGreaterThan(
            NOTIFICATION_LEDGER_MAX_BYTES
        );
    });
});

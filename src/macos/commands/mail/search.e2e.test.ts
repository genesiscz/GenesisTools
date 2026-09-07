import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";

// These tests spawn `tools` against the REAL mail index (read-only), so the sandbox home the test
// preload sets must not leak into the child: with it, the index is "missing" and every search silently
// takes the Spotlight fallback. Gate: RUN_E2E=1 RUN_MAIL_INFRA=1.
const INDEX_DB = join(homedir(), ".genesis-tools/indexer/macos-mail/index.db");
const TOOLS_BIN = join(import.meta.dir, "../../../../tools");
const CAN_RUN = process.platform === "darwin" && existsSync(INDEX_DB) && existsSync(TOOLS_BIN);
const { GENESIS_TOOLS_HOME: _sandboxHome, ...REAL_HOME_ENV } = process.env;

describe("tools macos mail search --mode auto (e2e)", () => {
    it.skipIf(!CAN_RUN)(
        "loads sqlite-vec and does not error",
        async () => {
            const proc = Bun.spawn(
                [TOOLS_BIN, "macos", "mail", "search", "invoice", "--mode", "auto", "--limit", "1", "--format", "json"],
                { stdout: "pipe", stderr: "pipe", env: REAL_HOME_ENV }
            );
            const stdout = await new Response(proc.stdout).text();
            const stderr = await new Response(proc.stderr).text();
            const exitCode = await proc.exited;

            expect(stderr).not.toContain("sqlite-vec extension failed to load");
            expect(exitCode).toBe(0);
            expect(() => SafeJSON.parse(stdout.trim() || "[]", { strict: true })).not.toThrow();
        },
        60_000
    );

    it.skipIf(!CAN_RUN)(
        "auto mode survives --limit 500 over a month window (sqlite-vec k cap)",
        async () => {
            const proc = Bun.spawn(
                [
                    TOOLS_BIN,
                    "macos",
                    "mail",
                    "search",
                    "faktura",
                    "--mode",
                    "auto",
                    "--from",
                    "2026-03-01",
                    "--to",
                    "2026-04-01",
                    "--limit",
                    "500",
                    "--format",
                    "json",
                ],
                { stdout: "pipe", stderr: "pipe", env: REAL_HOME_ENV }
            );
            const stdout = await new Response(proc.stdout).text();
            const stderr = await new Response(proc.stderr).text();
            const exitCode = await proc.exited;

            expect(stderr).not.toContain("k value in knn query too large");
            expect(stderr).toContain("vector candidates capped at 4096");
            expect(exitCode).toBe(0);
            expect(() => SafeJSON.parse(stdout.trim() || "[]", { strict: true })).not.toThrow();
        },
        60_000
    );

    it.skipIf(!CAN_RUN)(
        "JSON output has typed date/relevance/attachments",
        async () => {
            const proc = Bun.spawn(
                [
                    TOOLS_BIN,
                    "macos",
                    "mail",
                    "search",
                    "invoice",
                    "--mode",
                    "auto",
                    "--limit",
                    "3",
                    "--columns",
                    "id,date,relevance,attachments,subject",
                    "--format",
                    "json",
                ],
                { stdout: "pipe", stderr: "pipe", env: REAL_HOME_ENV }
            );
            const stdout = await new Response(proc.stdout).text();
            const exitCode = await proc.exited;
            const rows = SafeJSON.parse(stdout.trim() || "[]", { strict: true }) as Array<Record<string, unknown>>;

            expect(exitCode).toBe(0);
            expect(rows.length).toBeGreaterThan(0);

            for (const row of rows) {
                expect(typeof row.date).toBe("string");
                expect(row.date as string).toMatch(/^\d{4}-\d{2}-\d{2}T/);
                expect(row.relevance === null || typeof row.relevance === "number").toBe(true);
                expect(Array.isArray(row.attachments)).toBe(true);
            }
        },
        60_000
    );

    it.skipIf(!CAN_RUN)(
        "search-download writes results without a prior search call",
        async () => {
            const { existsSync, mkdtempSync } = await import("node:fs");
            const { tmpdir } = await import("node:os");
            const outDir = mkdtempSync(join(tmpdir(), "sd-e2e-"));
            const proc = Bun.spawn(
                [
                    TOOLS_BIN,
                    "macos",
                    "mail",
                    "search-download",
                    "invoice",
                    "--output-dir",
                    outDir,
                    "--limit",
                    "3",
                    "--yes",
                ],
                { stdout: "pipe", stderr: "pipe", env: REAL_HOME_ENV }
            );
            const stderr = await new Response(proc.stderr).text();
            const exitCode = await proc.exited;

            expect(stderr).not.toContain("No search results found");
            expect(exitCode).toBe(0);
            expect(existsSync(join(outDir, "emails"))).toBe(true);
        },
        90_000
    );

    it.skipIf(!CAN_RUN)(
        "show --json is not truncated through a slow pipe consumer",
        async () => {
            const idsProc = Bun.spawn(
                [
                    TOOLS_BIN,
                    "macos",
                    "mail",
                    "search",
                    "the",
                    "--mode",
                    "fulltext",
                    "--limit",
                    "30",
                    "--columns",
                    "id",
                    "--format",
                    "json",
                ],
                { stdout: "pipe", stderr: "pipe", env: REAL_HOME_ENV }
            );
            const idsRaw = await new Response(idsProc.stdout).text();
            await idsProc.exited;
            const ids = (SafeJSON.parse(idsRaw.trim() || "[]", { strict: true }) as Array<{ id: string }>).map((r) =>
                Number(r.id)
            );

            let bigId: number | undefined;
            let fileLen = 0;

            for (const id of ids) {
                const p = Bun.spawn([TOOLS_BIN, "macos", "mail", "show", String(id), "--json"], {
                    stdout: "pipe",
                    stderr: "pipe",
                    env: REAL_HOME_ENV,
                });
                const text = await new Response(p.stdout).text();
                await p.exited;

                if (text.length > 90_000) {
                    bigId = id;
                    fileLen = text.length;
                    break;
                }
            }

            if (bigId === undefined) {
                return;
            }

            const piped = Bun.spawn(["sh", "-c", `'${TOOLS_BIN}' macos mail show ${bigId} --json | cat`], {
                stdout: "pipe",
                stderr: "pipe",
                env: REAL_HOME_ENV,
            });
            const pipedText = await new Response(piped.stdout).text();
            await piped.exited;

            expect(pipedText.length).toBe(fileLen);
            expect(() => SafeJSON.parse(pipedText, { strict: true })).not.toThrow();
        },
        120_000
    );
});

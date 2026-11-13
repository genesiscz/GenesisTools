import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import {
    appendWorkerCostRows,
    buildWorkerCostRow,
    ledgerTotals,
    readWorkerCostLedger,
    readWorkerCostRows,
    readWorkerCostRowsOf,
    rewriteWorkerCostRows,
    sessionCostSummary,
    WORKER_PRICING_VERSION,
    type WorkerCostRow,
    workerCostLedgerPath,
} from "@genesiscz/utils/worker/spend-ledger";

function turn(options: { backend: "codex" | "grok"; name: string; turn: number; output: number }): WorkerCostRow {
    return buildWorkerCostRow({
        backend: options.backend,
        name: options.name,
        sessionId: null,
        turn: options.turn,
        model: options.backend === "grok" ? "grok-4.7" : "gpt-5.5",
        auth: "subscription",
        account: "work",
        startedAt: new Date("2026-10-13T10:00:00.000Z"),
        endedAt: new Date(`2026-10-13T10:0${options.turn}:00.000Z`),
        toolCalls: 2,
        parts: [
            {
                model: null,
                tokens: { input: 1_000, cacheRead: 500, cacheWrite: 0, output: options.output, reasoning: 0 },
                singleRequest: false,
            },
        ],
        cwd: "/w",
    });
}

async function inTempHome(fn: (home: string) => Promise<void>): Promise<void> {
    const home = mkdtempSync(join(tmpdir(), "spend-ledger-"));
    await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, () => fn(home));
}

describe("worker spend ledger", () => {
    it("appends rows once per turn key and reads them back, per backend too", async () => {
        await inTempHome(async (home) => {
            expect(workerCostLedgerPath().startsWith(home)).toBe(true);
            const a = turn({ backend: "grok", name: "alpha", turn: 1, output: 100 });
            const b = turn({ backend: "codex", name: "beta", turn: 1, output: 200 });

            expect(await appendWorkerCostRows([a, b, a])).toEqual([a, b]);
            expect(await appendWorkerCostRows([a])).toEqual([]);
            expect(readWorkerCostRows()).toEqual([a, b]);
            expect(readWorkerCostRowsOf("codex")).toEqual([b]);
        });
    });

    it("restamps the ledger through a snapshot, keeps a .bak and refuses a stale snapshot", async () => {
        await inTempHome(async () => {
            const a = turn({ backend: "grok", name: "alpha", turn: 1, output: 100 });
            await appendWorkerCostRows([a]);
            const snapshot = readWorkerCostLedger();
            const restamped: WorkerCostRow = { ...a, priced: WORKER_PRICING_VERSION, label: "restamped" };

            await rewriteWorkerCostRows([restamped], snapshot);

            expect(readWorkerCostRows()).toEqual([restamped]);
            expect(existsSync(`${workerCostLedgerPath()}.bak`)).toBe(true);
            expect(readFileSync(`${workerCostLedgerPath()}.bak`, "utf8")).toContain('"name":"alpha"');
            await expect(rewriteWorkerCostRows([a], snapshot)).rejects.toThrow("changed since the reprice began");
        });
    });

    it("totals a session's rows the same way status reports them", async () => {
        await inTempHome(async () => {
            const first = turn({ backend: "grok", name: "alpha", turn: 1, output: 100 });
            const second = turn({ backend: "grok", name: "alpha", turn: 2, output: 300 });
            const other = turn({ backend: "codex", name: "alpha", turn: 1, output: 999 });
            await appendWorkerCostRows([first, second, other]);

            const totals = ledgerTotals([first, second]);
            expect(totals.turns).toBe(2);
            expect(totals.toolCalls).toBe(4);
            expect(totals.durationMs).toBe(3 * 60_000);
            expect(totals.tokens).toMatchObject({ input: 2_000, cacheRead: 1_000, output: 400 });

            const summary = sessionCostSummary({ backend: "grok", name: "alpha" });
            expect(summary?.lastTurn.turn).toBe(2);
            expect(summary?.session).toEqual(totals);
        });
    });
});

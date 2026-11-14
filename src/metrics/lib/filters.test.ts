import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import type { MetricsServiceClient } from "@genesiscz/utils/metrics/service-client";
import { spoolDir } from "@genesiscz/utils/metrics/spool";
import type { MetricEvent } from "@genesiscz/utils/metrics/types";
import { spoolBacklog } from "../commands/catalog";
import { detachedServeCommand } from "../commands/serve";
import { FlagError, parseWhere } from "./filters";
import { importHooksLog } from "./hooks-log";

describe("parseWhere", () => {
    test("a list reads true and false as the single value does, and refuses null", () => {
        expect(parseWhere("dropped=true,false")).toEqual({ dim: "dropped", op: "in", value: [1, 0] });
        expect(parseWhere("tool=Bash,3")).toEqual({ dim: "tool", op: "in", value: ["Bash", 3] });
        expect(() => parseWhere("tool=Bash,null")).toThrow(FlagError);
    });
});

describe("metrics serve --detach", () => {
    test("the detached service gets --no-idle when the start asked for it", () => {
        expect(detachedServeCommand({ idle: false })).toEqual(["metrics", "serve", "--no-idle"]);
        expect(detachedServeCommand({})).toEqual(["metrics", "serve"]);
    });
});

describe("the spool backlog", () => {
    test("leaves out a file the service drained and deleted after the listing, and names any other stat error", () => {
        mkdirSync(spoolDir(), { recursive: true });
        const kept = join(spoolDir(), "fixture-a-2026-11-01.jsonl");
        const drained = join(spoolDir(), "fixture-b-2026-11-01.jsonl");
        writeFileSync(kept, "1234\n");
        writeFileSync(drained, "12\n");
        const gone = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });

        const backlog = spoolBacklog([], (path) => {
            if (path === drained) {
                throw gone;
            }

            return 5;
        });

        expect(backlog.filter((row) => row.path.includes("fixture-"))).toEqual([{ path: kept, bytes: 5, pending: 5 }]);
        expect(() =>
            spoolBacklog([], () => {
                throw Object.assign(new Error("EACCES"), { code: "EACCES" });
            })
        ).toThrow("cannot read the size of the spool file");
    });
});

describe("importHooksLog", () => {
    test("skips a line longer than a chunk as bad and goes on with the lines after it", async () => {
        const dir = realpathSync(mkdtempSync(join(tmpdir(), "metrics-hooks-log-")));
        const file = join(dir, "hooks.jsonl");
        const line = (event: string, extra: Record<string, unknown> = {}) =>
            SafeJSON.stringify({ chars: 5, event, heads: ["fixture"], ...extra });
        writeFileSync(file, `${line("before")}\n${line("huge", { block: "x".repeat(1_300_000) })}\n${line("after")}\n`);
        const ingested: MetricEvent[][] = [];
        const client = {
            call: async (method: string, params: { events?: MetricEvent[] }) => {
                if (method === "status") {
                    return { spool: { files: [] } };
                }

                ingested.push(params.events ?? []);
                return { accepted: params.events?.length ?? 0, rejected: 0 };
            },
        } as unknown as MetricsServiceClient;

        const summary = await importHooksLog(client, file);

        expect(ingested.flat().map((event) => event.dims?.event)).toEqual(["before", "after"]);
        expect(summary).toMatchObject({ lines: 3, accepted: 2, bad: 1 });
        expect(summary.to).toBe(Bun.file(file).size);
    });
});

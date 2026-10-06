#!/usr/bin/env bun
import { runStdioHttpRelay } from "@app/mcp-manager/lib/gateway/stdio-relay";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";

const requests = Math.max(2, Number.parseInt(process.argv[2] ?? "1000", 10));
const maxInFlight = Math.max(1, Number.parseInt(process.argv[3] ?? "8", 10));
const input = Array.from({ length: requests }, (_, index) =>
    SafeJSON.stringify(
        {
            jsonrpc: "2.0",
            id: index + 1,
            method: index === 0 ? "initialize" : "tools/list",
            params: {},
        },
        { strict: true }
    )
).join("\n");
let fetchCalls = 0;
let activeFetches = 0;
let peakFetches = 0;
let writeCalls = 0;
let activeWrites = 0;
let peakWrites = 0;
const cpuStarted = process.cpuUsage();
const wallStarted = performance.now();

await runStdioHttpRelay({
    url: "http://fixture.invalid/mcp",
    headers: {},
    maxInFlight,
    stdin: (async function* () {
        yield Buffer.from(`${input}\n`, "utf8");
    })(),
    stdout: {
        async write() {
            writeCalls += 1;
            activeWrites += 1;
            peakWrites = Math.max(peakWrites, activeWrites);
            await Promise.resolve();
            activeWrites -= 1;
        },
    },
    fetchImpl: async (_url, init) => {
        fetchCalls += 1;
        activeFetches += 1;
        peakFetches = Math.max(peakFetches, activeFetches);
        await Promise.resolve();
        const request = SafeJSON.parse(String(init?.body), { strict: true }) as { id: number };
        activeFetches -= 1;
        return new Response(`{"jsonrpc":"2.0","id":${request.id},"result":{}}`, {
            headers: { "Content-Type": "application/json" },
        });
    },
});

const cpu = process.cpuUsage(cpuStarted);
out.result({
    requests,
    maxInFlight,
    fetchCalls,
    peakFetches,
    writeCalls,
    peakWrites,
    cpuUs: cpu.user + cpu.system,
    wallMs: Number((performance.now() - wallStarted).toFixed(2)),
});

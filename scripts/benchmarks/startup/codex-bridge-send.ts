#!/usr/bin/env bun
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { appendFeed } from "@app/agents/lib/feed";
import { ensureSessionDir, sessionPaths } from "@app/agents/lib/paths";
import { CliAgentsTransport } from "@app/codex/lib/agents-bridge";
import { env } from "@genesiscz/utils/env";
import { out } from "@genesiscz/utils/logger";

const messages = Math.max(2, Number.parseInt(process.argv[2] ?? "50", 10));
const batches = Math.max(2, Number.parseInt(process.argv[3] ?? "10", 10));
const perBatch = Math.ceil(messages / batches);
const benchmarkHome = mkdtempSync(join(tmpdir(), "gt-codex-bridge-send-"));
env.testing.set("GENESIS_TOOLS_HOME", benchmarkHome);
const entry = resolve(import.meta.dir, "../../../src/agents/index.ts");
const baselineSession = "bridge-baseline";
const candidateSession = "bridge-candidate";

async function seed(session: string): Promise<void> {
    const paths = sessionPaths(session);
    ensureSessionDir(paths);
    await appendFeed(paths, {
        type: "registered",
        agent_name: "lead",
        agent_id: "main_benchmark",
        awaiting_login: false,
        is_main: true,
        role: null,
        meta: {},
    });
    await appendFeed(paths, {
        type: "registered",
        agent_name: "codex_benchmark",
        agent_id: "agt_benchmark",
        awaiting_login: false,
        is_main: false,
        role: null,
        meta: {},
    });
}

await seed(baselineSession);
await seed(candidateSession);
const transport = new CliAgentsTransport();
let baselineParentCpuUs = 0;
let baselineChildCpuUs = 0;
let baselineWallMs = 0;
let baselineSpawns = 0;
let candidateCpuUs = 0;
let candidateWallMs = 0;
let sent = 0;

async function baselineBatch(count: number): Promise<void> {
    const cpuStarted = process.cpuUsage();
    const wallStarted = performance.now();
    for (let index = 0; index < count; index++) {
        const proc = Bun.spawn({
            cmd: [
                process.execPath,
                entry,
                "message",
                "--from",
                "codex_benchmark",
                "--to",
                "lead",
                "--body",
                `baseline ${sent + index}`,
                "--session",
                baselineSession,
            ],
            env: { ...process.env, GENESIS_TOOLS_HOME: benchmarkHome },
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
        });
        baselineSpawns += 1;
        const exitCode = await proc.exited;
        if (exitCode !== 0) {
            throw new Error(`baseline agents message exited ${exitCode}`);
        }
        baselineChildCpuUs += Number(proc.resourceUsage()?.cpuTime.total ?? 0);
    }
    const used = process.cpuUsage(cpuStarted);
    baselineParentCpuUs += used.user + used.system;
    baselineWallMs += performance.now() - wallStarted;
}

async function candidateBatch(count: number): Promise<void> {
    const cpuStarted = process.cpuUsage();
    const wallStarted = performance.now();
    for (let index = 0; index < count; index++) {
        await transport.send({
            from: "codex_benchmark",
            to: "lead",
            body: `candidate ${sent + index}`,
            session: candidateSession,
        });
    }
    const used = process.cpuUsage(cpuStarted);
    candidateCpuUs += used.user + used.system;
    candidateWallMs += performance.now() - wallStarted;
}

for (let batch = 0; batch < batches && sent < messages; batch++) {
    const count = Math.min(perBatch, messages - sent);
    if (batch % 2 === 0) {
        await baselineBatch(count);
        await candidateBatch(count);
    } else {
        await candidateBatch(count);
        await baselineBatch(count);
    }
    sent += count;
}

out.result({
    messages: sent,
    baseline: {
        spawns: baselineSpawns,
        cpuUs: baselineParentCpuUs + baselineChildCpuUs,
        parentCpuUs: baselineParentCpuUs,
        childCpuUs: baselineChildCpuUs,
        wallMs: Number(baselineWallMs.toFixed(2)),
    },
    candidate: {
        spawns: 0,
        cpuUs: candidateCpuUs,
        wallMs: Number(candidateWallMs.toFixed(2)),
    },
});

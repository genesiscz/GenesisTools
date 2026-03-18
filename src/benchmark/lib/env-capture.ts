import { cpus, freemem, loadavg, totalmem } from "node:os";
import type { EnvSnapshot } from "@app/benchmark/types";

export async function captureEnv(): Promise<EnvSnapshot> {
    const cpuInfo = cpus();
    const [load1, load5, load15] = loadavg();

    const env: EnvSnapshot = {
        cpuModel: cpuInfo[0]?.model ?? "unknown",
        cpuCores: cpuInfo.length,
        memoryTotalGB: Math.round((totalmem() / (1024 ** 3)) * 10) / 10,
        memoryFreeGB: Math.round((freemem() / (1024 ** 3)) * 10) / 10,
        loadAvg: [
            Math.round(load1 * 100) / 100,
            Math.round(load5 * 100) / 100,
            Math.round(load15 * 100) / 100,
        ],
    };

    // macOS thermal pressure (best-effort)
    env.thermalPressure = await getThermalPressure();

    // Git info
    env.gitSha = (await run("git", ["rev-parse", "HEAD"])) ?? undefined;
    env.gitBranch = (await run("git", ["branch", "--show-current"])) ?? undefined;

    const diffResult = await run("git", ["diff", "--quiet"]);
    env.gitDirty = diffResult === null;  // git diff --quiet exits 1 if dirty

    return env;
}

export function formatEnvSummary(env: EnvSnapshot): string {
    const parts: string[] = [];

    const cpuShort = env.cpuModel.replace(/\s+/g, " ").replace(/\(R\)|\(TM\)/gi, "").trim();
    parts.push(`CPU: ${cpuShort}`);
    parts.push(`Load: ${env.loadAvg[0]}`);
    parts.push(`Mem: ${env.memoryFreeGB}/${env.memoryTotalGB} GB`);

    if (env.thermalPressure && env.thermalPressure !== "nominal") {
        parts.push(`Thermal: ${env.thermalPressure}`);
    }

    if (env.gitSha) {
        const sha7 = env.gitSha.slice(0, 7);
        const branch = env.gitBranch ?? "detached";
        const dirty = env.gitDirty ? "*" : "";
        parts.push(`Git: ${sha7}${dirty} (${branch})`);
    }

    return parts.join(" | ");
}

async function run(cmd: string, args: string[]): Promise<string | null> {
    try {
        const proc = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
        const exitCode = await proc.exited;

        if (exitCode !== 0) {
            return null;
        }

        return (await new Response(proc.stdout).text()).trim() || null;
    } catch {
        return null;
    }
}

async function getThermalPressure(): Promise<string | undefined> {
    // macOS: check thermal state via sysctl
    const result = await run("sysctl", ["-n", "machdep.xcpm.cpu_thermal_level"]);

    if (result === null) {
        return undefined;
    }

    const level = parseInt(result, 10);

    if (Number.isNaN(level)) {
        return undefined;
    }

    // 0 = nominal, higher = throttled
    if (level === 0) {
        return "nominal";
    }

    if (level <= 33) {
        return "moderate";
    }

    if (level <= 70) {
        return "heavy";
    }

    return "critical";
}

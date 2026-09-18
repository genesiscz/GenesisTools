import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";

export interface ListenDaemonSpec {
    stt: string;
    account?: string;
    wake: string;
    wakeMode: string;
    dryRun?: boolean;
}

export function listenDaemonCommand(spec: ListenDaemonSpec): string {
    const bun = Bun.which("bun") ?? "bun";
    const script = `${import.meta.dir}/../index.ts`;
    const parts = [
        bun,
        "run",
        SafeJSON.stringify(script),
        "listen",
        `--stt ${spec.stt}`,
        `--wake ${SafeJSON.stringify(spec.wake)}`,
        `--wake-mode ${spec.wakeMode}`,
    ];
    if (spec.account) {
        parts.push(`--account ${SafeJSON.stringify(spec.account)}`);
    }
    return parts.join(" ");
}

export function listenDaemonPlan(spec: ListenDaemonSpec) {
    return {
        name: "jev-listen",
        command: listenDaemonCommand(spec),
        every: "1m",
        platform: process.platform,
        logs: `${env.tools.getHome()}/.genesis-tools/logs`,
        dryRun: spec.dryRun ?? process.platform !== "darwin",
        note: process.platform === "darwin" ? "launchd via tools daemon" : "dry-run only on this OS; no launchd",
    };
}

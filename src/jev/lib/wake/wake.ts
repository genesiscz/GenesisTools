import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("jev-wake");

export interface WakeGate {
    enabled: boolean;
    word: string;
    cooldownMs: number;
    listenSeconds: number;
    stt: string;
    pid?: number | null;
    startedAt?: number;
}

export const DEFAULT_WAKE_GATE: WakeGate = {
    enabled: false,
    word: "hey jev",
    cooldownMs: 1500,
    listenSeconds: 12,
    stt: "fixture",
};

export function wakeConfigPath(): string {
    return join(env.tools.getHome(), ".genesis-tools", "jev", "wake.json");
}

export function readWakeGate(): WakeGate {
    const path = wakeConfigPath();
    try {
        const parsed = SafeJSON.parse(readFileSync(path, "utf8"));
        return { ...DEFAULT_WAKE_GATE, ...(typeof parsed === "object" && parsed ? parsed : {}) };
    } catch {
        return { ...DEFAULT_WAKE_GATE };
    }
}

export function writeWakeGate(gate: WakeGate): void {
    const path = wakeConfigPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${SafeJSON.stringify(gate, undefined, 2)}\n`, { mode: 0o600 });
    log.debug({ enabled: gate.enabled, word: gate.word }, "Wake gate written");
}

export function disableWakeGate(): void {
    const current = readWakeGate();
    writeWakeGate({ ...current, enabled: false });
}

export function wakeBlockedByEnv(): boolean {
    return env.getProcessEnv().GENESIS_TOOLS_NO_WAKE === "1";
}

export async function* fixtureWakeEvents(triggers: Array<{ atMs: number; word?: string }>, cooldownMs: number) {
    let last = -Infinity;
    for (const trigger of triggers) {
        if (trigger.atMs - last < cooldownMs) {
            continue;
        }

        last = trigger.atMs;
        yield { kind: "trigger" as const, atMs: trigger.atMs, word: trigger.word };
    }
}

export function removeWakeGateForTests(): void {
    try {
        rmSync(wakeConfigPath());
    } catch (error) {
        log.debug({ error }, "Wake gate file already absent");
    }
}

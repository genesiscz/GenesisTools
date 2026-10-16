import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isJsonObject, readJsonFileForUpdateSync } from "@genesiscz/utils/storage/atomic-file";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";

const { log } = logger.scoped("jev-wake");

export interface WakeGate {
    enabled: boolean;
    /** Comma-separated wake phrases; `listen` reads them when `--wake` is not passed. */
    word: string;
    /** `contains` = deterministic matcher, `jev` = Jev-confirmed wake with a destructive gate. */
    mode?: "contains" | "jev";
    cooldownMs: number;
    listenSeconds: number;
    stt: string;
    /** `tools ai` account id or name for the STT provider. */
    account?: string;
    /** ISO 639-1 codes in priority order for the STT provider, e.g. ["cs", "en"]. */
    languages?: string[];
    pid?: number | null;
    startedAt?: number;
}

export const DEFAULT_WAKE_GATE: WakeGate = {
    enabled: false,
    word: "hey jev,hey jeff",
    mode: "contains",
    cooldownMs: 1500,
    listenSeconds: 12,
    stt: "fixture",
};

export function wakeConfigPath(): string {
    return genesisToolsDir("jev", "wake.json");
}

function isWakeGatePatch(value: unknown): value is Partial<WakeGate> {
    return isJsonObject(value);
}

/** For display and `listen`: a gate file that cannot be read counts as the disabled default. */
export function readWakeGate(): WakeGate {
    const path = wakeConfigPath();
    try {
        const parsed = SafeJSON.parse(readFileSync(path, "utf8"));
        return { ...DEFAULT_WAKE_GATE, ...(typeof parsed === "object" && parsed ? parsed : {}) };
    } catch (err) {
        if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) {
            log.warn({ err, path }, "Wake gate unreadable, treating it as disabled");
        }

        return { ...DEFAULT_WAKE_GATE };
    }
}

/**
 * The gate a write starts from. A file that exists but does not parse is copied aside first
 * (`wake.json.corrupt-<time>`), so enabling or disabling never destroys the only copy of the saved
 * phrases, account and languages. Disabling still works on such a file: it is the kill switch.
 */
export function readWakeGateForUpdate(): WakeGate {
    const existing = readJsonFileForUpdateSync(wakeConfigPath(), { accepts: isWakeGatePatch });

    return existing.state === "ok" ? { ...DEFAULT_WAKE_GATE, ...existing.value } : { ...DEFAULT_WAKE_GATE };
}

export function writeWakeGate(gate: WakeGate): void {
    const path = wakeConfigPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    atomicWriteFileSync(path, `${SafeJSON.stringify(gate, undefined, 2)}\n`, { mode: 0o600 });
    log.debug({ enabled: gate.enabled, word: gate.word }, "Wake gate written");
}

export function disableWakeGate(): void {
    const current = readWakeGateForUpdate();
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

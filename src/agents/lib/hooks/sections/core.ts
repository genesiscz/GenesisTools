import {
    asBoolean,
    asMegabytes,
    boolOr,
    type HookConfigSection,
    legacyMB,
    megabytesOr,
    storedPart,
} from "@genesiscz/utils/agents/hooks/config-section";
import { SafeJSON } from "@genesiscz/utils/json";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import type { CoreHooksConfig, HookDoctorFacts, LogCommandsPolicy } from "../config";

export function defaultLogPath(): string {
    return genesisToolsDir("logs", "agents-hooks.jsonl");
}

const LOG_COMMANDS_POLICIES: readonly LogCommandsPolicy[] = ["shadow", "always", "never"];

function logCommandsOr(value: unknown, fallback: LogCommandsPolicy): LogCommandsPolicy {
    return LOG_COMMANDS_POLICIES.find((policy) => policy === value) ?? fallback;
}

// 🛑 `shadow: true` AND `logCommands: "shadow"` together mean `keepsCommand()` is true out
// of the box, so EVERY Bash command this machine runs through a hook is written verbatim
// to `logPath`. That is the point of shadow mode — the old and new guards cannot be
// compared on real traffic without the command text — but it is a local file holding
// whatever was typed, secrets included. It is capped at `maxLogMB` with one generation
// kept, and it stops accumulating commands as soon as either of these two is changed.
// Setting `logCommands: "never"` keeps shadow mode and drops the command text.
const SHIPPED = { shadow: true, logCommands: "shadow", maxLogMB: 16 } as const;

/** The top-level keys, as the shipped file lists them. */
function defaults(): CoreHooksConfig {
    return {
        logPath: defaultLogPath(),
        shadow: SHIPPED.shadow,
        logCommands: SHIPPED.logCommands,
        maxLogMB: SHIPPED.maxLogMB,
    };
}

/** The whole stored file: the top-level keys sit beside the sections, and `maxLogBytes` is the pre-rename cap. */
function merge(value: unknown, problems: string[]): CoreHooksConfig {
    const stored = storedPart<CoreHooksConfig & { maxLogBytes: unknown }>(value);

    return {
        shadow: boolOr(stored.shadow, SHIPPED.shadow),
        logCommands: logCommandsOr(stored.logCommands, SHIPPED.logCommands),
        maxLogMB: megabytesOr(problems, {
            field: "maxLogMB",
            value: stored.maxLogMB,
            fallback: legacyMB(stored.maxLogBytes) ?? SHIPPED.maxLogMB,
        }),
        logPath: typeof stored.logPath === "string" && stored.logPath.length > 0 ? stored.logPath : defaultLogPath(),
    };
}

function set(current: CoreHooksConfig, key: string, value: string): CoreHooksConfig {
    if (key === "shadow") {
        return { ...current, shadow: asBoolean(key, value) };
    }

    if (key === "logCommands") {
        const policy = LOG_COMMANDS_POLICIES.find((candidate) => candidate === value);

        if (!policy) {
            throw new Error(`${key} takes shadow, always or never, not ${SafeJSON.stringify(value)}`);
        }

        return { ...current, logCommands: policy };
    }

    return { ...current, maxLogMB: asMegabytes(key, value) };
}

/** The keys at the top of `hooks.json`: shadow mode, the decision log and its rotation. */
export const CORE_HOOK_SECTION: HookConfigSection<CoreHooksConfig, HookDoctorFacts> = {
    key: null,
    defaults,
    merge,
    settable: ["shadow", "logCommands", "maxLogMB"],
    owns: (key) => key === "shadow" || key === "logCommands" || key === "maxLogMB",
    set,
    entries: () => [],
    doctor: (core, facts) => [
        ["Stop hook", facts.stopHookWired ? "wired" : "not wired"],
        ["shadow", core.shadow ? "ON (decides, says nothing)" : "off (it speaks)"],
        ["log", core.logPath],
        ["log rotates at", `${core.maxLogMB} MB, keeping one generation`],
    ],
};

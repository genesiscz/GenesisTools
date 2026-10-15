import { copyFileSync, existsSync } from "node:fs";
import { env } from "@genesiscz/utils/env";
import { claudeSettingsPath, readSettings } from "./install";
import { hookDiag } from "./log";
import { writeJsonFile } from "./write-json";

/**
 * Claude Code's own Bash diff (`bashEditDiffEnabled`, 2.1.296). It has no attribution: it draws
 * whatever changed in the cwd repository while a Bash call ran, another session's edit included
 * (observed 2026-10-14 22:59: another session's `run.ts` under an unrelated `cat > step1.ts`). With
 * `diff.replaceNative` on and `shadow` off, the hook draws every Bash diff and this one is switched off.
 * While `shadow` is on the hook prints nothing, so this diff stays.
 *
 * `on` and `off` are what the settings file says; `default` is no key, or a file that does not parse,
 * which Claude Code reads as on in auto and bypassPermissions mode. `tools claude start` reads this,
 * so a half-written settings file must not abort the launch. The `CLAUDE_CODE_BASH_EDIT_DIFF`
 * variable wins over all of them in a session that has it.
 */
export type NativeDiffState = "on" | "off" | "default";

export function nativeDiffState(settingsPath = claudeSettingsPath()): NativeDiffState {
    let value: unknown;

    try {
        value = readSettings(settingsPath).bashEditDiffEnabled;
    } catch (err) {
        hookDiag("Could not read the native diff setting", { err, path: settingsPath });

        return "default";
    }

    return value === false ? "off" : value === true ? "on" : "default";
}

/**
 * `"1"` or `"0"` when `CLAUDE_CODE_BASH_EDIT_DIFF` decides for a session started from this
 * environment, whatever the setting says; `null` when the setting decides. `tools claude start` set
 * it to `1` for every launch until 2026-10-15, so a session from before that shows the native diff.
 */
export function nativeDiffForced(): "1" | "0" | null {
    const value = env.getProcessEnv().CLAUDE_CODE_BASH_EDIT_DIFF;

    return value === "1" || value === "0" ? value : null;
}

export interface NativeDiffChange {
    before: NativeDiffState;
    after: NativeDiffState;
    changed: boolean;
    backup?: string;
}

/** Sets `bashEditDiffEnabled`; writes only with `write`. The first write keeps a backup beside the file. */
export function setNativeDiff(options: { enabled: boolean; write: boolean; settingsPath?: string }): NativeDiffChange {
    const settingsPath = options.settingsPath ?? claudeSettingsPath();
    const settings = readSettings(settingsPath) as Record<string, unknown>;
    const before = nativeDiffState(settingsPath);
    const after: NativeDiffState = options.enabled ? "on" : "off";
    const changed = before !== after;

    if (!changed || !options.write) {
        return { before, after, changed };
    }

    const backup = `${settingsPath}.pre-native-diff`;

    if (existsSync(settingsPath) && !existsSync(backup)) {
        copyFileSync(settingsPath, backup);
    }

    settings.bashEditDiffEnabled = options.enabled;
    writeJsonFile(settingsPath, settings);

    return { before, after, changed, backup };
}

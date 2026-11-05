import { parseFlags } from "@genesiscz/utils/cli/flag-issues";
import { recorderSetSchema, settingsPatchOf } from "@genesiscz/utils/repl/toolsets/recorder";
import type { RecorderSettingsPatch } from "@genesiscz/utils/screen-recorder/control";

/** What commander gives for `tools meetings record set`. */
export interface SetSettingsFlags {
    activeFps?: string;
    idleFps?: string;
    threshold?: string;
    maxLongSide?: string;
    ocr?: boolean;
    ocrLanguages?: string;
    ocrMinChars?: string;
    json?: boolean;
}

/** The flag of each field of the REPL's `setSettings()` patch, so a refusal names what was typed. */
const SET_SETTINGS_FLAGS = {
    fps: "--active-fps",
    idleFps: "--idle-fps",
    threshold: "--threshold",
    maxLongSide: "--max-long-side",
    "ocr.enabled": "--ocr",
    "ocr.languages": "--ocr-languages",
    "ocr.minChars": "--ocr-min-chars",
};

/** The live patch the flags ask for, checked by the schema the REPL's `meeting.setSettings()` takes. */
export function settingsPatchFromFlags(opts: SetSettingsFlags): RecorderSettingsPatch {
    const number = (raw: string | undefined) => (raw === undefined ? undefined : Number(raw));
    const languages = opts.ocrLanguages
        ?.split(",")
        .map((language) => language.trim())
        .filter(Boolean);
    const ocr = Object.fromEntries(
        Object.entries({ enabled: opts.ocr, languages, minChars: number(opts.ocrMinChars) }).filter(
            ([, value]) => value !== undefined
        )
    );
    const input = Object.fromEntries(
        Object.entries({
            fps: number(opts.activeFps),
            idleFps: number(opts.idleFps),
            threshold: number(opts.threshold),
            maxLongSide: number(opts.maxLongSide),
            ocr: Object.keys(ocr).length > 0 ? ocr : undefined,
        }).filter(([, value]) => value !== undefined)
    );
    return settingsPatchOf(parseFlags(recorderSetSchema, input, SET_SETTINGS_FLAGS));
}

import { readFileSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { canonicalPath } from "@genesiscz/utils/fs/canonical";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";
import { toolDataDir } from "@genesiscz/utils/storage/root";

const { log } = logger.scoped("meetings-source-audio");

/** Source media is permanent. */
export const SOURCE_AUDIO_FOLDER = "source-audio";
/** The sound the Meetings recorder kept: permanent while `global.capture.audioRetentionDays` is unset. */
export const RECORDED_SOUND_PATHS: readonly string[] = ["audio", "audio.jsonl"];

/**
 * Whether the meetings config sets `global.capture.audioRetentionDays`. Read raw and synchronously, because cleanup
 * asks per path; a config that cannot be read keeps the sound.
 */
export function recordedSoundExpires(): boolean {
    const path = toolDataDir("meetings", "config.json");
    let parsed: unknown;

    try {
        parsed = SafeJSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
        if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) {
            log.debug({ err, path }, "the meetings config could not be read; the recorded sound is kept");
        }

        return false;
    }

    const capture = isObject(parsed) && isObject(parsed.global) ? parsed.global.capture : undefined;
    const days = isObject(capture) ? capture.audioRetentionDays : undefined;
    return typeof days === "number" && days > 0;
}

/**
 * Automatic cleanup must not nominate the archive, its contents, or a folder that could hold it, nor the recorded
 * sound of a meeting while no retention is set for it.
 */
export function protectsMeetingSourceAudio(path: string): boolean {
    const root = canonicalPath(toolDataDir("meetings"));
    const candidate = canonicalPath(path);
    const fromCandidate = relative(candidate, root);
    if (
        fromCandidate === "" ||
        (!isAbsolute(fromCandidate) && fromCandidate !== ".." && !fromCandidate.startsWith(`..${sep}`))
    ) {
        return true;
    }

    const fromRoot = relative(root, candidate);
    if (isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
        return false;
    }

    const parts = fromRoot.split(sep);
    if (parts.length === 1 || parts[1] === SOURCE_AUDIO_FOLDER) {
        return true;
    }

    return RECORDED_SOUND_PATHS.includes(parts[1] ?? "") && !recordedSoundExpires();
}

import { type TimeValue, timeSchema } from "@genesiscz/utils/recording-editor/plan";
import { SUBTITLE_FORMATS, type SubtitleFormat } from "@genesiscz/utils/recording-editor/subtitles";

/** A `--from`/`--to` time: seconds or m:ss, with a plain message instead of a zod dump. */
export function parseTime(raw: string, flag: string): TimeValue {
    const parsed = timeSchema.safeParse(raw);

    if (!parsed.success) {
        throw new Error(`${flag} takes seconds, m:ss or h:mm:ss (got "${raw}")`);
    }

    return parsed.data;
}

export function parseSubtitleFormat(raw: string): SubtitleFormat {
    const found = SUBTITLE_FORMATS.find((format) => format === raw);

    if (!found) {
        throw new Error(`the subtitle format is one of ${SUBTITLE_FORMATS.join(", ")} (got "${raw}")`);
    }

    return found;
}

import { existsSync, statSync } from "node:fs";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import {
    TONE_MAX_SEC,
    TONE_PRESETS,
    type TonePresetName,
    type ToneSoundSetting,
} from "@genesiscz/utils/meetings/config";
import type { AudioProbe } from "./audio";

/**
 * A tone's sound as a cut mixes it and a Moment names it: a sine of `hz`, or a sound file (`file`, with `hz` 0), `sec`
 * long at `volume`; `preset` names the preset it came from. `hz`, `sec` and `volume` are always there, so a reader of
 * the version 4 sine (the Meetings window's `ToneSound`) reads every sound, and a tone ends at `atSec + sec`.
 */
export interface ToneSound {
    hz: number;
    sec: number;
    volume: number;
    file?: string;
    preset?: TonePresetName;
}

/** The volume a setting plays at: its own, else its preset's. */
function toneVolume(setting: ToneSoundSetting): number {
    return "preset" in setting ? (setting.volume ?? TONE_PRESETS[setting.preset].volume) : setting.volume;
}

/** The sound of a sine or of a sine preset, which needs no file read; undefined for a sound file. */
export function sineToneSound(setting: ToneSoundSetting): ToneSound | undefined {
    if ("hz" in setting) {
        return { hz: setting.hz, sec: setting.sec, volume: setting.volume };
    }

    if ("preset" in setting) {
        const sound = TONE_PRESETS[setting.preset].sound;
        return sound.kind === "sine"
            ? { hz: sound.hz, sec: sound.sec, volume: toneVolume(setting), preset: setting.preset }
            : undefined;
    }

    return undefined;
}

/** The sound file a setting names: its own `file`, or a file preset's; undefined for a sine. */
export function toneSoundFile(setting: ToneSoundSetting): string | undefined {
    if ("file" in setting) {
        return setting.file;
    }

    if ("preset" in setting) {
        const sound = TONE_PRESETS[setting.preset].sound;
        return sound.kind === "file" ? sound.path : undefined;
    }

    return undefined;
}

/** A sound file's length by its path and version, so a tone file is probed once while it stays the same. */
const fileLengths = new Map<string, number>();

/**
 * A tone setting as a cut takes it. A sound file's length is read once per version of the file (`probe`, ffprobe in
 * production) and cut to `TONE_MAX_SEC`. Throws a message ready to print for a file that is not there or holds no
 * sound.
 */
export async function resolveToneSound(
    setting: ToneSoundSetting,
    options: { probe: (path: string) => Promise<Pick<AudioProbe, "durationSec">> }
): Promise<ToneSound> {
    const sine = sineToneSound(setting);

    if (sine) {
        return sine;
    }

    const file = toneSoundFile(setting);

    if (!file || !existsSync(file)) {
        throw new Error(
            `The tone's sound file ${file ?? "(none)"} is not there. Pick another sound: ${toolCommand("meetings", "config", "set", "global.playback.listen.tone.sound")} '{"preset":"beep"}'`
        );
    }

    const stat = statSync(file);
    const key = `${file}\n${stat.mtimeMs}\n${stat.size}`;
    let lengthSec = fileLengths.get(key);

    if (lengthSec === undefined) {
        lengthSec = (await options.probe(file)).durationSec;
        fileLengths.set(key, lengthSec);
    }

    if (!(lengthSec > 0)) {
        throw new Error(`The tone's sound file ${file} holds no sound ffmpeg reads; pick another.`);
    }

    return {
        hz: 0,
        sec: Math.min(TONE_MAX_SEC, Math.round(lengthSec * 1000) / 1000),
        volume: toneVolume(setting),
        file,
        ...("preset" in setting ? { preset: setting.preset } : {}),
    };
}

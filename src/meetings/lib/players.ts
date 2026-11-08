import { existsSync } from "node:fs";
import type { LISTEN_PLAYERS, MEETING_PLAYERS } from "@genesiscz/utils/meetings/config";
import { formatClock } from "@genesiscz/utils/transcribe/render";

export type PlayerId = (typeof LISTEN_PLAYERS)[number] | (typeof MEETING_PLAYERS)[number];

/** An audio player on this Mac: whether it is installed, and how it plays a file to its end. */
export abstract class AudioPlayer {
    abstract readonly id: PlayerId;

    abstract available(): boolean;

    /** Plays the whole file and exits at its end. */
    abstract clipArgv(path: string): string[];
}

/** A player that can start a file at a second, for `tools meetings play`. */
export abstract class SeekingPlayer extends AudioPlayer {
    abstract override readonly id: (typeof MEETING_PLAYERS)[number];

    abstract fromArgv(path: string, startSec: number): string[];
}

const VLC = "/Applications/VLC.app/Contents/MacOS/VLC";

class AfplayPlayer extends AudioPlayer {
    readonly id = "afplay" as const;

    available(): boolean {
        return existsSync("/usr/bin/afplay");
    }

    clipArgv(path: string): string[] {
        return ["/usr/bin/afplay", path];
    }
}

class VlcPlayer extends SeekingPlayer {
    readonly id = "vlc" as const;

    available(): boolean {
        return existsSync(VLC);
    }

    clipArgv(path: string): string[] {
        return [VLC, "--play-and-exit", path];
    }

    fromArgv(path: string, startSec: number): string[] {
        return [VLC, `--start-time=${startSec}`, path];
    }
}

class FfplayPlayer extends SeekingPlayer {
    readonly id = "ffplay" as const;

    available(): boolean {
        return Bun.which("ffplay") !== null;
    }

    clipArgv(path: string): string[] {
        return ["ffplay", "-nodisp", "-autoexit", "-loglevel", "error", path];
    }

    fromArgv(path: string, startSec: number): string[] {
        return ["ffplay", "-ss", String(startSec), "-nodisp", "-autoexit", path];
    }
}

/** Every player, by id. `MEETING_PLAYERS` names the seeking ones, `LISTEN_PLAYERS` the ones that play a clip. */
export const PLAYERS: { [Id in PlayerId]: Id extends (typeof MEETING_PLAYERS)[number] ? SeekingPlayer : AudioPlayer } =
    {
        afplay: new AfplayPlayer(),
        vlc: new VlcPlayer(),
        ffplay: new FfplayPlayer(),
    };

/** The preferred player when it is installed, else the first of `all` that is. */
export function pickPlayer<Id extends PlayerId>(preferred: Id, all: readonly Id[]): (typeof PLAYERS)[Id] | undefined {
    const id = [preferred, ...all.filter((name) => name !== preferred)].find((name) => PLAYERS[name].available());
    return id === undefined ? undefined : PLAYERS[id];
}

/** What `tools meetings play` plays: the file, the second it starts at, the player and its command line. */
export interface PlaybackPlan {
    audioPath: string;
    startSec: number;
    player: (typeof MEETING_PLAYERS)[number];
    argv: string[];
}

/**
 * The player for one `play`: the one `--player` names, which must be installed (the Meetings window asks for ffplay
 * because it has no window of its own, so it must never become VLC), else `playback.player` or the first installed.
 */
export function choosePlayer(options: {
    requested?: string;
    configured: (typeof MEETING_PLAYERS)[number];
    all: readonly (typeof MEETING_PLAYERS)[number][];
}): { player: SeekingPlayer } | { error: string } {
    const { requested, configured, all } = options;

    if (requested === undefined) {
        const player = pickPlayer(configured, all);
        return player
            ? { player }
            : { error: `No player found (${all.join(", ")}). Install VLC, or ffmpeg for ffplay.` };
    }

    const id = all.find((name) => name === requested);

    if (!id) {
        return { error: `--player ${requested} is not a player: ${all.join(", ")}` };
    }

    const player = PLAYERS[id];
    return player.available() ? { player } : { error: `${id} is not installed on this Mac.` };
}

/** Plays from `beforeSec` ahead of `atSec`, never before the start of the file. */
/** Audio after the last speech this long is still the meeting (a silence, a goodbye); later is past its end. */
export const PAST_END_GRACE_SEC = 30;

/**
 * Why `play --at` refuses a time after the meeting's end, or undefined. The bound is the last speech segment the source
 * keeps, which `play` reads anyway; without segments there is no bound (R2-MC5).
 */
export function pastTheEnd(atSec: number, lastSpeechSec: number | undefined): string | undefined {
    return lastSpeechSec !== undefined && atSec > lastSpeechSec + PAST_END_GRACE_SEC
        ? `--at ${formatClock(atSec)} is after the meeting's last speech (${formatClock(lastSpeechSec)}).`
        : undefined;
}

export function playbackPlan(options: {
    audioPath: string;
    atSec: number;
    beforeSec: number;
    player: SeekingPlayer;
}): PlaybackPlan {
    const startSec = Math.max(0, options.atSec - options.beforeSec);
    return {
        audioPath: options.audioPath,
        startSec,
        player: options.player.id,
        argv: options.player.fromArgv(options.audioPath, startSec),
    };
}

import { existsSync } from "node:fs";
import type { LISTEN_PLAYERS, MEETING_PLAYERS } from "@genesiscz/utils/meetings/config";

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

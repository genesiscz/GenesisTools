import { existsSync } from "node:fs";
import { ui } from "@genesiscz/utils/cli/ui";
import { logger } from "@genesiscz/utils/logger";
import { MEETING_PLAYERS, MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import { MeetingStore } from "@genesiscz/utils/meetings/record";
import { formatClock, parseClock } from "@genesiscz/utils/transcribe/render";
import type { Command } from "commander";
import { errorText, fail, TOOL } from "../lib/shared";
import { meetingSource } from "../lib/sources";

const { log } = logger.scoped("meetings-play");

type Player = (typeof MEETING_PLAYERS)[number];

/** How each player is found and started at a second. */
const PLAYERS: Record<Player, { available: () => boolean; argv: (path: string, sec: number) => string[] }> = {
    vlc: {
        available: () => existsSync("/Applications/VLC.app/Contents/MacOS/VLC"),
        argv: (path, sec) => ["/Applications/VLC.app/Contents/MacOS/VLC", `--start-time=${sec}`, path],
    },
    ffplay: {
        available: () => Bun.which("ffplay") !== null,
        argv: (path, sec) => ["ffplay", "-ss", String(sec), "-nodisp", "-autoexit", path],
    },
};

async function play(ref: string, opts: { at: string; before?: string }): Promise<void> {
    const atSec = parseClock(opts.at);

    if (atSec === undefined) {
        fail(`--at needs a transcript time: 1:23:50, 23:50 or seconds.`);
        return;
    }

    try {
        const record = new MeetingStore().resolve(ref);

        if (!record) {
            fail(`No meeting "${ref}". List them: ${TOOL} list`);
            return;
        }

        const [sourceId, block] =
            Object.entries(record.sources).find(([, value]) => typeof value.meetingId === "string") ?? [];

        if (!sourceId || typeof block?.meetingId !== "string") {
            fail(`${record.id} has no linked source with audio.`);
            return;
        }

        const evidence = await (await meetingSource(sourceId)).evidence(block.meetingId);

        if (!evidence?.audioPath) {
            fail(`The source keeps no audio for ${record.id} on this Mac.`);
            return;
        }

        const playback = (await new MeetingsConfigStore().read()).global.playback;
        const before = opts.before === undefined ? playback.beforeSec : Number(opts.before);
        const order = [playback.player, ...MEETING_PLAYERS.filter((player) => player !== playback.player)];
        const player = order.find((name) => PLAYERS[name].available());

        if (!player) {
            fail(`No player found (${MEETING_PLAYERS.join(", ")}). Install VLC, or ffmpeg for ffplay.`);
            return;
        }

        const startSec = Math.max(0, atSec - before);
        const argv = PLAYERS[player].argv(evidence.audioPath, startSec);
        Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true }).unref();
        log.debug({ argv }, "player started");
        ui.ok(`Playing ${record.id} from ${formatClock(startSec)} in ${player}.`);
    } catch (err) {
        fail(errorText(err));
    }
}

export function registerPlayCommand(program: Command): void {
    program
        .command("play")
        .argument("<meeting>", "meeting id, a unique prefix, last, or wisprflow:<id>")
        .description("Play the meeting's audio from a transcript time, to hear a voice before confirming it")
        .requiredOption("--at <time>", "transcript time: 1:23:50, 23:50 or seconds")
        .option("--before <sec>", "start this many seconds earlier (default: playback.beforeSec, 5)")
        .action(play);
}

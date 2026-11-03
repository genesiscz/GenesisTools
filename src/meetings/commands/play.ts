import { ui } from "@genesiscz/utils/cli/ui";
import { logger } from "@genesiscz/utils/logger";
import { MEETING_PLAYERS, MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import { MeetingStore } from "@genesiscz/utils/meetings/record";
import { formatClock, parseClock } from "@genesiscz/utils/transcribe/render";
import type { Command } from "commander";
import { meetingAudioPath } from "../lib/audio";
import { pickPlayer } from "../lib/players";
import { errorText, fail, TOOL } from "../lib/shared";

const { log } = logger.scoped("meetings-play");

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

        const audioPath = await meetingAudioPath(record);
        const playback = (await new MeetingsConfigStore().read()).global.playback;
        const before = opts.before === undefined ? playback.beforeSec : Number(opts.before);
        const player = pickPlayer(playback.player, MEETING_PLAYERS);

        if (!player) {
            fail(`No player found (${MEETING_PLAYERS.join(", ")}). Install VLC, or ffmpeg for ffplay.`);
            return;
        }

        const startSec = Math.max(0, atSec - before);
        const argv = player.fromArgv(audioPath, startSec);
        Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true }).unref();
        log.debug({ argv }, "player started");
        ui.ok(`Playing ${record.id} from ${formatClock(startSec)} in ${player.id}.`);
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

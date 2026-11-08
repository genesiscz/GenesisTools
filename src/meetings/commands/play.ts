import { ui } from "@genesiscz/utils/cli/ui";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { MEETING_PLAYERS, MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import { MeetingStore } from "@genesiscz/utils/meetings/record";
import { formatClock, parseClock } from "@genesiscz/utils/transcribe/render";
import type { Command } from "commander";
import { meetingAudio } from "../lib/audio";
import { choosePlayer, pastTheEnd, playbackPlan } from "../lib/players";
import { errorText, fail, TOOL } from "../lib/shared";

const { log } = logger.scoped("meetings-play");

/** A count of seconds as typed: a non-negative number, else undefined. */
function seconds(value: string): number | undefined {
    const parsed = Number(value);
    return value.trim() !== "" && Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

async function play(
    ref: string,
    opts: { at: string; before?: string; player?: string; json?: boolean; start?: boolean }
): Promise<void> {
    const atSec = parseClock(opts.at);

    if (atSec === undefined) {
        fail(`--at needs a transcript time: 1:23:50, 23:50 or seconds.`);
        return;
    }

    const beforeSec = opts.before === undefined ? undefined : seconds(opts.before);

    if (opts.before !== undefined && beforeSec === undefined) {
        fail(`--before ${opts.before} is not a number of seconds (try 5).`);
        return;
    }

    try {
        const record = new MeetingStore().resolve(ref);

        if (!record) {
            fail(`No meeting "${ref}". List them: ${TOOL} list`);
            return;
        }

        const playback = (await new MeetingsConfigStore().read()).global.playback;
        const chosen = choosePlayer({ requested: opts.player, configured: playback.player, all: MEETING_PLAYERS });

        if ("error" in chosen) {
            fail(chosen.error);
            return;
        }

        const audio = await meetingAudio(record);
        const late = pastTheEnd(atSec, audio.lastSpeechSec);

        if (late) {
            fail(late);
            return;
        }

        const plan = playbackPlan({
            audioPath: audio.audioPath,
            atSec,
            beforeSec: beforeSec ?? playback.beforeSec,
            player: chosen.player,
        });
        const shown = { audioPath: plan.audioPath, startSec: plan.startSec, player: plan.player };

        if (opts.start === false) {
            log.debug({ argv: plan.argv }, "player not started (--no-start)");
            opts.json
                ? out.result(SafeJSON.stringify(shown, null, 2))
                : ui.ok(
                      `Would play ${record.id} from ${formatClock(plan.startSec)} in ${plan.player}: ${plan.argv.join(" ")}`
                  );
            return;
        }

        const child = Bun.spawn(plan.argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
        child.unref();
        log.debug({ argv: plan.argv, pid: child.pid }, "player started");
        opts.json
            ? out.result(SafeJSON.stringify({ ...shown, pid: child.pid }, null, 2))
            : ui.ok(`Playing ${record.id} from ${formatClock(plan.startSec)} in ${plan.player}.`);
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
        .option("--player <id>", `this player for one call instead of playback.player: ${MEETING_PLAYERS.join(", ")}`)
        .option("--json", "print { audioPath, startSec, player, pid } (pid only when a player started)")
        .option("--no-start", "resolve the file, the start and the player, and start nothing (no sound)")
        .action(play);
}

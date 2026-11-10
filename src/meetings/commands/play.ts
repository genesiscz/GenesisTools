import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ui } from "@genesiscz/utils/cli/ui";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import {
    LISTEN_PLAYERS,
    MEETING_PLAYERS,
    MeetingsConfigStore,
    TONE_PRESET_NAMES,
    type ToneSoundSetting,
    toneSoundSettingSchema,
} from "@genesiscz/utils/meetings/config";
import { type MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { formatClock, parseClock } from "@genesiscz/utils/transcribe/render";
import type { Command } from "commander";
import { meetingAudio } from "../lib/audio";
import { MOMENT_ERROR_CODES, type Moment, MomentError, type MomentTarget, momentTargetSchema } from "../lib/moment";
import { choosePlayer, PLAYERS, pastTheEnd, pickPlayer, playbackPlan } from "../lib/players";
import { withMeetingsClient } from "../lib/service/client";
import { MeetingsServiceError } from "../lib/service/handlers";
import { errorText, fail, TOOL } from "../lib/shared";

const { log } = logger.scoped("meetings-play");

interface PlayOptions {
    at?: string;
    to?: string;
    item?: string;
    target?: string;
    clip?: boolean;
    moment?: boolean;
    before?: string;
    tone?: string;
    player?: string;
    json?: boolean;
    start?: boolean;
}

/** A count of seconds as typed: a non-negative number, else undefined. */
function seconds(value: string): number | undefined {
    const parsed = Number(value);
    return value.trim() !== "" && Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * What the flags ask to play: a Moment target (`--item`, `--target`, `--at` with `--to` or `--clip`), the open-ended
 * play of `--at` alone (today's `play`), or why the flags do not name one.
 */
function wanted(opts: PlayOptions): { target: MomentTarget } | { atSec: number } | { error: string } {
    const named = [opts.at, opts.item, opts.target].filter((flag) => flag !== undefined).length;

    if (named !== 1) {
        return {
            error:
                named === 0
                    ? "Name what to play: --at <time>, --item <id> or --target <json>."
                    : "--at, --item and --target each name what to play; give one of them.",
        };
    }

    if (opts.to !== undefined && opts.at === undefined) {
        return { error: "--to ends the range that --at starts." };
    }

    if (opts.item !== undefined) {
        return { target: { kind: "item", id: opts.item } };
    }

    if (opts.target !== undefined) {
        let value: unknown;

        try {
            value = SafeJSON.parse(opts.target, { strict: true });
        } catch {
            return { error: `--target is not JSON: ${opts.target}` };
        }

        const parsed = momentTargetSchema.safeParse(value);
        return parsed.success
            ? { target: parsed.data }
            : {
                  error: `--target is not a Moment target (${parsed.error.issues[0]?.message}). Try {"kind":"range","fromSec":60,"toSec":75}.`,
              };
    }

    const atSec = parseClock(opts.at ?? "");

    if (atSec === undefined) {
        return { error: "--at needs a transcript time: 1:23:50, 23:50 or seconds." };
    }

    if (opts.to === undefined) {
        return opts.clip || opts.moment ? { target: { kind: "time", atSec } } : { atSec };
    }

    const toSec = parseClock(opts.to);
    return toSec === undefined
        ? { error: "--to needs a transcript time: 1:23:50, 23:50 or seconds." }
        : { target: { kind: "range", fromSec: atSec, toSec } };
}

/**
 * `--tone`: a preset's name, a sound file's path, or a tone setting as JSON (`{"file":"/x.wav","volume":0.3}`,
 * `{"hz":440,"sec":0.2}`). A preset plays at its own volume, a file at the default one.
 */
function toneFlag(value: string): { sound: ToneSoundSetting } | { error: string } {
    const preset = TONE_PRESET_NAMES.find((name) => name === value);

    if (preset) {
        return { sound: toneSoundSettingSchema.parse({ preset }) };
    }

    if (value.trim().startsWith("{")) {
        let json: unknown;

        try {
            json = SafeJSON.parse(value, { strict: true });
        } catch {
            return { error: `--tone is not JSON: ${value}` };
        }

        const parsed = toneSoundSettingSchema.safeParse(json);
        return parsed.success
            ? { sound: parsed.data }
            : { error: `--tone is not a tone (${parsed.error.issues[0]?.message}). Try {"hz":440,"sec":0.2}.` };
    }

    return existsSync(value)
        ? { sound: toneSoundSettingSchema.parse({ file: resolve(value) }) }
        : { error: `--tone takes a preset (${TONE_PRESET_NAMES.join(", ")}), a sound file or JSON; ${value} is none.` };
}

/** One line for a person: what the Moment hears, the clip around it, where the tone sounds, and the screen. */
function momentLine(moment: Moment): string {
    const tone = moment.tone ? `, tone at ${formatClock(moment.tone.atSec)}` : "";
    const screen = moment.screen?.length ? `; screen: ${moment.screen.map((frame) => frame.file).join(", ")}` : "";
    const heard = `${formatClock(moment.fromSec)}–${formatClock(moment.toSec)}`;
    // A range is named by its span already: print it once.
    const named = moment.label === heard ? heard : `${moment.label} ${heard}`;
    return `${named} (clip ${formatClock(moment.startSec)}–${formatClock(moment.endSec)}${tone})${screen}`;
}

/** A Moment target: planned (`--no-start`), cut (`--clip`), or cut and played once in the clip player. */
async function playMoment(record: MeetingRecord, target: MomentTarget, opts: PlayOptions): Promise<void> {
    if (opts.before !== undefined) {
        fail(
            "--before sets the lead-in of an open-ended --at play; a Moment pads by playback.listen.padBeforeSec and padAfterSec."
        );
        return;
    }

    const tone = opts.tone === undefined ? undefined : toneFlag(opts.tone);

    if (tone && "error" in tone) {
        fail(tone.error);
        return;
    }

    const toneSound = tone?.sound;

    if (!opts.clip && opts.start === false) {
        const planned = await withMeetingsClient((client) =>
            client.call("moment.plan", { meeting: record.id, target, ...(toneSound ? { toneSound } : {}) })
        );

        if (!planned.moment) {
            fail(`[${planned.cannot?.code}] ${planned.cannot?.message}`);
            return;
        }

        opts.json ? out.result(SafeJSON.stringify(planned.moment, null, 2)) : out.println(momentLine(planned.moment));
        return;
    }

    let player: (typeof LISTEN_PLAYERS)[number] | undefined;

    if (!opts.clip) {
        const requested = opts.player === undefined ? undefined : LISTEN_PLAYERS.find((id) => id === opts.player);

        if (opts.player !== undefined && !requested) {
            fail(`--player ${opts.player} does not play a clip: ${LISTEN_PLAYERS.join(", ")}`);
            return;
        }

        const listen = (await new MeetingsConfigStore().read()).global.playback.listen;
        player = requested
            ? PLAYERS[requested].available()
                ? requested
                : undefined
            : pickPlayer(listen.player, LISTEN_PLAYERS)?.id;

        if (!player) {
            fail(
                requested ? `${requested} is not installed on this Mac.` : "No clip player found (afplay, VLC, ffplay)."
            );
            return;
        }
    }

    const cut = await withMeetingsClient((client) =>
        client.call("moment.clip", { meeting: record.id, target, ...(toneSound ? { toneSound } : {}) })
    );

    if (!player) {
        opts.json ? out.result(SafeJSON.stringify(cut, null, 2)) : ui.ok(`Cut ${momentLine(cut)}: ${cut.path}`);
        return;
    }

    const argv = PLAYERS[player].clipArgv(cut.path);
    const child = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
    child.unref();
    log.debug({ argv, pid: child.pid }, "clip player started");
    opts.json
        ? out.result(SafeJSON.stringify({ ...cut, player, pid: child.pid }, null, 2))
        : ui.ok(`Playing ${momentLine(cut)} in ${player}.`);
}

async function play(ref: string, opts: PlayOptions): Promise<void> {
    const what = wanted(opts);

    if ("error" in what) {
        fail(what.error);
        return;
    }

    if (opts.tone !== undefined && !("target" in what)) {
        fail("--tone sets a Moment's tone; --at alone plays on from there without one (add --moment, --to or --clip).");
        return;
    }

    const beforeSec = opts.before === undefined ? undefined : seconds(opts.before);

    if (opts.before !== undefined && beforeSec === undefined) {
        fail(`--before ${opts.before} is not a number of seconds (try 5).`);
        return;
    }

    try {
        const store = new MeetingStore();
        const record = store.resolve(ref);

        if (!record) {
            fail(`No meeting "${ref}". List them: ${TOOL} list`);
            return;
        }

        if ("target" in what) {
            await playMoment(record, what.target, opts);
            return;
        }

        const { atSec } = what;
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
        fail(momentFailure(err));
    }
}

/**
 * A failed play in words: a target the meeting does not have leads with its code, as a conflict does
 * (`[unknown-item] …`); a state of this Mac (no audio, no ffmpeg) is its sentence alone, as before the service.
 */
function momentFailure(err: unknown): string {
    if (err instanceof MeetingsServiceError && err.code === "unplayable") {
        const reason = typeof err.data === "object" && err.data !== null ? Reflect.get(err.data, "reason") : undefined;
        const coded = MOMENT_ERROR_CODES.find((code) => code === reason);
        return coded ? `[${coded}] ${err.message}` : err.message;
    }

    return err instanceof MomentError ? `[${err.code}] ${err.message}` : errorText(err);
}

export function registerPlayCommand(program: Command): void {
    program
        .command("play")
        .argument("<meeting>", "meeting id, a unique prefix, last, or wisprflow:<id>")
        .description(
            "Play the meeting's audio from a transcript time, or the Moment of an item, a time or a range: a bounded clip with the tone before the asked spot"
        )
        .option("--at <time>", "transcript time: 1:23:50, 23:50 or seconds; alone it plays on from there")
        .option("--to <time>", "with --at: the Moment of the range from --at to this time")
        .option("--item <id>", "the Moment of an item: its id (i42) or a question's number (Q12, 12)")
        .option(
            "--target <json>",
            'any Moment target as JSON: {"kind":"selection","from":{"atSec":60,"fraction":0.5},"to":{"atSec":70}}, {"kind":"stretch","atSec":60}'
        )
        .option("--clip", "cut the Moment to a WAV in the clip cache and print it; plays nothing")
        .option(
            "--moment",
            "with --at alone: play the Moment at that time (a bounded clip with the tone), not on from there"
        )
        .option("--before <sec>", "start this many seconds earlier (default: playback.beforeSec, 5); --at alone only")
        .option(
            "--tone <sound>",
            `a Moment's tone for this call: a preset (${TONE_PRESET_NAMES.join(", ")}), a sound file, or JSON ({"hz":440,"sec":0.2}); default playback.listen.tone.sound`
        )
        .option(
            "--player <id>",
            `this player for one call: ${MEETING_PLAYERS.join(", ")} for --at alone, ${LISTEN_PLAYERS.join(", ")} for a Moment`
        )
        .option(
            "--json",
            "print { audioPath, startSec, player, pid } for --at alone; for a Moment the Moment, with path, player and pid when made"
        )
        .option("--no-start", "resolve and start nothing (no sound); a Moment is planned, not cut")
        .action(play);
}

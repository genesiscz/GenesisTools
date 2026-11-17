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
import { lineEvidence } from "@genesiscz/utils/transcribe/evidence";
import { formatClock, parseClock } from "@genesiscz/utils/transcribe/render";
import type { Command } from "commander";
import { MOMENT_ERROR_CODES, type Moment, MomentError, type MomentTarget, momentTargetSchema } from "../lib/moment";
import { OpenedMeeting } from "../lib/opened-meeting";
import { PLAYERS, pickPlayer } from "../lib/players";
import { withMeetingsClient } from "../lib/service/client";
import { MeetingsServiceError } from "../lib/service/handlers";
import { errorText, fail, TOOL } from "../lib/shared";
import { type SoundSlice, TRACK_KINDS, type TrackKind } from "../lib/sound";
import { playInOpenWindow } from "../lib/window";

const { log } = logger.scoped("meetings-play");

interface PlayOptions {
    track?: string | boolean;
    at?: string;
    to?: string;
    item?: string;
    target?: string;
    clip?: boolean;
    save?: boolean;
    title?: string;
    quote?: string;
    moment?: boolean;
    window?: boolean;
    before?: string;
    padBefore?: string;
    padAfter?: string;
    length?: string;
    screen?: boolean;
    tone?: string | false;
    player?: string;
    json?: boolean;
    start?: boolean;
}

/** Decode the original track to the Moment player's stdin. No model-rate copy or clip cache is written. */
export async function playSoundSlice(options: {
    slice: SoundSlice;
    player?: string;
    detached?: boolean;
}): Promise<{ pid: number; player: (typeof LISTEN_PLAYERS)[number] }> {
    const listen = (await new MeetingsConfigStore().read()).global.playback.listen;
    const requested = options.player === undefined ? undefined : LISTEN_PLAYERS.find((id) => id === options.player);
    if (options.player !== undefined && !requested) {
        throw new Error(`--player needs ${LISTEN_PLAYERS.join(", ")}.`);
    }
    const player = requested ? PLAYERS[requested] : pickPlayer(listen.player, LISTEN_PLAYERS);
    if (!player?.available()) {
        throw new Error("No Moment player available (afplay, VLC, ffplay).");
    }
    const { slice } = options;
    const argv = [
        "ffmpeg",
        "-v",
        "error",
        "-nostdin",
        "-ss",
        String(slice.fileFromSec),
        "-i",
        slice.path,
        "-t",
        String(slice.fileToSec - slice.fileFromSec),
        ...(slice.channel === undefined ? [] : ["-af", `pan=mono|c0=c${slice.channel}`]),
        "-c:a",
        "pcm_s16le",
        "-f",
        "wav",
        "pipe:1",
    ];
    const decodePipeline =
        'decoder_length="$1"; shift; decoder_argv=("${@:1:decoder_length}"); shift "$decoder_length"; "${decoder_argv[@]}" | "$@"';
    const pipeline = options.detached
        ? `trap 'trap - TERM INT EXIT; kill -TERM 0' TERM INT EXIT; ${decodePipeline} & wait "$!"`
        : decodePipeline;
    const child = Bun.spawn(
        [
            "/bin/bash",
            "-o",
            "pipefail",
            "-c",
            pipeline,
            "meeting-sound",
            String(argv.length),
            ...argv,
            ...player.clipArgv("/dev/stdin"),
        ],
        {
            stdin: "ignore",
            stdout: "ignore",
            stderr: options.detached ? "ignore" : "pipe",
            detached: options.detached ?? false,
            timeout: 3_600_000,
        }
    );
    if (options.detached) {
        child.unref();
        return { pid: child.pid, player: player.id };
    }
    const errors = child.stderr ? new Response(child.stderr).text() : Promise.resolve("");
    const [code, stderr] = await Promise.all([child.exited, errors]);
    if (code !== 0) {
        throw new Error(`Sound playback failed (exit ${code}): ${stderr.trim()}`);
    }
    return { pid: child.pid, player: player.id };
}

export async function playbackSlice(options: {
    opened: OpenedMeeting;
    atSec: number;
    fromSec: number;
    toSec?: number;
    track?: TrackKind;
}): Promise<SoundSlice> {
    const { opened, atSec, fromSec, track } = options;
    const sound = await opened.sound();
    let seat: "mic" | "call" | undefined = track ? sound.tracks.find((one) => one.kind === track)?.seat : undefined;
    if (!seat && !track) {
        const entries = (await opened.meeting()).transcript;
        const energy = await opened.energy();
        const evidence = await opened.evidence();
        const lines = lineEvidence(entries, evidence ?? { segments: [], speaking: [] }, undefined, energy.share);
        const line = lines.find((line) => line.startSec <= atSec && atSec < line.endSec);
        const share = line?.micShare ?? line?.energyMic;
        seat = share === undefined || share === 0.5 ? undefined : share > 0.5 ? "mic" : "call";
    }
    if (!seat) {
        throw new Error("No known seat at this time; choose --track with a track listed by show.");
    }
    const preferred = sound.slice({
        seat,
        fromSec: atSec,
        toSec: atSec + 0.001,
        purpose: "listen",
        ...(track ? { track } : {}),
    });
    const end =
        options.toSec ??
        sound.tracks
            .find((one) => one.kind === preferred?.track)
            ?.pieces.find(
                (piece) =>
                    piece.path === preferred?.path &&
                    piece.zeroSec <= atSec &&
                    atSec < piece.zeroSec + piece.durationSec
            )?.durationSec;
    const zero =
        sound.tracks
            .find((one) => one.kind === preferred?.track)
            ?.pieces.find((piece) => piece.path === preferred?.path)?.zeroSec ?? 0;
    const slice =
        end !== undefined && Number.isFinite(end)
            ? sound.slice({
                  seat,
                  fromSec,
                  toSec: options.toSec ?? end + zero,
                  purpose: "listen",
                  ...(track ? { track } : {}),
              })
            : undefined;
    if (!slice) {
        throw new Error("No audible track covers this interval; choose a shorter interval or another --track.");
    }
    return slice;
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
        return opts.clip || opts.save || opts.moment ? { target: { kind: "time", atSec } } : { atSec };
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

    const tone = typeof opts.tone === "string" ? toneFlag(opts.tone) : undefined;

    if (tone && "error" in tone) {
        fail(tone.error);
        return;
    }

    const toneSound = tone?.sound;
    const overrides: { padSec?: number; padAfterSec?: number; lengthSec?: number; screen?: false } = {};
    for (const [flag, value, key] of [
        ["--pad-before", opts.padBefore, "padSec"],
        ["--pad-after", opts.padAfter, "padAfterSec"],
        ["--length", opts.length, "lengthSec"],
    ] as const) {
        if (value === undefined) {
            continue;
        }

        const parsed = seconds(value);
        if (parsed === undefined || (key === "lengthSec" && parsed === 0)) {
            fail(`${flag} needs ${key === "lengthSec" ? "a positive" : "a non-negative"} number of seconds.`);
            return;
        }

        overrides[key] = parsed;
    }

    if (opts.screen === false) {
        overrides.screen = false;
    }

    if (opts.save) {
        const saved = await withMeetingsClient((client) =>
            client.call("moment.save", {
                meeting: record.id,
                target,
                ...overrides,
                ...(toneSound ? { toneSound, tone: true } : {}),
                ...(opts.tone === false ? { tone: false } : {}),
                ...(opts.title ? { title: opts.title } : {}),
                ...(opts.quote ? { quote: opts.quote } : {}),
            })
        );
        opts.json
            ? out.result(SafeJSON.stringify(saved, null, 2))
            : ui.ok(`Saved ${saved.entry.title}: ${saved.clip.path}`);
        return;
    }

    if (opts.start === false) {
        const planned = await withMeetingsClient((client) =>
            client.call("moment.plan", {
                meeting: record.id,
                target,
                ...(toneSound ? { toneSound } : {}),
                ...(opts.tone === false ? { tone: false } : {}),
                ...overrides,
            })
        );

        if (!planned.moment) {
            fail(`[${planned.cannot?.code}] ${planned.cannot?.message}`);
            return;
        }

        opts.json ? out.result(SafeJSON.stringify(planned.moment, null, 2)) : out.println(momentLine(planned.moment));
        return;
    }

    if (
        opts.window &&
        !opts.clip &&
        !opts.json &&
        opts.player === undefined &&
        (await playInOpenWindow({
            meeting: record.id,
            target,
            ...(toneSound ? { toneSound } : {}),
            ...(opts.tone === false ? { tone: false } : {}),
            ...overrides,
        }))
    ) {
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
        client.call("moment.clip", {
            meeting: record.id,
            target,
            ...(toneSound ? { toneSound } : {}),
            ...(opts.tone === false ? { tone: false } : {}),
            ...overrides,
        })
    );

    if (cut.tone?.sound.fallback && !opts.json) {
        ui.warn(cut.tone.sound.fallback);
    }
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
    if (opts.save && (opts.clip || opts.start === false || opts.window || opts.player !== undefined)) {
        fail("--save keeps a clip without playing it; omit --clip, --no-start, --window and --player.");
        return;
    }
    if (!opts.save && (opts.title !== undefined || opts.quote !== undefined)) {
        fail("--title and --quote describe a saved clip; add --save.");
        return;
    }
    const what = wanted(opts);

    if ("error" in what) {
        fail(what.error);
        return;
    }

    let track: TrackKind | undefined;
    if (opts.track !== undefined) {
        track = TRACK_KINDS.find((kind) => kind === opts.track);
        if (!track) {
            fail(`--track needs ${TRACK_KINDS.join(", ")}. Try: ${TOOL} play ${ref} --at 10 --track source-mic`);
            return;
        }
        if ("target" in what && what.target.kind !== "range") {
            fail("--track takes a time or --at/--to range; omit --item, --target and --moment.");
            return;
        }
        if (
            opts.save ||
            opts.clip ||
            opts.tone !== undefined ||
            opts.window ||
            opts.padBefore !== undefined ||
            opts.padAfter !== undefined ||
            opts.length !== undefined ||
            opts.screen === false
        ) {
            fail(
                "--track plays the original track; omit Moment-only flags (--save, --clip, --tone, --window, --pad-before, --pad-after, --length, --no-screen)."
            );
            return;
        }
    }

    if (opts.tone !== undefined && !("target" in what)) {
        fail("--tone sets a Moment's tone; --at alone plays on from there without one (add --moment, --to or --clip).");
        return;
    }

    if (
        !("target" in what) &&
        (opts.padBefore !== undefined ||
            opts.padAfter !== undefined ||
            opts.length !== undefined ||
            opts.screen === false)
    ) {
        fail("--pad-before, --pad-after, --length and --no-screen require a Moment (add --moment, --to or --clip).");
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

        if ("target" in what && !track) {
            await playMoment(record, what.target, opts);
            return;
        }

        const atSec = "atSec" in what ? what.atSec : what.target.kind === "range" ? what.target.fromSec : 0;
        const playback = (await new MeetingsConfigStore().read()).global.playback;
        const slice = await playbackSlice({
            opened: OpenedMeeting.of(store, record),
            atSec,
            fromSec: Math.max(0, atSec - (beforeSec ?? (track && "target" in what ? 0 : playback.beforeSec))),
            ...("target" in what && what.target.kind === "range" ? { toSec: what.target.toSec } : {}),
            ...(track ? { track } : {}),
        });
        const selectedPlayer = opts.player ?? pickPlayer(playback.player, MEETING_PLAYERS)?.id;
        let started: Awaited<ReturnType<typeof playSoundSlice>> | undefined;
        if (opts.start !== false) {
            started = await playSoundSlice({
                slice,
                player: selectedPlayer,
                detached: true,
            });
        }
        const shown = {
            ...slice,
            audioPath: slice.path,
            startSec: slice.fileFromSec,
            player: selectedPlayer,
            ...started,
        };
        opts.json
            ? out.result(SafeJSON.stringify(shown, null, 2))
            : ui.ok(
                  `${opts.start === false ? "Would play" : "Played"} ${record.id} on ${slice.track} from file second ${slice.fileFromSec} at source rate.`
              );
    } catch (err) {
        fail(new Error(momentFailure(err), { cause: err }));
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
        .argument("[time]", "transcript time, equivalent to --at")
        .description(
            "Play the meeting's audio from a transcript time, or the Moment of an item, a time or a range: a bounded clip with the tone before the asked spot"
        )
        .option("--at <time>", "transcript time: 1:23:50, 23:50 or seconds; alone it plays on from there")
        .option(
            "--track [kind]",
            `audio track: ${TRACK_KINDS.join(", ")}; absent uses the best track of the line's seat`
        )
        .option("--to <time>", "with --at: the Moment of the range from --at to this time")
        .option("--item <id>", "the Moment of an item: its id (i42) or a question's number (Q12, 12)")
        .option(
            "--target <json>",
            'any Moment target as JSON: {"kind":"selection","from":{"atSec":60,"fraction":0.5},"to":{"atSec":70}}, {"kind":"stretch","atSec":60}'
        )
        .option("--clip", "cut the Moment to a WAV in the clip cache and print it; plays nothing")
        .option(
            "--save",
            "save the clip under the meeting and list it in Context; no playback, tone or padding by default"
        )
        .option("--title <text>", "title for --save in the meeting's Context")
        .option("--quote <text>", "selected words to keep beside --save in Context")
        .option(
            "--moment",
            "with --at alone: play the Moment at that time (a bounded clip with the tone), not on from there"
        )
        .option("--window", "prefer the open Meetings window for a Moment; otherwise use the command player")
        .option("--before <sec>", "start this many seconds earlier (default: playback.beforeSec, 5); --at alone only")
        .option(
            "--tone <sound>",
            `a Moment's tone for this call: a preset (${TONE_PRESET_NAMES.join(", ")}), a sound file, or JSON ({"hz":440,"sec":0.2}); default playback.listen.tone.sound. It sounds even when playback.listen.tone.enabled is off`
        )
        .option("--no-tone", "suppress the tone for this Moment without changing the saved setting")
        .option("--pad-before <sec>", "this Moment's leading pad in seconds")
        .option("--pad-after <sec>", "this Moment's trailing pad in seconds")
        .option("--length <sec>", "limit this Moment's requested span to this many seconds, before padding")
        .option("--no-screen", "skip screen frames for this Moment")
        .option(
            "--player <id>",
            `this player for one call: ${MEETING_PLAYERS.join(", ")} for --at alone, ${LISTEN_PLAYERS.join(", ")} for a Moment`
        )
        .option(
            "--json",
            "print the track, path, channel and file seconds, plus audioPath/startSec/player and pid when started; for a Moment the Moment with path, player and pid when made"
        )
        .option("--no-start", "resolve and start nothing (no sound); plan without cutting, including with --clip")
        .action((meeting: string, time: string | undefined, opts: PlayOptions) => {
            if (time !== undefined && opts.at !== undefined) {
                fail("Give the positional time or --at, not both.");
                return;
            }
            return play(meeting, { ...opts, ...(time === undefined ? {} : { at: time }) });
        });
}

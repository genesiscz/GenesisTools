import { LISTEN_PLAYERS, MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import { lineEvidence } from "@genesiscz/utils/transcribe/evidence";
import { TranscriptLines } from "@genesiscz/utils/transcribe/lines";
import type { OpenedMeeting } from "./opened-meeting";
import { PLAYERS, pickPlayer } from "./players";
import type { SoundSlice, TrackKind } from "./sound";

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
        // Find the one line spoken at atSec first (its end comes from the next line), then measure only that line.
        const entries = (await opened.meeting()).transcript;
        const transcript = new TranscriptLines(entries);
        const at = entries.findIndex((_, index) => {
            const span = transcript.span(index);
            return span !== undefined && span.fromSec <= atSec && atSec < span.toSec;
        });
        const startSec = entries[at]?.startSec;
        const line =
            startSec === undefined
                ? undefined
                : lineEvidence(
                      entries,
                      (await opened.evidence()) ?? { segments: [], speaking: [] },
                      undefined,
                      (await opened.energy()).share,
                      { window: { fromSec: startSec, toSec: startSec } }
                  ).find((one) => one.index === at);
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

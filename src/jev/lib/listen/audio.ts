import { type LiveSttSession, type LiveTranscriptEvent, openPcmSource } from "@genesiscz/utils/ai/stt";
import { isInteractive, suggestEnumFlag } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import { logger } from "@genesiscz/utils/logger";
import { capsuleLevelFromPcm, type VoiceCapsuleHandle } from "@genesiscz/utils/macos/voice-capsule";

const { log } = logger.scoped("jev-listen");

/**
 * `--capsule on|off`. On by default only when there is a live microphone and a terminal watching:
 * a piped run, a transcript replay or a file source has nobody in front of the screen, and an
 * overlay nobody sees is pure idle cost.
 */
export function resolveCapsule(options: { capsule?: string | boolean; pcmIn?: string }): boolean | undefined {
    const raw = options.capsule;
    if (raw === "off") {
        return false;
    }

    if (raw === "on" || raw === true) {
        return true;
    }

    if (typeof raw === "string") {
        ui.err(suggestEnumFlag("tools jev listen", "--capsule", ["on", "off"]));
        process.exitCode = 1;
        return undefined;
    }

    return (options.pcmIn ?? "mic") === "mic" && isInteractive();
}

/** The transcript side of the capsule: what Jev is hearing, as it hears it. */
export function showOnCapsule(capsule: VoiceCapsuleHandle | null, event: LiveTranscriptEvent): void {
    if (!capsule) {
        return;
    }

    switch (event.kind) {
        case "speech_start":
            capsule.send({ kind: "state", state: "listening" });
            return;
        case "partial":
            capsule.send({ kind: "partial", text: event.text });
            return;
        case "final":
            capsule.send({ kind: "final", text: event.text });
            return;
        case "error":
            capsule.send({ kind: "state", state: "error" });
            return;
        default:
            return;
    }
}

export async function pumpAudio(
    session: LiveSttSession,
    input: string,
    signal: AbortSignal,
    capsule: VoiceCapsuleHandle | null
): Promise<void> {
    const source = await openPcmSource({ input, sampleRateHz: 16000, signal });
    ui.info(`listening on ${source.label} (${source.sampleRateHz} Hz)`);
    let frames = 0;
    try {
        for await (const frame of source.frames()) {
            session.write(frame);
            // The capsule drops levels above 30 Hz itself, so the bars follow the voice without the
            // pump caring how fast the source paces frames.
            capsule?.send({ kind: "level", rms: capsuleLevelFromPcm(frame) });
            frames++;
        }
    } catch (error) {
        if (!signal.aborted) {
            throw error;
        }
    } finally {
        session.end();
        await source.close();
        log.info({ frames, source: source.label }, "audio pump finished");
    }
}

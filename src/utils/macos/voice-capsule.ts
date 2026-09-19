import { pcmRms } from "@genesiscz/utils/ai/stt";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { installedGenesisAppLauncher } from "./genesis-app";

const prof = profiler.scope("jev-listen");
const { log } = logger.scoped("voice-capsule");

/** At most this many `level` events reach the face per second; the rest are dropped. */
export const CAPSULE_LEVEL_HZ = 30;
const LEVEL_MIN_GAP_MS = 1000 / CAPSULE_LEVEL_HZ;
const CLOSE_GRACE_MS = 1000;
const LEVEL_FLOOR_DBFS = -58;
const LEVEL_CEILING_DBFS = -17;

export type CapsuleState = "idle" | "listening" | "thinking" | "acting" | "error";
export type CapsuleDecisionStatus = "would" | "act" | "hold" | "abstain" | "wake" | "stop" | "narrow";

export type VoiceCapsuleEvent =
    | { kind: "state"; state: CapsuleState }
    | { kind: "level"; rms: number }
    | { kind: "partial"; text: string }
    | { kind: "final"; text: string }
    | { kind: "decision"; status: CapsuleDecisionStatus; label?: string; probability?: number };

export interface VoiceCapsuleHandle {
    /** Never throws. A dropped event is logged, not raised into the caller's audio loop. */
    send(event: VoiceCapsuleEvent): void;
    close(): Promise<void>;
}

export interface OpenVoiceCapsuleOptions {
    theme?: "dark" | "light";
    position?: "bottom" | "top";
    /** "main" (default) or a zero-based `NSScreen.screens` index. */
    screen?: string;
    signal?: AbortSignal;
    /**
     * The GenesisTools.app launcher to spawn: a path, or null for "there is none". Omitted, the
     * installed bundle is looked up. Passing it lets a caller that already resolved the launcher
     * skip a second `existsSync`, and lets the tests drive the argv without an installed app.
     */
    launcher?: string | null;
}

/**
 * The `--capsule` face of GenesisTools.app as a JSON-lines sink.
 *
 * Returns null when there is no overlay to open (not macOS, the app is not installed, or the
 * launcher is disabled). That is a normal outcome, not an error: `jev listen` must still run on a
 * machine without the bundle, just without the capsule.
 */
export function openVoiceCapsule(options: OpenVoiceCapsuleOptions = {}): VoiceCapsuleHandle | null {
    const launcher = options.launcher ?? installedGenesisAppLauncher();
    if (!launcher) {
        log.info("no GenesisTools.app launcher; the voice capsule stays closed");
        return null;
    }

    // Two launcher stages, exactly as the microphone face is spawned: `GenesisTools <program>`
    // disclaims responsibility so the `--capsule` face runs as the signed bundle. A bare face
    // spawned from a terminal would draw under the terminal's identity instead.
    const argv = [launcher, launcher, "--capsule", "--theme", options.theme ?? "dark"];
    if (options.position) {
        argv.push("--position", options.position);
    }

    if (options.screen) {
        argv.push("--screen", options.screen);
    }

    log.info({ argv }, "spawning the voice capsule face");
    const stopSpawn = prof.start("capsule-spawn");
    const child = Bun.spawn(argv, { stdin: "pipe", stdout: "inherit", stderr: "pipe" });
    stopSpawn();
    watchExit(child);
    const handle = createHandle(child);
    options.signal?.addEventListener("abort", () => {
        void handle.close();
    });
    return handle;
}

type CapsuleChild = ReturnType<typeof Bun.spawn>;

function watchExit(child: CapsuleChild): void {
    void child.exited
        .then(async (code) => {
            const stderr = child.stderr ? await new Response(child.stderr as ReadableStream).text() : "";
            log.info({ pid: child.pid, code, stderr: stderr.trim().slice(0, 500) }, "voice capsule face exited");
        })
        .catch((error: unknown) => {
            log.debug({ error }, "voice capsule exit watch failed");
        });
}

function createHandle(child: CapsuleChild): VoiceCapsuleHandle {
    let lastLevelAt = 0;
    let dead = false;
    let closing: Promise<void> | undefined;

    return {
        send(event: VoiceCapsuleEvent): void {
            if (dead) {
                return;
            }

            if (event.kind === "level") {
                const now = Date.now();
                if (now - lastLevelAt < LEVEL_MIN_GAP_MS) {
                    return;
                }

                lastLevelAt = now;
            }

            const stdin = child.stdin;
            if (!stdin || typeof stdin === "number") {
                dead = true;
                log.debug("voice capsule stdin is not writable; dropping events");
                return;
            }

            try {
                stdin.write(serializeCapsuleEvent(event));
                stdin.flush();
            } catch (error) {
                // The face is gone (EPIPE) or the pipe is closed. The capsule is decoration: the
                // listen loop must not fail because the overlay died.
                dead = true;
                log.warn({ error, kind: event.kind }, "voice capsule write failed; dropping further events");
            }
        },

        close(): Promise<void> {
            closing ??= closeChild(child, () => {
                dead = true;
            });
            return closing;
        },
    };
}

async function closeChild(child: CapsuleChild, markDead: () => void): Promise<void> {
    markDead();
    try {
        if (child.stdin && typeof child.stdin !== "number") {
            child.stdin.end();
        }
    } catch (error) {
        log.debug({ error }, "voice capsule stdin close failed");
    }

    if (child.exitCode !== null) {
        return;
    }

    // Closing stdin is the documented way the face stops, so give it a bounded moment to do that
    // before escalating. Every wait here has a deadline.
    await Promise.race([child.exited, Bun.sleep(CLOSE_GRACE_MS)]);
    if (child.exitCode !== null) {
        return;
    }

    child.kill("SIGTERM");
    await Promise.race([child.exited, Bun.sleep(CLOSE_GRACE_MS)]);
    if (child.exitCode === null) {
        log.warn({ pid: child.pid }, "voice capsule face ignored SIGTERM; killing it");
        child.kill("SIGKILL");
    }
}

/** One JSON object per line, with a trailing newline: the face reads line by line. */
export function serializeCapsuleEvent(event: VoiceCapsuleEvent): string {
    const body: Record<string, string | number> = { kind: event.kind };
    switch (event.kind) {
        case "state":
            body.state = event.state;
            break;
        case "level":
            body.rms = clampLevel(event.rms);
            break;
        case "partial":
        case "final":
            body.text = event.text;
            break;
        case "decision":
            body.status = event.status;
            if (event.label !== undefined) {
                body.label = event.label;
            }

            if (event.probability !== undefined) {
                body.probability = event.probability;
            }

            break;
    }

    // Strict mode: the face parses with JSONSerialization, which rejects comments and trailing
    // commas, and a line must hold exactly one object.
    return `${SafeJSON.stringify(body, { strict: true })}\n`;
}

/**
 * The 0..1 loudness the capsule's bars are drawn from, for one raw PCM frame.
 *
 * Raw RMS is the wrong number to send: ordinary speech sits around 0.05..0.25 linear, and the bar
 * height is `level * PILL_HEIGHT * 0.40`, so bars driven by raw RMS never leave their 4 pt floor —
 * measured on a real Deepgram fixture, whose loudest frame was 0.219. The prototype's levels come
 * from the same dBFS mapping as `voice_agent.level_from_pcm`: -58 dBFS reads as silence, -17 dBFS
 * as full. That is what makes a syllable reach the top of the pill.
 */
export function capsuleLevelFromPcm(pcm: Uint8Array): number {
    const rms = pcmRms(pcm);
    if (rms <= 0) {
        return 0;
    }

    const dbfs = 20 * Math.log10(rms);
    return clampLevel((dbfs - LEVEL_FLOOR_DBFS) / (LEVEL_CEILING_DBFS - LEVEL_FLOOR_DBFS));
}

function clampLevel(rms: number): number {
    if (!Number.isFinite(rms)) {
        return 0;
    }

    return Math.min(1, Math.max(0, rms));
}

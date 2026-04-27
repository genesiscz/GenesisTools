import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import logger from "@app/logger";

let _ffplayCache: boolean | null = null;

export function isFfplayAvailable(): boolean {
    if (_ffplayCache === null) {
        const path = Bun.which("ffplay");
        _ffplayCache = !!path;
    }

    return _ffplayCache;
}

export interface PlayOptions {
    volume?: number;
    wait?: boolean;
}

export async function playBuffer(audio: Buffer, contentType: string, opts?: PlayOptions): Promise<void> {
    const volume = clampVolume(opts?.volume);

    if (audio.length === 0) {
        return;
    }

    if (isFfplayAvailable()) {
        await runFfplayWithBuffer(audio, volume, opts?.wait, contentType);
        return;
    }

    await runAfplayFromTmpFile(audio, contentType, volume, opts?.wait);
}

export async function playStream(
    audio: AsyncIterable<Uint8Array>,
    contentType: string,
    opts?: PlayOptions
): Promise<void> {
    const volume = clampVolume(opts?.volume);

    if (isFfplayAvailable()) {
        await runFfplayWithStream(audio, volume, opts?.wait, contentType);
        return;
    }

    const chunks: Uint8Array[] = [];

    for await (const chunk of audio) {
        chunks.push(chunk);
    }

    const combined = Buffer.concat(chunks);
    await runAfplayFromTmpFile(combined, contentType, volume, opts?.wait);
}

function clampVolume(v: number | undefined): number {
    if (v == null) {
        return 1;
    }

    const normalized = v > 1 ? v / 100 : v;
    return Math.max(0, Math.min(1, normalized));
}

/**
 * Build ffplay argument list for streaming stdin.
 * PCM16 24kHz mono (audio/pcm) needs explicit format hints — ffplay cannot
 * auto-detect raw PCM from stdin with no magic bytes.
 */
function ffplayArgs(volume: number, contentType?: string): string[] {
    const base = ["-hide_banner", "-nodisp", "-autoexit", "-loglevel", "error", "-af", `volume=${volume}`];

    if (contentType?.includes("pcm")) {
        // Raw signed 16-bit little-endian PCM at 24kHz mono
        return [...base, "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", "-"];
    }

    return [...base, "-i", "-"];
}

async function runFfplayWithBuffer(
    audio: Buffer,
    volume: number,
    wait: boolean | undefined,
    contentType?: string
): Promise<void> {
    const proc = Bun.spawn(["ffplay", ...ffplayArgs(volume, contentType)], {
        stdin: "pipe",
        stdout: "ignore",
        stderr: "ignore",
    });

    const sink = proc.stdin;

    if (!sink) {
        throw new Error("ffplay: stdin pipe unavailable");
    }

    sink.write(new Uint8Array(audio));
    await sink.end();

    if (wait) {
        await proc.exited;
    }
}

async function runFfplayWithStream(
    audio: AsyncIterable<Uint8Array>,
    volume: number,
    wait: boolean | undefined,
    contentType?: string
): Promise<void> {
    const proc = Bun.spawn(["ffplay", ...ffplayArgs(volume, contentType)], {
        stdin: "pipe",
        stdout: "ignore",
        stderr: "ignore",
    });

    const sink = proc.stdin;

    if (!sink) {
        throw new Error("ffplay: stdin pipe unavailable");
    }

    const finish = async (): Promise<void> => {
        try {
            for await (const chunk of audio) {
                sink.write(chunk);
            }
        } finally {
            await sink.end();
        }
    };

    if (wait) {
        await finish();
        await proc.exited;
    } else {
        finish().catch((err) => logger.debug(`playStream pump error: ${err}`));
    }
}

async function runAfplayFromTmpFile(
    audio: Buffer,
    contentType: string,
    volume: number,
    wait: boolean | undefined
): Promise<void> {
    const ext = pickExtension(contentType);
    const tmpFile = join(tmpdir(), `genesis-play-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    await Bun.write(tmpFile, audio);

    const args = ["afplay", "-v", String(volume), tmpFile];
    const proc = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });

    const cleanup = (): void => {
        try {
            if (existsSync(tmpFile)) {
                unlinkSync(tmpFile);
            }
        } catch {
            /* best-effort */
        }
    };

    if (wait) {
        await proc.exited;
        cleanup();
    } else {
        proc.exited.then(cleanup);
    }
}

function pickExtension(contentType: string): string {
    const ct = contentType.toLowerCase();

    if (ct.includes("mpeg") || ct.includes("mp3")) {
        return ".mp3";
    }

    if (ct.includes("wav")) {
        return ".wav";
    }

    if (ct.includes("aiff")) {
        return ".aiff";
    }

    if (ct.includes("ogg") || ct.includes("opus")) {
        return ".ogg";
    }

    if (ct.includes("pcm")) {
        return ".pcm";
    }

    return ".mp3";
}

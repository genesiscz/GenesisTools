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
    /** User-visible volume on the same scale as `afplay -v` and `say [[volm V]]`: 0..1 (also accepts 0..100). */
    volume?: number;
    /**
     * Loudness offset in dB to compensate for sources mastered quieter than native synthesis.
     * Cloud TTS providers (e.g. xAI mp3) need a positive offset to match macOS `say` perceived loudness.
     * The limiter chain prevents the boost from ever clipping.
     */
    gainDb?: number;
    /**
     * Playback speed multiplier (1.0 = original). Implemented via ffmpeg's `atempo` filter, which
     * preserves pitch — no chipmunk effect. ffmpeg auto-chains `atempo` for ratios outside its
     * single-instance 0.5..2.0 range. Ignored on the afplay fallback path (no equivalent knob).
     */
    tempo?: number;
    wait?: boolean;
}

const PEAK_CEILING = 0.97; // -0.3 dBFS — alimiter ceiling that prevents inter-sample clipping
const MAX_GAIN_DB = 24;
const MIN_TEMPO = 0.25;
const MAX_TEMPO = 4;

export async function playBuffer(audio: Buffer, contentType: string, opts?: PlayOptions): Promise<void> {
    if (audio.length === 0) {
        return;
    }

    if (isFfplayAvailable()) {
        await runFfplayWithBuffer(audio, opts, contentType);
        return;
    }

    await runAfplayFromTmpFile(audio, contentType, afplayVolume(opts), opts?.wait);
}

export async function playStream(
    audio: AsyncIterable<Uint8Array>,
    contentType: string,
    opts?: PlayOptions
): Promise<void> {
    if (isFfplayAvailable()) {
        await runFfplayWithStream(audio, opts, contentType);
        return;
    }

    const chunks: Uint8Array[] = [];

    for await (const chunk of audio) {
        chunks.push(chunk);
    }

    const combined = Buffer.concat(chunks);
    await runAfplayFromTmpFile(combined, contentType, afplayVolume(opts), opts?.wait);
}

function userVolumeLinear(v: number | undefined): number {
    if (v == null) {
        return 1;
    }

    const normalized = v > 1 ? v / 100 : v;
    return Math.max(0, Math.min(1, normalized));
}

function clampGainDb(db: number | undefined): number {
    if (db == null || !Number.isFinite(db)) {
        return 0;
    }

    return Math.max(0, Math.min(MAX_GAIN_DB, db));
}

/**
 * afplay can't limit, so we fold the gain into the linear volume and rely on afplay's headroom.
 * macOS afplay accepts -v > 1; clipping risk is real, but ffplay is the primary path and
 * almost always available. Cap the linear factor so grossly-misconfigured gains don't blast
 * speakers — 4× linear is the same ceiling as the alimiter chain.
 */
function afplayVolume(opts: PlayOptions | undefined): number {
    const linear = userVolumeLinear(opts?.volume);
    const gainLinear = 10 ** (clampGainDb(opts?.gainDb) / 20);
    return Math.max(0, Math.min(4, linear * gainLinear));
}

/**
 * Build ffplay argument list for streaming stdin.
 * PCM16 24kHz mono (audio/pcm) needs explicit format hints — ffplay cannot
 * auto-detect raw PCM from stdin with no magic bytes.
 */
function ffplayArgs(opts: PlayOptions | undefined, contentType?: string): string[] {
    const userVol = userVolumeLinear(opts?.volume);
    const gainDb = clampGainDb(opts?.gainDb);
    const tempo = clampTempo(opts?.tempo);
    const filter = buildFilterChain(userVol, gainDb, tempo);
    const base = ["-hide_banner", "-nodisp", "-autoexit", "-loglevel", "error", "-af", filter];

    if (contentType?.includes("pcm")) {
        return [...base, "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", "-"];
    }

    return [...base, "-i", "-"];
}

/**
 * Build the ffmpeg filter chain. Order matters: user volume → loudness offset → peak limiter →
 * tempo. Limiter sits *before* atempo so the boost can't push transients past -0.3 dBFS regardless
 * of speed. The limiter only engages on actual peaks — quiet samples pass through untouched, so
 * 50% stays linearly 50% and there is no audible compression at typical TTS levels.
 */
function buildFilterChain(userVolumeLinearValue: number, gainDb: number, tempo: number): string {
    const parts: string[] = [];

    if (userVolumeLinearValue !== 1) {
        parts.push(`volume=${userVolumeLinearValue.toFixed(4)}`);
    }

    if (gainDb > 0) {
        parts.push(`volume=${gainDb}dB`);
        parts.push(`alimiter=limit=${PEAK_CEILING}:level=disabled`);
    }

    if (tempo !== 1) {
        for (const segment of atempoChain(tempo)) {
            parts.push(`atempo=${segment.toFixed(4)}`);
        }
    }

    if (parts.length === 0) {
        return "anull";
    }

    return parts.join(",");
}

/**
 * Single ffmpeg `atempo` instance accepts ratios in [0.5, 100]. For values below 0.5 we chain
 * 0.5-multipliers (e.g. 0.4 → 0.5 * 0.8). For values above 2 a single instance still works in
 * modern ffmpeg, but quality is better when chained at ≤2x — so split anything above 2.
 */
function atempoChain(tempo: number): number[] {
    if (tempo >= 0.5 && tempo <= 2) {
        return [tempo];
    }

    const out: number[] = [];
    let remaining = tempo;

    while (remaining > 2) {
        out.push(2);
        remaining /= 2;
    }

    while (remaining < 0.5) {
        out.push(0.5);
        remaining /= 0.5;
    }

    out.push(remaining);
    return out;
}

function clampTempo(t: number | undefined): number {
    if (t == null || !Number.isFinite(t) || t === 1) {
        return 1;
    }

    return Math.max(MIN_TEMPO, Math.min(MAX_TEMPO, t));
}

async function runFfplayWithBuffer(audio: Buffer, opts: PlayOptions | undefined, contentType?: string): Promise<void> {
    const proc = Bun.spawn(["ffplay", ...ffplayArgs(opts, contentType)], {
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

    if (opts?.wait) {
        await proc.exited;
    }
}

async function runFfplayWithStream(
    audio: AsyncIterable<Uint8Array>,
    opts: PlayOptions | undefined,
    contentType?: string
): Promise<void> {
    const proc = Bun.spawn(["ffplay", ...ffplayArgs(opts, contentType)], {
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

    if (opts?.wait) {
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

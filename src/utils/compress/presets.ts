import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";
import { compressFrameSync, type ZstdParams } from "./zstd";

/**
 * Presets per kind of data. The numbers behind each default are in README.md ("Presets") and come from
 * `scripts/benchmarks/compress/presets.ts`; change a default only with a new run of that benchmark.
 */
export const PRESET_NAMES = ["text", "tree", "binary", "database", "media", "fast", "max"] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

export interface CompressPreset extends Required<Pick<ZstdParams, "level" | "long">> {
    name: PresetName;
    description: string;
    /** Input bytes per seekable frame. Small frames make tail reads cheap; large ones let long mode find repeats. */
    frameBytes: number;
    /** Frames start on a line. */
    lineAligned: boolean;
    /** Frames compressed at once. */
    threads: number;
    /** The data is already compressed: storing it again saves too little to be worth a second copy. */
    store: boolean;
}

const MiB = 1024 * 1024;

export const PRESETS: Record<PresetName, CompressPreset> = {
    text: {
        name: "text",
        description: "logs, JSON, JSONL, CSV, source files: line-aligned 4 MiB frames for cheap tail reads",
        level: 3,
        long: false,
        frameBytes: 4 * MiB,
        lineAligned: true,
        threads: 4,
        store: false,
    },
    tree: {
        name: "tree",
        description: "folders of source, node_modules, backups of transcripts: 32 MiB frames with long mode",
        // Long mode at level 6 saved 88.9% against 84.4% without it on node_modules/typescript, at 160 MB/s.
        level: 6,
        long: true,
        frameBytes: 32 * MiB,
        lineAligned: false,
        threads: 4,
        store: false,
    },
    binary: {
        name: "binary",
        description: "app bundles, executables, libraries, other binary formats",
        // Level 6 saved 68.9% against 66.5% at level 3 on a 60 MB executable, at a third of the speed.
        level: 3,
        long: true,
        frameBytes: 32 * MiB,
        lineAligned: false,
        threads: 4,
        store: false,
    },
    database: {
        name: "database",
        description: "SQLite and other page-structured stores (copy the database closed or with .backup first)",
        // Level 6 saved 86.2% against 83.5% at level 3 on a 22 MB SQLite file, at 2.6 times the CPU.
        level: 3,
        long: false,
        frameBytes: 16 * MiB,
        lineAligned: false,
        threads: 4,
        store: false,
    },
    media: {
        name: "media",
        description: "JPEG, HEIC, PNG, MP4, MOV, zip, gzip, zstd: already compressed, stored as they are",
        level: 1,
        long: false,
        frameBytes: 32 * MiB,
        lineAligned: false,
        threads: 4,
        store: true,
    },
    fast: {
        name: "fast",
        description: "level 1: when the time to write matters more than the size",
        level: 1,
        long: false,
        frameBytes: 4 * MiB,
        lineAligned: false,
        threads: 4,
        store: false,
    },
    max: {
        name: "max",
        description: "level 19 with long mode: archives written once and kept for long (about 25 MB/s per thread)",
        level: 19,
        long: true,
        frameBytes: 32 * MiB,
        lineAligned: false,
        threads: 8,
        store: false,
    },
};

export function isPresetName(value: string): value is PresetName {
    return (PRESET_NAMES as readonly string[]).includes(value);
}

/** Saving below this share means the data is already compressed (MEASURED on photos and video: 0.2% to 1.8%). */
export const MIN_USEFUL_SAVING = 0.03;
/**
 * `tools compress pack` refuses below this saving unless forced: a second copy that is barely smaller is not worth
 * the risk and the time (Martin's rule, 2026-10-13: compress only when it saves at least 30%).
 */
export const DEFAULT_MIN_SAVING = 0.3;
/** The measured savings behind the media default, quoted in every refusal so the reader sees why. */
export const MEASURED_MEDIA_NOTE =
    "measured 2026-10-13 with zstd -19 --long=27: .mov 1.1%, .mp4 0.2-0.9% (screen recordings 14-36%), .heic 0.2-1.9%, .jpg 0.2-4.4%, .png 0-5.4%, .wav 7.2%, .m4a 4.9%, .mp3 1.0%, .pdf 19-29%, .docx 4-8%, .xlsx 13.8%; text 43-94%";

const SAMPLE_BYTES = 1024 * 1024;

export type SniffedKind = "text" | "database" | "binary" | "compressed";

interface Signature {
    kind: SniffedKind;
    label: string;
    test: (head: Buffer) => boolean;
}

const startsWith = (bytes: number[]) => (head: Buffer) => bytes.every((byte, index) => head[index] === byte);

const SIGNATURES: Signature[] = [
    { kind: "compressed", label: "zstd", test: startsWith([0x28, 0xb5, 0x2f, 0xfd]) },
    { kind: "compressed", label: "gzip", test: startsWith([0x1f, 0x8b]) },
    { kind: "compressed", label: "xz", test: startsWith([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]) },
    { kind: "compressed", label: "bzip2", test: startsWith([0x42, 0x5a, 0x68]) },
    { kind: "compressed", label: "zip", test: startsWith([0x50, 0x4b, 0x03, 0x04]) },
    { kind: "compressed", label: "7z", test: startsWith([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) },
    { kind: "compressed", label: "jpeg", test: startsWith([0xff, 0xd8, 0xff]) },
    { kind: "compressed", label: "png", test: startsWith([0x89, 0x50, 0x4e, 0x47]) },
    { kind: "compressed", label: "gif", test: startsWith([0x47, 0x49, 0x46, 0x38]) },
    {
        kind: "compressed",
        label: "webp",
        test: (head) => head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP",
    },
    // ISO base media: HEIC, MP4, MOV, M4A all carry `ftyp` at byte 4.
    { kind: "compressed", label: "iso-media", test: (head) => head.toString("latin1", 4, 8) === "ftyp" },
    { kind: "compressed", label: "matroska", test: startsWith([0x1a, 0x45, 0xdf, 0xa3]) },
    { kind: "database", label: "sqlite", test: (head) => head.toString("latin1", 0, 16) === "SQLite format 3\0" },
    {
        kind: "binary",
        label: "mach-o",
        test: (head) => [0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(head.readUInt32BE(0)),
    },
    { kind: "binary", label: "elf", test: startsWith([0x7f, 0x45, 0x4c, 0x46]) },
    { kind: "binary", label: "pe", test: startsWith([0x4d, 0x5a]) },
];

/** Shannon entropy of a sample in bits per byte (8 = random, about 4 to 5 for text). */
export function entropyBitsPerByte(sample: Uint8Array): number {
    if (sample.length === 0) {
        return 0;
    }

    const counts = new Uint32Array(256);

    for (const byte of sample) {
        counts[byte]! += 1;
    }

    let bits = 0;

    for (const count of counts) {
        if (count > 0) {
            const share = count / sample.length;
            bits -= share * Math.log2(share);
        }
    }

    return bits;
}

/** True when the sample reads as text: no NUL bytes and almost no other control bytes. */
function looksLikeText(sample: Uint8Array): boolean {
    let control = 0;

    for (const byte of sample) {
        if (byte === 0) {
            return false;
        }

        if (byte < 9 || (byte > 13 && byte < 32)) {
            control += 1;
        }
    }

    return control <= sample.length * 0.001;
}

export interface Sniffed {
    kind: SniffedKind;
    /** What decided it: a signature (`jpeg`, `sqlite`), `text`, or `entropy`. */
    reason: string;
    entropy: number;
}

/** What kind of data a sample holds, from its first bytes and its entropy. */
export function sniffSample(sample: Uint8Array): Sniffed {
    const head = Buffer.from(sample.buffer, sample.byteOffset, Math.min(sample.length, 64));
    const padded = head.length >= 16 ? head : Buffer.concat([head, Buffer.alloc(16 - head.length)]);
    const entropy = entropyBitsPerByte(sample);
    const signature = SIGNATURES.find((candidate) => candidate.test(padded));

    if (signature) {
        return { kind: signature.kind, reason: signature.label, entropy };
    }

    if (looksLikeText(sample)) {
        return { kind: "text", reason: "text", entropy };
    }

    // Above 7.5 bits per byte nothing a general compressor does saves more than a few percent.
    return { kind: entropy > 7.5 ? "compressed" : "binary", reason: "entropy", entropy };
}

/** Up to `bytes` bytes from the start, the middle and the end of a file, so a header does not decide alone. */
export function sampleFile(path: string, bytes = SAMPLE_BYTES): Buffer {
    const fd = openSync(path, "r");

    try {
        const size = fstatSync(fd).size;
        const part = Math.ceil(bytes / 3);
        const offsets = size <= bytes ? [0] : [0, Math.floor(size / 2 - part / 2), size - part];
        const chunks: Buffer[] = [];

        for (const offset of offsets) {
            const chunk = Buffer.allocUnsafe(size <= bytes ? size : part);
            const read = readSync(fd, chunk, 0, chunk.length, offset);
            chunks.push(chunk.subarray(0, read));
        }

        return Buffer.concat(chunks);
    } finally {
        closeSync(fd);
    }
}

export interface PresetChoice {
    preset: CompressPreset;
    sniffed: Sniffed;
    /** Share of bytes a level-3 trial on the sample saved (0.25 = 25% smaller). */
    trialSaving: number;
    /** Set when compressing would save under {@link MIN_USEFUL_SAVING}. */
    warning?: string;
}

/** Saving of a quick level-3 trial on a sample: `1 - compressed / original`. */
export function trialSaving(sample: Uint8Array, params: ZstdParams = { level: 3 }): number {
    if (sample.length === 0) {
        return 0;
    }

    return 1 - compressFrameSync(sample, params).length / sample.length;
}

const KIND_PRESET: Record<SniffedKind, PresetName> = {
    text: "text",
    database: "database",
    binary: "binary",
    compressed: "media",
};

/**
 * Picks a preset for a file or folder: a folder is a `tree` (an `.app` bundle is `binary`), a file is sniffed (magic
 * bytes, then text, then entropy) and a level-3 trial on a 1 MiB sample checks the guess. A trial saving under 3%
 * turns any guess into `media` (store) with a warning.
 */
export function resolvePreset(path: string): PresetChoice {
    if (statSync(path).isDirectory()) {
        const name = basename(path).endsWith(".app") ? "binary" : "tree";
        return {
            preset: PRESETS[name],
            sniffed: { kind: "binary", reason: "folder", entropy: 0 },
            trialSaving: Number.NaN,
        };
    }

    const sample = sampleFile(path);
    const sniffed = sniffSample(sample);
    const saving = trialSaving(sample);
    const guessed = PRESETS[KIND_PRESET[sniffed.kind]];

    if (saving < MIN_USEFUL_SAVING) {
        return {
            preset: PRESETS.media,
            sniffed,
            trialSaving: saving,
            warning: `a trial saved ${(saving * 100).toFixed(2)}% (under ${MIN_USEFUL_SAVING * 100}%): the data is already compressed (${sniffed.reason})`,
        };
    }

    return { preset: guessed, sniffed, trialSaving: saving };
}

export interface TrialResult {
    preset: PresetName;
    level: number;
    long: boolean;
    saving: number;
    /** Input MB per second of CPU, one thread. */
    mbPerSecond: number;
}

export type TrialGoal = "ratio" | "speed" | "balanced";

/**
 * Compresses a sample with several presets and reports saving and speed, then picks by goal: `ratio` = most saved,
 * `speed` = fastest that saves at least 90% of the best saving, `balanced` = best saving per CPU second among those
 * within 95% of the best saving.
 */
export function tryPresets(
    sample: Uint8Array,
    {
        goal = "balanced",
        presets = ["fast", "text", "tree", "max"] as PresetName[],
    }: { goal?: TrialGoal; presets?: PresetName[] } = {}
): { results: TrialResult[]; pick: TrialResult } {
    const results = presets.map((name) => {
        const preset = PRESETS[name];
        const started = process.cpuUsage();
        const compressed = compressFrameSync(sample, { level: preset.level, long: preset.long });
        const used = process.cpuUsage(started);
        const seconds = Math.max((used.user + used.system) / 1e6, 1e-6);
        return {
            preset: name,
            level: preset.level,
            long: preset.long,
            saving: 1 - compressed.length / Math.max(sample.length, 1),
            mbPerSecond: sample.length / 1e6 / seconds,
        };
    });

    const best = Math.max(...results.map((result) => result.saving));
    const byGoal: Record<TrialGoal, () => TrialResult> = {
        ratio: () => results.reduce((a, b) => (b.saving > a.saving ? b : a)),
        speed: () =>
            results
                .filter((result) => result.saving >= best * 0.9)
                .reduce((a, b) => (b.mbPerSecond > a.mbPerSecond ? b : a)),
        balanced: () =>
            results
                .filter((result) => result.saving >= best * 0.95)
                .reduce((a, b) => (b.mbPerSecond * b.saving > a.mbPerSecond * a.saving ? b : a)),
    };

    return { results, pick: byGoal[goal]() };
}

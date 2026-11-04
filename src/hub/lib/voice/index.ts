import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentVoiceReceiptDto } from "@app/dev-dashboard/contract/agents";
import { logger } from "@genesiscz/utils/logger";
import { toolDataDir } from "@genesiscz/utils/storage/root";

const log = logger.child({ component: "hub/voice" });

/** The containers a phone clip comes in (expo-audio records AAC in an M4A container on iOS). */
export const VOICE_TYPES: Readonly<Record<string, string>> = {
    "audio/m4a": "m4a",
    "audio/x-m4a": "m4a",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/mpeg": "mp3",
};

/** The longest clip the walkie-talkie takes; a spoken instruction is short, and the body cap is 8 MB anyway. */
export const VOICE_MAX_BYTES = 8 * 1024 * 1024;

export class VoiceClipError extends Error {
    constructor(
        readonly status: 400 | 413 | 415,
        message: string
    ) {
        super(message);
        this.name = "VoiceClipError";
    }
}

export interface VoiceDeps {
    /** Where clips are kept; `~/.genesis-tools/dev-dashboard/voice/<day>/` when omitted. */
    dir(): string;
    /** Turns one stored clip into text with the Mac's transcription ladder (`ai.transcribe` task). */
    transcribe(path: string): Promise<{ text: string; provider: string; model: string }>;
}

export const realVoiceDeps: VoiceDeps = {
    dir: () => toolDataDir("dev-dashboard", "voice", new Date().toISOString().slice(0, 10)),
    async transcribe(path) {
        const { Transcriber } = await import("@genesiscz/utils/ai/tasks/Transcriber");
        const transcriber = await Transcriber.create({ app: "mobile-voice" });

        try {
            const result = await transcriber.transcribe(path, { format: "text" });
            return { text: result.text.trim(), provider: transcriber.providerType, model: transcriber.modelId };
        } finally {
            transcriber.dispose();
        }
    },
};

/**
 * The walkie-talkie's Mac half (F12): keep the clip, named by its content so a replayed upload is the same file, and
 * transcribe it. The text goes back to the phone for one check; sending it is a separate session send (M5).
 */
export async function transcribeVoiceClip(
    input: { bytes: Uint8Array; contentType: string },
    deps: VoiceDeps = realVoiceDeps
): Promise<AgentVoiceReceiptDto> {
    const type = input.contentType.split(";")[0].trim().toLowerCase();
    const extension = VOICE_TYPES[type];

    if (!extension) {
        throw new VoiceClipError(415, `expected one of ${Object.keys(VOICE_TYPES).join(", ")}`);
    }

    if (input.bytes.byteLength === 0) {
        throw new VoiceClipError(400, "empty clip");
    }

    if (input.bytes.byteLength > VOICE_MAX_BYTES) {
        throw new VoiceClipError(413, `a clip is limited to ${VOICE_MAX_BYTES} bytes`);
    }

    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const dir = deps.dir();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${sha256.slice(0, 16)}.${extension}`);

    if (!existsSync(path)) {
        writeFileSync(path, input.bytes, { mode: 0o600 });
    }

    const heard = await deps.transcribe(path);
    log.info(
        { path, bytes: input.bytes.byteLength, provider: heard.provider, chars: heard.text.length },
        "voice clip transcribed"
    );
    return { path, bytes: input.bytes.byteLength, sha256, ...heard };
}

/** The `.jsonl.zst` window of `session-model.ts`, loaded only for a compressed transcript: `node:zlib` costs a hook ~4 ms. */
import { readHead, readTailWindow } from "@genesiscz/utils/ai/transcripts/native-scan";

export function zstdWindow(path: string, bytes: number, from: "head" | "tail"): Buffer {
    return from === "head" ? readHead(path, bytes) : readTailWindow(path, bytes).buffer;
}

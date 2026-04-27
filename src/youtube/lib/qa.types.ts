import type { VideoId } from "@app/youtube/lib/video.types";

export interface QaChunk {
    id: number;
    videoId: VideoId;
    chunkIdx: number;
    text: string;
    startSec: number | null;
    endSec: number | null;
    embedding: Float32Array | null;
    embeddingDims: number | null;
    embedderModel: string | null;
    createdAt: string;
}

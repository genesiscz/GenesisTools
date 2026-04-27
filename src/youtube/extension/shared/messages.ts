import type { Channel, ChannelHandle, JobEvent, JobStage, PipelineJob, Transcript, Video, VideoId } from "@app/youtube/lib/types";
import type { ExtensionConfig } from "@ext/shared/types";

export type ExtensionRequest =
    | { type: "config:get" }
    | { type: "config:set"; apiBaseUrl: string }
    | { type: "api:listChannels" }
    | { type: "api:addChannel"; handle: ChannelHandle }
    | { type: "api:getVideo"; id: VideoId }
    | { type: "api:getTranscript"; id: VideoId; lang?: string; source?: "captions" | "ai" }
    | { type: "api:getSummary"; id: VideoId; mode: "short" | "timestamped" }
    | { type: "api:askVideo"; id: VideoId; question: string; topK?: number }
    | { type: "api:startPipeline"; target: string; targetKind?: "video" | "channel" | "url"; stages: JobStage[] }
    | { type: "api:getJob"; id: number };

export type ExtensionResponse =
    | { ok: true; data: unknown }
    | { ok: false; error: string };

export type ExtensionEvent =
    | { type: "job:event"; event: JobEvent }
    | { type: "ws:status"; connected: boolean };

export interface ExtensionApiMap {
    "config:get": ExtensionConfig;
    "config:set": ExtensionConfig;
    "api:listChannels": { channels: Channel[] };
    "api:addChannel": { added: ChannelHandle[] };
    "api:getVideo": { video: Video; transcripts: Transcript[] };
    "api:getTranscript": { transcript: Transcript };
    "api:getSummary": { short?: string; timestamped?: Array<{ startSec: number; endSec: number; text: string }> };
    "api:askVideo": { answer: string; citations: Array<{ videoId: string; chunkIdx: number; startSec: number | null; endSec: number | null }> };
    "api:startPipeline": { job: PipelineJob };
    "api:getJob": { job: PipelineJob };
}

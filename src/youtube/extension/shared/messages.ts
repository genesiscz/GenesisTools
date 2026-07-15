import type {
    Channel,
    ChannelHandle,
    JobEvent,
    JobStage,
    LlmEstimate,
    PipelineJob,
    SummaryFormat,
    SummaryLength,
    SummaryTone,
    TimestampedSummaryEntry,
    Transcript,
    Video,
    VideoComment,
    VideoId,
    VideoLongSummary,
} from "@app/youtube/lib/types";
import type { ExtensionConfig } from "@ext/shared/types";

export type ExtensionRequest =
    | { type: "config:get" }
    | { type: "config:set"; apiBaseUrl: string; serviceKey?: string }
    | { type: "api:listChannels" }
    | { type: "api:addChannel"; handle: ChannelHandle }
    | { type: "api:listVideos"; channel?: ChannelHandle; since?: string; limit?: number; includeShorts?: boolean }
    | { type: "api:getVideo"; id: VideoId }
    | { type: "api:getTranscript"; id: VideoId; lang?: string; source?: "captions" | "ai" }
    | { type: "api:getComments"; id: VideoId }
    | { type: "api:getSummary"; id: VideoId; mode: "short" | "timestamped" | "long" }
    | {
          type: "api:generateSummary";
          id: VideoId;
          mode: "short" | "timestamped" | "long";
          force?: boolean;
          provider?: string;
          model?: string;
          targetBins?: number;
          tone?: SummaryTone;
          format?: SummaryFormat;
          length?: SummaryLength;
      }
    | { type: "api:askVideo"; id: VideoId; question: string; topK?: number; provider?: string; model?: string }
    | { type: "api:startPipeline"; target: string; targetKind?: "video" | "channel" | "url"; stages: JobStage[] }
    | { type: "api:getJob"; id: number }
    | { type: "api:listModels" }
    | {
          type: "api:estimate";
          id: VideoId;
          mode: "short" | "timestamped" | "long";
          provider?: string;
          model?: string;
      };

export type ExtensionResponse = { ok: true; data: unknown } | { ok: false; error: string };

export type ExtensionEvent = { type: "job:event"; event: JobEvent } | { type: "ws:status"; connected: boolean };

export interface ExtensionApiMap {
    "config:get": ExtensionConfig;
    "config:set": ExtensionConfig;
    "api:listChannels": { channels: Channel[] };
    "api:addChannel": { added: ChannelHandle[] };
    "api:listVideos": { videos: Video[] };
    "api:getVideo": { video: Video; transcripts: Transcript[] };
    "api:getTranscript": { transcript: Transcript };
    "api:getComments": { comments: VideoComment[] };
    "api:getSummary": {
        summary?: string | TimestampedSummaryEntry[] | VideoLongSummary | null;
        mode?: "short" | "timestamped" | "long";
        cached?: boolean;
    };
    "api:generateSummary": {
        summary?: string | TimestampedSummaryEntry[] | VideoLongSummary | null;
        mode?: "short" | "timestamped" | "long";
        cached?: boolean;
        jobId?: number;
    };
    "api:askVideo": {
        answer: string;
        citations: Array<{ videoId: string; chunkIdx: number; startSec: number | null; endSec: number | null }>;
    };
    "api:startPipeline": { job: PipelineJob };
    "api:getJob": { job: PipelineJob };
    "api:listModels": {
        presets: Array<{ label: string; provider: string; model: string; subscription?: boolean }>;
        defaults: { summarize?: string | null; qa?: string | null; transcribe?: string | null; embed?: string | null };
    };
    "api:estimate": LlmEstimate;
}

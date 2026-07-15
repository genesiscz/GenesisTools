import type {
    AskCitation,
    Channel,
    ChannelHandle,
    JobEvent,
    JobStage,
    LedgerPage,
    LlmEstimate,
    LockedArtifact,
    PipelineJob,
    PromptPreset,
    QaHistoryItem,
    QaSource,
    ShareSummary,
    SummaryFormat,
    SummaryLength,
    SummaryTone,
    TimestampedSummaryEntry,
    Transcript,
    UsageSummary,
    Video,
    VideoComment,
    VideoId,
    VideoLongSummary,
    VideoReport,
    YtUser,
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
          presetId?: number;
          lang?: string;
      }
    | { type: "api:translateTranscript"; id: VideoId; lang: string }
    | { type: "api:patchMe"; outputLang?: string; ttsVoice?: string }
    | { type: "api:generateSummaryAudio"; id: VideoId; voice?: string }
    | {
          type: "api:askVideo";
          id: VideoId;
          question: string;
          topK?: number;
          provider?: string;
          model?: string;
          presetId?: number;
          sources?: QaSource[];
          scope?: "video" | "channel";
      }
    | { type: "api:setSpeakers"; id: VideoId; speakers: Array<{ idx: number; label: string }> }
    | { type: "api:startPipeline"; target: string; targetKind?: "video" | "channel" | "url"; stages: JobStage[] }
    | { type: "api:getJob"; id: number }
    | { type: "api:listModels" }
    | {
          type: "api:estimate";
          id: VideoId;
          mode: "short" | "timestamped" | "long";
          provider?: string;
          model?: string;
      }
    | { type: "api:register"; email: string; password: string }
    | { type: "api:login"; email: string; password: string }
    | { type: "api:logout" } // local-only: clears the stored token
    | { type: "api:me" }
    | { type: "api:topup"; amount?: number }
    | { type: "api:qaHistory"; id?: VideoId; limit?: number }
    | { type: "api:checkout"; packId: string }
    | { type: "api:ledger"; before?: number; limit?: number }
    | { type: "api:usageSummary" }
    | {
          type: "api:createShare";
          kind: "summary" | "qa";
          videoId: VideoId;
          mode?: "short" | "timestamped" | "long";
          qaHistoryId?: number;
      }
    | { type: "api:listShares" }
    | { type: "api:revokeShare"; slug: string }
    | { type: "api:listPresets"; kind?: "summary" | "insights" | "ask" }
    | { type: "api:createPreset"; name: string; kind: "summary" | "insights" | "ask"; instructions: string }
    | { type: "api:updatePreset"; id: number; name?: string; instructions?: string }
    | { type: "api:deletePreset"; id: number }
    | { type: "nav:openWatch"; id: string; t: number } // open watch page in a new tab (cross-video citation)
    | { type: "api:reportEstimate"; videoIds: string[] }
    | { type: "api:createReport"; videoIds: string[]; title?: string }
    | { type: "api:getReport"; id: number };

export type ExtensionResponse = { ok: true; data: unknown } | { ok: false; error: string };

export type ExtensionEvent = { type: "job:event"; event: JobEvent } | { type: "ws:status"; connected: boolean };

/** Window-bridge message: panel → content script. Empty `chapters` unmounts the ticks. */
export interface PlayerChaptersMessage {
    type: "player:chapters";
    videoId: string;
    chapters: Array<{ title: string; startSec: number }>;
}

/** Window-bridge message: content script → panel, 1 Hz playback position. */
export interface PlayerTimeMessage {
    type: "player:time";
    t: number;
}

export interface ExtensionApiMap {
    "config:get": ExtensionConfig;
    "config:set": ExtensionConfig;
    "api:listChannels": { channels: Channel[] };
    "api:addChannel": { added: ChannelHandle[] };
    "api:listVideos": { videos: Video[] };
    "api:getVideo": { video: Video; transcripts: Transcript[] };
    "api:getTranscript": { transcript: Transcript; speakerLabels?: Record<number, string> };
    "api:setSpeakers": { speakerLabels: Record<number, string> };
    "api:getComments": { comments: VideoComment[] };
    "api:getSummary":
        | (LockedArtifact & { mode?: "short" | "timestamped" | "long" })
        | {
              summary?: string | TimestampedSummaryEntry[] | VideoLongSummary | null;
              mode?: "short" | "timestamped" | "long";
              /** 2-letter ISO language the stored summary was generated in. */
              lang?: string;
              cached?: boolean;
              locked?: undefined;
          };
    "api:generateSummary": {
        summary?: string | TimestampedSummaryEntry[] | VideoLongSummary | null;
        mode?: "short" | "timestamped" | "long";
        /** 2-letter ISO language the summary was generated in. */
        lang?: string;
        cached?: boolean;
        jobId?: number;
        /** True when the call unlocked an existing shared artifact instead of generating. */
        reused?: boolean;
        creditsSpent?: number;
        credits?: number;
    };
    "api:translateTranscript": { transcript: Transcript; creditsSpent: number; credits: number };
    "api:patchMe": { user: YtUser };
    "api:generateSummaryAudio": { url: string; cached: boolean; creditsSpent: number; credits: number };
    "api:askVideo": {
        answer: string;
        citations: AskCitation[];
        creditsSpent: number;
        credits: number;
        historyId: number;
        /** Metadata for every distinct cited video — drives grouped citation headers. */
        citedVideos?: Record<string, { title: string; uploadDate: string | null; thumbUrl: string | null }>;
    };
    "api:startPipeline": { job: PipelineJob };
    "api:getJob": { job: PipelineJob };
    "api:listModels": {
        presets: Array<{ label: string; provider: string; model: string; subscription?: boolean }>;
        defaults: { summarize?: string | null; qa?: string | null; transcribe?: string | null; embed?: string | null };
    };
    "api:estimate": LlmEstimate;
    "api:register": { user: YtUser; token: string };
    "api:login": { user: YtUser; token: string };
    "api:logout": { ok: true };
    "api:me": { user: YtUser };
    "api:topup": { user: YtUser };
    "api:qaHistory": { items: QaHistoryItem[] };
    "api:checkout": { url: string };
    "api:ledger": LedgerPage;
    "api:usageSummary": UsageSummary;
    "api:createShare": { slug: string; url: string };
    "api:listShares": { shares: ShareSummary[] };
    "api:revokeShare": { revoked: boolean };
    "api:listPresets": { presets: PromptPreset[] };
    "api:createPreset": { preset: PromptPreset };
    "api:updatePreset": { preset: PromptPreset };
    "api:deletePreset": { deleted: boolean };
    "nav:openWatch": { opened: true };
    "api:reportEstimate": { creditCost: number; membersNeedingSummary: number; perMemberCost: Record<string, number> };
    "api:createReport": { report: ReportRecordShape; jobId: number; creditsSpent: number; credits: number };
    "api:getReport": { report: ReportRecordShape; members: Record<string, ReportMemberMeta> };
}

/** Wire shape of a stored report (subset of the server's report record). */
export interface ReportRecordShape {
    id: number;
    title: string;
    memberIds: string[];
    result: VideoReport | null;
    createdAt: string;
}

export interface ReportMemberMeta {
    title: string;
    uploadDate: string | null;
    thumbUrl: string | null;
}

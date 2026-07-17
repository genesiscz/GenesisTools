import type { ChannelHandle } from "@app/youtube/lib/channel.types";
import type { JobActivityKind, JobStage, JobStatus, JobTargetKind } from "@app/youtube/lib/jobs.types";
import type { QaSource } from "@app/youtube/lib/qa.types";
import type { Language, TranscriptSegment } from "@app/youtube/lib/transcript.types";
import type { TimestampedSummaryEntry, VideoId, VideoLongSummary } from "@app/youtube/lib/video.types";

export interface UpsertChannelInput {
    handle: ChannelHandle;
    channelId?: string | null;
    title?: string | null;
    description?: string | null;
    subscriberCount?: number | null;
    thumbUrl?: string | null;
}

export interface UpsertVideoInput {
    id: VideoId;
    channelHandle: ChannelHandle;
    title: string;
    description?: string | null;
    uploadDate?: string | null;
    durationSec?: number | null;
    viewCount?: number | null;
    likeCount?: number | null;
    language?: string | null;
    availableCaptionLangs?: string[];
    tags?: string[];
    isShort?: boolean;
    isLive?: boolean;
    thumbUrl?: string | null;
}

export interface ListVideosOpts {
    channel?: ChannelHandle;
    since?: string;
    includeShorts?: boolean;
    includeLive?: boolean;
    limit?: number;
    offset?: number;
}

export interface SetVideoBinaryPathInput {
    id: VideoId;
    kind: "audio" | "video" | "thumb";
    path: string | null;
    sizeBytes?: number;
}

export interface SetVideoSummaryInput {
    id: VideoId;
    kind: "short" | "timestamped" | "long";
    value: string | TimestampedSummaryEntry[] | VideoLongSummary;
    /** 2-letter ISO language the summary was generated in. Default `"en"`. */
    lang?: string;
}

export interface UpdateUserPrefsInput {
    outputLang?: string | null;
    ttsVoice?: string | null;
}

export interface SaveTranscriptInput {
    videoId: VideoId;
    lang: Language;
    source: "captions" | "ai";
    text: string;
    segments: TranscriptSegment[];
    durationSec?: number | null;
}

export interface GetTranscriptOpts {
    lang?: Language;
    source?: "captions" | "ai";
    preferLang?: Language[];
}

export interface SearchTranscriptsOpts {
    videoIds?: VideoId[];
    limit?: number;
    snippetChars?: number;
}

export type VideoSearchField = "title" | "description" | "tags";

export interface SearchVideosOpts {
    fields?: VideoSearchField[];
    channel?: ChannelHandle;
    limit?: number;
    includeShorts?: boolean;
    includeLive?: boolean;
}

export interface VideoSearchHit {
    videoId: VideoId;
    field: VideoSearchField;
    snippet: string;
    title: string;
    channelHandle: ChannelHandle;
}

export interface TranscriptSearchHit {
    videoId: VideoId;
    lang: Language;
    snippet: string;
    rank: number;
}

export interface UpsertQaChunkInput {
    videoId: VideoId;
    chunkIdx: number;
    text: string;
    startSec?: number | null;
    endSec?: number | null;
    embedding?: Float32Array | null;
    embedderModel?: string | null;
    /** Corpus the chunk came from. Default `"transcript"`. */
    source?: QaSource;
    /** Comment thread root id for comments chunks. */
    sourceRef?: string | null;
}

export interface EnqueueJobInput {
    targetKind: JobTargetKind;
    target: string;
    stages: JobStage[];
    parentJobId?: number | null;
    /** Requesting user, when the job was triggered by an authenticated request. Null for CLI/operator jobs. */
    userId?: number | null;
}

export interface ClaimJobOpts {
    stage?: JobStage;
}

export interface UpdateJobPartial {
    status?: JobStatus;
    currentStage?: JobStage | null;
    error?: string | null;
    progress?: number;
    progressMessage?: string | null;
    completedAt?: string | null;
}

export interface ListJobsOpts {
    status?: JobStatus;
    targetKind?: JobTargetKind;
    target?: string;
    parentJobId?: number;
    /** Only jobs attributed to this user (`jobs.user_id`). */
    userId?: number;
    limit?: number;
    offset?: number;
}

export interface PruneExpiredBinariesOpts {
    audioOlderThanDays?: number;
    videoOlderThanDays?: number;
    thumbOlderThanDays?: number;
}

export interface PruneExpiredBinariesResult {
    audio: number;
    video: number;
    thumb: number;
}

export interface RecordJobActivityInput {
    jobId: number;
    stage?: JobStage | null;
    kind: JobActivityKind;
    action?: string | null;
    provider?: string | null;
    model?: string | null;
    prompt?: string | null;
    response?: string | null;
    tokensIn?: number | null;
    tokensOut?: number | null;
    tokensTotal?: number | null;
    costUsd?: number | null;
    durationMs?: number | null;
    startedAt?: string | null;
    completedAt?: string | null;
    error?: string | null;
}

export type VideoLogKind = "summary:view" | "insights:view" | "transcript:view" | "comments:view";

export interface RecordVideoLogInput {
    kind: VideoLogKind;
    userId: number | null;
    videoId: string;
    meta?: Record<string, unknown> | null;
}

export interface VideoWatchRecord {
    id: number;
    userId: number | null;
    videoId: string;
    createdAt: string;
}

export interface VideoLogRecord {
    id: number;
    kind: VideoLogKind;
    userId: number | null;
    videoId: string;
    meta: Record<string, unknown> | null;
    createdAt: string;
}

export interface RecordAiCallInput {
    provider: string;
    model: string;
    action: string;
    videoId?: string | null;
    userId?: number | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    costUsd?: number | null;
    creditsCharged?: number | null;
    jobId?: number | null;
}

export interface AiCallRecord {
    id: number;
    provider: string;
    model: string;
    action: string;
    videoId: string | null;
    userId: number | null;
    inputTokens: number;
    outputTokens: number;
    costUsd: number | null;
    creditsCharged: number | null;
    jobId: number | null;
    createdAt: string;
}

export interface QueueStats {
    queued: number;
    running: number;
    perStage: Record<string, { queued: number; running: number }>;
    oldestQueuedAgeSec: number | null;
}

export type CollectionKind = "manual" | "dynamic";

export interface CollectionRecord {
    id: number;
    userId: number;
    name: string;
    kind: CollectionKind;
    /** Serialized `CollectionRule` for `kind='dynamic'`; null for manual collections. */
    ruleJson: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface CreateCollectionInput {
    userId: number;
    name: string;
    kind: CollectionKind;
    ruleJson?: string | null;
}

export interface AskThreadRecord {
    id: number;
    userId: number;
    collectionId: number;
    title: string;
    createdAt: string;
    updatedAt: string;
}

export type AskMessageRole = "user" | "assistant" | "tool";

export interface AskMessageRecord {
    id: number;
    threadId: number;
    role: AskMessageRole;
    content: string;
    toolName: string | null;
    toolArgsJson: string | null;
    createdAt: string;
}

export interface WatchlistEntry {
    id: number;
    userId: number;
    channelHandle: string;
    createdAt: string;
}

/** Cheap hydration record for list surfaces (history, collections, digest). */
export interface VideoLite {
    id: string;
    title: string;
    channelHandle: string;
    thumbUrl: string | null;
    uploadDate: string | null;
    durationSec: number | null;
    hasSummary: boolean;
    hasTranscript: boolean;
}

export interface UpsertSubscriptionInput {
    userId: number;
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
    planId: string;
    status: string;
    allowance: number;
    periodStart?: string | null;
    periodEnd?: string | null;
    periodStartBalance?: number;
    cancelAtPeriodEnd?: boolean;
}

export interface SubscriptionRecord {
    id: number;
    userId: number;
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
    planId: string;
    status: string;
    allowance: number;
    periodStart: string | null;
    periodEnd: string | null;
    periodStartBalance: number;
    cancelAtPeriodEnd: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface UpdateSubscriptionPartial {
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
    status?: string;
    allowance?: number;
    periodStart?: string | null;
    periodEnd?: string | null;
    periodStartBalance?: number;
    cancelAtPeriodEnd?: boolean;
}

export type PaymentKind = "pack" | "subscription" | "refund";
export type PaymentStatus = "succeeded" | "failed" | "refunded";

export interface RecordPaymentInput {
    userId: number | null;
    kind: PaymentKind;
    stripeRef: string;
    packId?: string | null;
    planId?: string | null;
    amountCents?: number | null;
    currency?: string | null;
    credits?: number | null;
    status: PaymentStatus;
}

export interface PaymentRecord {
    id: number;
    userId: number | null;
    kind: PaymentKind;
    stripeRef: string;
    packId: string | null;
    planId: string | null;
    amountCents: number | null;
    currency: string | null;
    credits: number | null;
    status: PaymentStatus;
    createdAt: string;
}

export type WebhookOutcome = "processed" | "skipped" | "duplicate" | "error";

export interface RecordWebhookLogInput {
    stripeEventId: string;
    type: string;
    payloadHash: string;
    outcome: WebhookOutcome;
    detail?: string | null;
}

export interface WebhookLogRecord {
    id: number;
    stripeEventId: string;
    type: string;
    payloadHash: string;
    outcome: WebhookOutcome;
    detail: string | null;
    createdAt: string;
}

export interface ReferralRecord {
    id: number;
    code: string;
    referrerUserId: number;
    refereeUserId: number;
    reward: number;
    offerFrom: string;
    offerTo: string;
    createdAt: string;
}

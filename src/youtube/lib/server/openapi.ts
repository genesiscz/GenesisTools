export interface OpenApiInfo {
    title: string;
    version: string;
    description?: string;
}

export interface OpenApiServer {
    url: string;
    description?: string;
}

export interface OpenApiSchema {
    type?: string | string[];
    format?: string;
    description?: string;
    items?: OpenApiSchema;
    properties?: Record<string, OpenApiSchema>;
    required?: string[];
    enum?: Array<string | number | boolean | null>;
    additionalProperties?: boolean | OpenApiSchema;
    oneOf?: OpenApiSchema[];
    anyOf?: OpenApiSchema[];
    allOf?: OpenApiSchema[];
    $ref?: string;
    example?: unknown;
    default?: unknown;
    pattern?: string;
    minimum?: number;
    maximum?: number;
    nullable?: boolean;
}

export interface OpenApiParameter {
    name: string;
    in: "path" | "query" | "header";
    required?: boolean;
    description?: string;
    schema: OpenApiSchema;
}

export interface OpenApiMediaType {
    schema: OpenApiSchema;
}

export interface OpenApiRequestBody {
    required?: boolean;
    description?: string;
    content: Record<string, OpenApiMediaType>;
}

export interface OpenApiResponse {
    description: string;
    content?: Record<string, OpenApiMediaType>;
}

export interface OpenApiOperation {
    operationId: string;
    summary: string;
    description?: string;
    tags?: string[];
    parameters?: OpenApiParameter[];
    requestBody?: OpenApiRequestBody;
    responses: Record<string, OpenApiResponse>;
}

export interface OpenApiPathItem {
    get?: OpenApiOperation;
    post?: OpenApiOperation;
    patch?: OpenApiOperation;
    delete?: OpenApiOperation;
    put?: OpenApiOperation;
    parameters?: OpenApiParameter[];
}

export interface OpenApiComponents {
    schemas: Record<string, OpenApiSchema>;
}

export interface OpenApiDocument {
    openapi: string;
    info: OpenApiInfo;
    servers: OpenApiServer[];
    tags?: Array<{ name: string; description?: string }>;
    paths: Record<string, OpenApiPathItem>;
    components: OpenApiComponents;
}

const API_VERSION = "2.0.0";

function ref(name: string): OpenApiSchema {
    return { $ref: `#/components/schemas/${name}` };
}

function arrayOf(schema: OpenApiSchema): OpenApiSchema {
    return { type: "array", items: schema };
}

function jsonBody(schema: OpenApiSchema, opts: { required?: boolean; description?: string } = {}): OpenApiRequestBody {
    return {
        required: opts.required,
        description: opts.description,
        content: { "application/json": { schema } },
    };
}

function jsonResponse(description: string, schema?: OpenApiSchema): OpenApiResponse {
    if (!schema) {
        return { description };
    }

    return { description, content: { "application/json": { schema } } };
}

const errorResponse = jsonResponse("Error", ref("Error"));

function nullableString(description?: string): OpenApiSchema {
    return { type: ["string", "null"], description };
}

function nullableNumber(description?: string): OpenApiSchema {
    return { type: ["number", "null"], description };
}

function nullableInteger(description?: string): OpenApiSchema {
    return { type: ["integer", "null"], description };
}

function buildSchemas(): Record<string, OpenApiSchema> {
    return {
        Error: {
            type: "object",
            properties: { error: { type: "string" } },
            required: ["error"],
        },
        ChannelHandle: {
            type: "string",
            pattern: "^@",
            description: "Channel handle, always prefixed with '@' (e.g. '@veritasium').",
            example: "@veritasium",
        },
        Channel: {
            type: "object",
            properties: {
                handle: ref("ChannelHandle"),
                channelId: nullableString(),
                title: nullableString(),
                description: nullableString(),
                subscriberCount: nullableInteger(),
                thumbUrl: nullableString(),
                lastSyncedAt: nullableString("ISO-8601 timestamp."),
                createdAt: { type: "string" },
                updatedAt: { type: "string" },
            },
            required: ["handle", "createdAt", "updatedAt"],
        },
        TranscriptSegment: {
            type: "object",
            properties: {
                text: { type: "string" },
                start: { type: "number", description: "Segment start in seconds." },
                end: { type: "number", description: "Segment end in seconds." },
                speaker: {
                    type: "integer",
                    description: "Diarized speaker index (0-based). Only on AI transcripts with diarization.",
                },
            },
            required: ["text", "start", "end"],
        },
        Transcript: {
            type: "object",
            properties: {
                id: { type: "integer" },
                videoId: { type: "string" },
                lang: { type: "string", description: "BCP-47-ish language code." },
                source: { type: "string", enum: ["captions", "ai"] },
                text: { type: "string" },
                segments: arrayOf(ref("TranscriptSegment")),
                durationSec: nullableNumber(),
                createdAt: { type: "string" },
            },
            required: ["id", "videoId", "lang", "source", "text", "segments", "createdAt"],
        },
        TimestampedSummaryEntry: {
            type: "object",
            properties: {
                startSec: { type: "number" },
                endSec: { type: "number" },
                icon: { type: "string", description: "Single emoji contextual icon (optional)." },
                title: { type: "string", description: "3-6 word headline (optional)." },
                question: { type: "string", description: "Present only when format = 'qa'." },
                text: { type: "string" },
            },
            required: ["startSec", "endSec", "text"],
        },
        VideoLongSummaryChapter: {
            type: "object",
            properties: {
                title: { type: "string" },
                summary: { type: "string" },
                startSec: {
                    type: "number",
                    description: "Second where the chapter's topic begins. Absent on old rows.",
                },
                endSec: nullableNumber("Second where the topic ends, or null. Absent on old rows."),
            },
            required: ["title", "summary"],
        },
        VideoLongSummary: {
            type: "object",
            properties: {
                tldr: { type: "string" },
                keyPoints: arrayOf({ type: "string" }),
                learnings: arrayOf({ type: "string" }),
                chapters: arrayOf(ref("VideoLongSummaryChapter")),
                conclusion: nullableString(),
            },
            required: ["tldr", "keyPoints", "learnings", "chapters", "conclusion"],
        },
        Video: {
            type: "object",
            properties: {
                id: { type: "string", description: "YouTube video id." },
                channelHandle: ref("ChannelHandle"),
                title: { type: "string" },
                description: nullableString(),
                uploadDate: nullableString(),
                durationSec: nullableInteger(),
                viewCount: nullableInteger(),
                likeCount: nullableInteger(),
                language: nullableString(),
                availableCaptionLangs: arrayOf({ type: "string" }),
                tags: arrayOf({ type: "string" }),
                isShort: { type: "boolean" },
                isLive: { type: "boolean" },
                thumbUrl: nullableString(),
                summaryShort: nullableString(),
                summaryTimestamped: {
                    type: ["array", "null"],
                    items: ref("TimestampedSummaryEntry"),
                },
                summaryLong: { oneOf: [ref("VideoLongSummary"), { type: "null" }] },
                audioPath: nullableString(),
                audioSizeBytes: nullableInteger(),
                audioCachedAt: nullableString(),
                videoPath: nullableString(),
                videoSizeBytes: nullableInteger(),
                videoCachedAt: nullableString(),
                thumbPath: nullableString(),
                thumbCachedAt: nullableString(),
                createdAt: { type: "string" },
                updatedAt: { type: "string" },
            },
            required: [
                "id",
                "channelHandle",
                "title",
                "availableCaptionLangs",
                "tags",
                "isShort",
                "isLive",
                "createdAt",
                "updatedAt",
            ],
        },
        PipelineJob: {
            type: "object",
            properties: {
                id: { type: "integer" },
                targetKind: { type: "string", enum: ["video", "channel", "url"] },
                target: { type: "string" },
                stages: arrayOf(ref("JobStage")),
                currentStage: { oneOf: [ref("JobStage"), { type: "null" }] },
                status: ref("JobStatus"),
                error: nullableString(),
                progress: { type: "number", description: "0..1 completion fraction." },
                progressMessage: nullableString(),
                parentJobId: nullableInteger(),
                workerId: nullableString(),
                claimedAt: nullableString(),
                createdAt: { type: "string" },
                updatedAt: { type: "string" },
                completedAt: nullableString(),
            },
            required: [
                "id",
                "targetKind",
                "target",
                "stages",
                "currentStage",
                "status",
                "progress",
                "createdAt",
                "updatedAt",
            ],
        },
        JobStage: {
            type: "string",
            enum: ["discover", "metadata", "captions", "audio", "video", "transcribe", "summarize"],
        },
        JobStatus: {
            type: "string",
            enum: ["pending", "running", "completed", "failed", "cancelled", "interrupted"],
        },
        JobActivity: {
            type: "object",
            properties: {
                id: { type: "integer" },
                jobId: { type: "integer" },
                stage: { oneOf: [ref("JobStage"), { type: "null" }] },
                kind: { type: "string", enum: ["llm", "embed", "transcribe"] },
                action: nullableString(),
                provider: nullableString(),
                model: nullableString(),
                prompt: nullableString(),
                response: nullableString(),
                tokensIn: nullableInteger(),
                tokensOut: nullableInteger(),
                tokensTotal: nullableInteger(),
                costUsd: nullableNumber(),
                durationMs: nullableInteger(),
                startedAt: nullableString(),
                completedAt: nullableString(),
                error: nullableString(),
                createdAt: { type: "string" },
            },
            required: ["id", "jobId", "kind", "createdAt"],
        },
        AskCitation: {
            type: "object",
            properties: {
                videoId: { type: "string" },
                chunkIdx: { type: "integer" },
                startSec: nullableNumber(),
                endSec: nullableNumber(),
            },
            required: ["videoId", "chunkIdx", "startSec", "endSec"],
        },
        SearchHit: {
            type: "object",
            properties: {
                kind: { type: "string", description: "'transcript', 'title', 'description', or 'tags'." },
                videoId: { type: "string" },
                snippet: { type: "string" },
                rank: { type: "number", description: "Present for transcript (FTS) hits." },
                lang: { type: "string", description: "Present for transcript hits." },
            },
            required: ["kind", "videoId", "snippet"],
        },
        CacheStats: {
            type: "object",
            properties: {
                channels: { type: "integer" },
                videos: { type: "integer" },
                transcripts: { type: "integer" },
                jobs: arrayOf(ref("PipelineJob")),
                audioBytes: { type: "integer" },
                videoBytes: { type: "integer" },
                thumbBytes: { type: "integer" },
            },
            required: ["channels", "videos", "transcripts", "jobs", "audioBytes", "videoBytes", "thumbBytes"],
        },
        YoutubeConfig: {
            type: "object",
            description: "Full effective config. PATCH accepts any deep-partial subset of this shape.",
            properties: {
                apiPort: { type: "integer" },
                apiBaseUrl: { type: "string" },
                provider: {
                    type: "object",
                    properties: {
                        transcribe: { type: "string" },
                        summarize: { type: "string" },
                        qa: { type: "string" },
                        embed: { type: "string" },
                    },
                    additionalProperties: true,
                },
                defaultQuality: { type: "string", enum: ["720p", "1080p", "best"] },
                concurrency: {
                    type: "object",
                    properties: {
                        download: { type: "integer" },
                        localTranscribe: { type: "integer" },
                        cloudTranscribe: { type: "integer" },
                        summarize: { type: "integer" },
                    },
                    additionalProperties: true,
                },
                ttls: {
                    type: "object",
                    properties: {
                        audio: { type: "string" },
                        video: { type: "string" },
                        thumb: { type: "string" },
                        channelListing: { type: "string" },
                    },
                    additionalProperties: true,
                },
                keepVideo: { type: "boolean" },
                firstRunComplete: { type: "boolean" },
                lastPruneAt: nullableString(),
                preferredLangs: arrayOf({ type: "string" }),
            },
            additionalProperties: true,
        },
    };
}

function buildPaths(): Record<string, OpenApiPathItem> {
    const handleParam: OpenApiParameter = {
        name: "handle",
        in: "path",
        required: true,
        description: "Channel handle (with or without leading '@').",
        schema: { type: "string" },
    };
    const videoIdParam: OpenApiParameter = {
        name: "id",
        in: "path",
        required: true,
        description: "YouTube video id.",
        schema: { type: "string" },
    };
    const jobIdParam: OpenApiParameter = {
        name: "id",
        in: "path",
        required: true,
        description: "Pipeline job id.",
        schema: { type: "integer" },
    };

    return {
        "/api/v1/channels": {
            get: {
                operationId: "listChannels",
                summary: "List tracked channels",
                tags: ["channels"],
                responses: {
                    "200": jsonResponse("Tracked channels", {
                        type: "object",
                        properties: { channels: arrayOf(ref("Channel")) },
                        required: ["channels"],
                    }),
                },
            },
            post: {
                operationId: "addChannels",
                summary: "Add one or more channels to track",
                description:
                    "Accepts any combination of `handle`, `handles`, and `fromFile`; handles are normalised to '@handle'.",
                tags: ["channels"],
                requestBody: jsonBody(
                    {
                        type: "object",
                        properties: {
                            handle: { type: "string", description: "Single channel handle." },
                            handles: arrayOf({ type: "string" }),
                            fromFile: arrayOf({ type: "string" }),
                        },
                    },
                    { description: "At least one of handle/handles/fromFile." }
                ),
                responses: {
                    "200": jsonResponse("Added channels", {
                        type: "object",
                        properties: { added: arrayOf(ref("ChannelHandle")) },
                        required: ["added"],
                    }),
                    "400": errorResponse,
                },
            },
        },
        "/api/v1/channels/{handle}": {
            delete: {
                operationId: "removeChannel",
                summary: "Stop tracking a channel",
                tags: ["channels"],
                parameters: [handleParam],
                responses: {
                    "200": jsonResponse("Removed channel", {
                        type: "object",
                        properties: { removed: ref("ChannelHandle") },
                        required: ["removed"],
                    }),
                },
            },
        },
        "/api/v1/channels/{handle}/sync": {
            post: {
                operationId: "syncChannel",
                summary: "Enqueue a discover+metadata sync for a channel",
                tags: ["channels"],
                parameters: [handleParam],
                responses: {
                    "200": jsonResponse("Enqueued sync job", {
                        type: "object",
                        properties: {
                            enqueuedJobIds: arrayOf({ type: "integer" }),
                            enqueuedJobId: { type: "integer" },
                        },
                        required: ["enqueuedJobIds", "enqueuedJobId"],
                    }),
                },
            },
        },
        "/api/v1/videos": {
            get: {
                operationId: "listVideos",
                summary: "List videos",
                tags: ["videos"],
                parameters: [
                    {
                        name: "channel",
                        in: "query",
                        description: "Filter by channel handle.",
                        schema: { type: "string" },
                    },
                    {
                        name: "since",
                        in: "query",
                        description: "Only videos uploaded on/after this date (ISO or YYYY-MM-DD).",
                        schema: { type: "string" },
                    },
                    {
                        name: "limit",
                        in: "query",
                        description: "Max rows (default 30).",
                        schema: { type: "integer", default: 30 },
                    },
                    {
                        name: "includeShorts",
                        in: "query",
                        description: "Include Shorts when 'true' (default false).",
                        schema: { type: "boolean", default: false },
                    },
                ],
                responses: {
                    "200": jsonResponse("Videos", {
                        type: "object",
                        properties: { videos: arrayOf(ref("Video")) },
                        required: ["videos"],
                    }),
                },
            },
        },
        "/api/v1/videos/search": {
            get: {
                operationId: "searchVideos",
                summary: "Full-text search across transcripts and metadata",
                tags: ["videos"],
                parameters: [
                    { name: "q", in: "query", description: "Search query.", schema: { type: "string" } },
                    {
                        name: "limit",
                        in: "query",
                        description: "Max hits (default 50).",
                        schema: { type: "integer", default: 50 },
                    },
                    {
                        name: "in",
                        in: "query",
                        description:
                            "Comma-separated fields to search: 'transcript', 'title', 'desc'/'description', 'tags' (default 'transcript').",
                        schema: { type: "string", default: "transcript" },
                    },
                    {
                        name: "channel",
                        in: "query",
                        description: "Restrict metadata search to a channel handle.",
                        schema: { type: "string" },
                    },
                ],
                responses: {
                    "200": jsonResponse("Search hits", {
                        type: "object",
                        properties: { hits: arrayOf(ref("SearchHit")) },
                        required: ["hits"],
                    }),
                },
            },
        },
        "/api/v1/videos/{id}": {
            get: {
                operationId: "getVideo",
                summary: "Get a video with its transcripts",
                tags: ["videos"],
                parameters: [videoIdParam],
                responses: {
                    "200": jsonResponse("Video detail", {
                        type: "object",
                        properties: {
                            video: ref("Video"),
                            transcripts: arrayOf(ref("Transcript")),
                        },
                        required: ["video", "transcripts"],
                    }),
                    "404": errorResponse,
                },
            },
        },
        "/api/v1/videos/{id}/transcript": {
            get: {
                operationId: "getVideoTranscript",
                summary: "Get a video transcript",
                description:
                    "Returns JSON by default. With `format=text|srt|vtt` the body is the raw transcript in that format (text/plain, application/x-subrip, text/vtt).",
                tags: ["videos"],
                parameters: [
                    videoIdParam,
                    { name: "lang", in: "query", description: "Preferred language code.", schema: { type: "string" } },
                    {
                        name: "source",
                        in: "query",
                        description: "Preferred source.",
                        schema: { type: "string", enum: ["captions", "ai"] },
                    },
                    {
                        name: "format",
                        in: "query",
                        description: "Output format (default 'json').",
                        schema: { type: "string", enum: ["json", "text", "srt", "vtt"], default: "json" },
                    },
                ],
                responses: {
                    "200": {
                        description: "Transcript",
                        content: {
                            "application/json": {
                                schema: {
                                    type: "object",
                                    properties: {
                                        transcript: ref("Transcript"),
                                        speakerLabels: {
                                            type: "object",
                                            description:
                                                "Custom speaker names keyed by diarized speaker index (empty when none set).",
                                            additionalProperties: { type: "string" },
                                        },
                                    },
                                    required: ["transcript"],
                                },
                            },
                            "text/plain": { schema: { type: "string" } },
                            "application/x-subrip": { schema: { type: "string" } },
                            "text/vtt": { schema: { type: "string" } },
                        },
                    },
                    "404": errorResponse,
                },
            },
        },
        "/api/v1/videos/{id}/speakers": {
            put: {
                operationId: "setVideoSpeakers",
                summary: "Upsert custom labels for diarized speakers",
                description:
                    "Stores per-video display names for diarized speaker indices (chips in the transcript UI).",
                tags: ["videos"],
                parameters: [videoIdParam],
                requestBody: jsonBody({
                    type: "object",
                    properties: {
                        speakers: arrayOf({
                            type: "object",
                            properties: {
                                idx: { type: "integer", description: "Diarized speaker index (0-based)." },
                                label: { type: "string", description: "Display name for the speaker." },
                            },
                            required: ["idx", "label"],
                        }),
                    },
                    required: ["speakers"],
                }),
                responses: {
                    "200": jsonResponse("Updated label map", {
                        type: "object",
                        properties: {
                            speakerLabels: { type: "object", additionalProperties: { type: "string" } },
                        },
                        required: ["speakerLabels"],
                    }),
                    "400": errorResponse,
                    "404": errorResponse,
                },
            },
        },
        "/api/v1/videos/{id}/summary": {
            get: {
                operationId: "getVideoSummary",
                summary: "Get a cached video summary",
                tags: ["videos"],
                parameters: [
                    videoIdParam,
                    {
                        name: "mode",
                        in: "query",
                        description: "Summary mode (default 'short').",
                        schema: { type: "string", enum: ["short", "timestamped", "long"], default: "short" },
                    },
                ],
                responses: {
                    "200": jsonResponse("Cached summary", {
                        type: "object",
                        properties: {
                            summary: {
                                description:
                                    "string (short), TimestampedSummaryEntry[] (timestamped), or VideoLongSummary (long).",
                                oneOf: [
                                    { type: "string" },
                                    arrayOf(ref("TimestampedSummaryEntry")),
                                    ref("VideoLongSummary"),
                                    { type: "null" },
                                ],
                            },
                            mode: { type: "string", enum: ["short", "timestamped", "long"] },
                            cached: { type: "boolean" },
                        },
                        required: ["summary", "mode", "cached"],
                    }),
                    "404": errorResponse,
                },
            },
            post: {
                operationId: "generateVideoSummary",
                summary: "Generate (or force-recompute) a video summary",
                description:
                    "Runs a synchronous pipeline job (captions if needed, then summarize) and returns the fresh summary. Job progress is also streamed over the /api/v1/events websocket.",
                tags: ["videos"],
                parameters: [videoIdParam],
                requestBody: jsonBody({
                    type: "object",
                    properties: {
                        mode: { type: "string", enum: ["short", "timestamped", "long"], default: "short" },
                        force: { type: "boolean", description: "Ignore cached summary for this mode." },
                        provider: { type: "string" },
                        model: { type: "string" },
                        tone: { type: "string", enum: ["insightful", "funny", "actionable", "controversial"] },
                        format: { type: "string", enum: ["list", "qa"] },
                        length: { type: "string", enum: ["short", "auto", "detailed"] },
                        targetBins: { type: "integer", description: "Override section count for 'timestamped'." },
                    },
                }),
                responses: {
                    "200": jsonResponse("Generated summary", {
                        type: "object",
                        properties: {
                            summary: {
                                oneOf: [
                                    { type: "string" },
                                    arrayOf(ref("TimestampedSummaryEntry")),
                                    ref("VideoLongSummary"),
                                    { type: "null" },
                                ],
                            },
                            mode: { type: "string", enum: ["short", "timestamped", "long"] },
                            cached: { type: "boolean" },
                            jobId: { type: "integer" },
                            startedAt: { type: "string" },
                        },
                        required: ["summary", "mode", "cached", "jobId", "startedAt"],
                    }),
                    "404": errorResponse,
                },
            },
        },
        "/api/v1/videos/{id}/qa": {
            post: {
                operationId: "askVideo",
                summary: "Ask a question about a video (RAG over its transcript)",
                description: "Requires an existing transcript (run the pipeline / transcribe first).",
                tags: ["videos"],
                parameters: [videoIdParam],
                requestBody: jsonBody(
                    {
                        type: "object",
                        properties: {
                            question: { type: "string" },
                            topK: { type: "integer", description: "Number of transcript chunks to retrieve." },
                            provider: { type: "string" },
                            model: { type: "string" },
                        },
                        required: ["question"],
                    },
                    { required: true }
                ),
                responses: {
                    "200": jsonResponse("Answer", {
                        type: "object",
                        properties: {
                            answer: { type: "string" },
                            citations: arrayOf(ref("AskCitation")),
                            jobId: { type: "integer" },
                        },
                        required: ["answer", "citations", "jobId"],
                    }),
                    "400": errorResponse,
                    "404": errorResponse,
                    "409": errorResponse,
                },
            },
        },
        "/api/v1/pipeline": {
            post: {
                operationId: "startPipeline",
                summary: "Enqueue a pipeline job",
                description:
                    "targetKind is inferred from target when omitted ('@' → channel, '://' → url, else video).",
                tags: ["pipeline"],
                requestBody: jsonBody(
                    {
                        type: "object",
                        properties: {
                            target: { type: "string", description: "Video id, channel handle, or URL." },
                            targetKind: { type: "string", enum: ["video", "channel", "url"] },
                            stages: arrayOf(ref("JobStage")),
                        },
                        required: ["target", "stages"],
                    },
                    { required: true }
                ),
                responses: {
                    "200": jsonResponse("Enqueued job", {
                        type: "object",
                        properties: { job: ref("PipelineJob") },
                        required: ["job"],
                    }),
                },
            },
        },
        "/api/v1/jobs": {
            get: {
                operationId: "listJobs",
                summary: "List pipeline jobs",
                tags: ["jobs"],
                parameters: [
                    {
                        name: "status",
                        in: "query",
                        description: "Filter by job status.",
                        schema: ref("JobStatus"),
                    },
                    {
                        name: "limit",
                        in: "query",
                        description: "Max rows (default 100).",
                        schema: { type: "integer", default: 100 },
                    },
                ],
                responses: {
                    "200": jsonResponse("Jobs", {
                        type: "object",
                        properties: { jobs: arrayOf(ref("PipelineJob")) },
                        required: ["jobs"],
                    }),
                },
            },
        },
        "/api/v1/jobs/{id}": {
            get: {
                operationId: "getJob",
                summary: "Get a pipeline job by id",
                tags: ["jobs"],
                parameters: [jobIdParam],
                responses: {
                    "200": jsonResponse("Job", {
                        type: "object",
                        properties: { job: ref("PipelineJob") },
                        required: ["job"],
                    }),
                    "404": errorResponse,
                },
            },
        },
        "/api/v1/jobs/{id}/activity": {
            get: {
                operationId: "getJobActivity",
                summary: "List AI/API activity recorded against a job",
                tags: ["jobs"],
                parameters: [jobIdParam],
                responses: {
                    "200": jsonResponse("Job activity", {
                        type: "object",
                        properties: { activity: arrayOf(ref("JobActivity")) },
                        required: ["activity"],
                    }),
                    "404": errorResponse,
                },
            },
        },
        "/api/v1/jobs/{id}/cancel": {
            post: {
                operationId: "cancelJob",
                summary: "Cancel a pipeline job",
                tags: ["jobs"],
                parameters: [jobIdParam],
                responses: {
                    "200": jsonResponse("Cancelled job", {
                        type: "object",
                        properties: { job: { oneOf: [ref("PipelineJob"), { type: "null" }] } },
                        required: ["job"],
                    }),
                },
            },
        },
        "/api/v1/cache/stats": {
            get: {
                operationId: "getCacheStats",
                summary: "Cache and storage statistics",
                tags: ["cache"],
                responses: {
                    "200": jsonResponse("Cache stats", ref("CacheStats")),
                },
            },
        },
        "/api/v1/cache/prune": {
            post: {
                operationId: "pruneCache",
                summary: "Prune expired cached binaries by TTL",
                tags: ["cache"],
                requestBody: jsonBody({
                    type: "object",
                    properties: { dryRun: { type: "boolean", description: "Report counts without deleting." } },
                }),
                responses: {
                    "200": jsonResponse("Prune result", {
                        type: "object",
                        properties: {
                            audio: { type: "integer" },
                            video: { type: "integer" },
                            thumb: { type: "integer" },
                            dryRun: { type: "boolean" },
                        },
                        required: ["audio", "video", "thumb"],
                    }),
                },
            },
        },
        "/api/v1/cache/clear": {
            post: {
                operationId: "clearCache",
                summary: "Delete cached binaries (audio/video/thumbs)",
                tags: ["cache"],
                requestBody: jsonBody({
                    type: "object",
                    properties: {
                        audio: { type: "boolean" },
                        video: { type: "boolean" },
                        thumbs: { type: "boolean" },
                        all: { type: "boolean", description: "Clear all binary kinds." },
                    },
                }),
                responses: {
                    "200": jsonResponse("Clear result", {
                        type: "object",
                        properties: {
                            deletedCount: { type: "integer" },
                            freedBytes: { type: "integer" },
                        },
                        required: ["deletedCount", "freedBytes"],
                    }),
                },
            },
        },
        "/api/v1/config": {
            get: {
                operationId: "getConfig",
                summary: "Get effective config",
                tags: ["config"],
                responses: {
                    "200": jsonResponse("Config", {
                        type: "object",
                        properties: {
                            config: ref("YoutubeConfig"),
                            where: { type: "string", description: "Path of the config file backing these values." },
                        },
                        required: ["config", "where"],
                    }),
                },
            },
            patch: {
                operationId: "updateConfig",
                summary: "Update config (deep-partial merge)",
                tags: ["config"],
                requestBody: jsonBody(ref("YoutubeConfig"), {
                    required: true,
                    description: "Any deep-partial subset of the config shape.",
                }),
                responses: {
                    "200": jsonResponse("Updated config", {
                        type: "object",
                        properties: { config: ref("YoutubeConfig") },
                        required: ["config"],
                    }),
                    "405": errorResponse,
                },
            },
        },
        "/api/v1/healthz": {
            get: {
                operationId: "getHealth",
                summary: "Health check",
                tags: ["meta"],
                responses: {
                    "200": jsonResponse("Healthy", {
                        type: "object",
                        properties: {
                            ok: { type: "boolean" },
                            uptimeMs: { type: "number" },
                            version: { type: "string" },
                        },
                        required: ["ok", "uptimeMs", "version"],
                    }),
                },
            },
        },
        "/api/v1/version": {
            get: {
                operationId: "getVersion",
                summary: "Server version and git sha",
                tags: ["meta"],
                responses: {
                    "200": jsonResponse("Version", {
                        type: "object",
                        properties: {
                            version: { type: "string" },
                            gitSha: nullableString(),
                        },
                        required: ["version", "gitSha"],
                    }),
                },
            },
        },
    };
}

let cachedDocument: OpenApiDocument | undefined;

export function buildOpenApiDocument(): OpenApiDocument {
    if (cachedDocument) {
        return cachedDocument;
    }

    cachedDocument = {
        openapi: "3.1.0",
        info: {
            title: "GenesisTools YouTube API",
            version: API_VERSION,
            description:
                "HTTP API for the `tools youtube` server: channel tracking, video/transcript/summary/QA access, the ingest pipeline, cache management, and config. A realtime job-event stream is served separately over a websocket at `GET /api/v1/events` (not expressible in OpenAPI).",
        },
        servers: [{ url: "/", description: "Relative to the server origin." }],
        tags: [
            { name: "channels", description: "Tracked channels." },
            { name: "videos", description: "Videos, transcripts, summaries, and QA." },
            { name: "pipeline", description: "Ingest pipeline enqueue." },
            { name: "jobs", description: "Pipeline jobs and their activity." },
            { name: "cache", description: "Cache statistics and cleanup." },
            { name: "config", description: "Server configuration." },
            { name: "meta", description: "Health and version." },
        ],
        paths: buildPaths(),
        components: { schemas: buildSchemas() },
    };

    return cachedDocument;
}

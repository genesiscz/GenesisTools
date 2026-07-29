import { answerOverVideos, formatCitationLines } from "@app/youtube/lib/ask-answer";
import { resolveAskScope } from "@app/youtube/lib/ask-scope";
import type { ChannelHandle } from "@app/youtube/lib/channel.types";
import { resolveProviderChoice } from "@app/youtube/lib/provider-choice";
import { type JobActor, toJobStages } from "@app/youtube/lib/queue";
import { withConsoleContext } from "@app/youtube/lib/service-user";
import { formatClock, videoUrl } from "@app/youtube/lib/transcript-export";
import type { VideoId } from "@app/youtube/lib/video.types";
import type { Youtube } from "@app/youtube/lib/youtube";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/**
 * A CURATED door onto the youtube library, not a mirror of the ~90 HTTP routes.
 *
 * The tools are workflow-shaped: an agent asking "what did this channel say
 * about X" should reach for one tool, not compose four. Admin, billing,
 * cache-clear and config writes are deliberately absent — an MCP client is an
 * untrusted-ish caller, and none of those are things it should be able to do.
 *
 * Every tool is a thin call into the same lib core the CLI and the HTTP routes
 * use, so there is no third behaviour to keep in sync.
 */

const SERVER_NAME = "youtube";
const SERVER_VERSION = "1.0.0";

/**
 * A type ALIAS, not an interface. The SDK's result type carries an index
 * signature, and only aliases get an implicit one — an interface here fails to
 * assign with a wall of structural noise.
 */
type ToolResult = {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
};

function text(value: string): ToolResult {
    return { content: [{ type: "text", text: value }] };
}

/**
 * Metadata only, with the local cache paths dropped.
 *
 * `Video` carries `audioPath` / `videoPath` / `thumbPath`, which are absolute
 * paths under the user's home. This server treats its clients as untrusted-ish,
 * and an MCP client needs none of them — serialising the raw record disclosed
 * the host username and the on-disk layout for no benefit.
 */
function publicVideo(video: Record<string, unknown>): Record<string, unknown> {
    const { audioPath, videoPath, thumbPath, ...rest } = video;
    return rest;
}

function asVideoIds(value: unknown): VideoId[] {
    return Array.isArray(value) ? (value.filter((id): id is string => typeof id === "string") as VideoId[]) : [];
}

export async function startMcpServer(yt: Youtube): Promise<void> {
    const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: "list_videos",
                description: "List stored videos, optionally filtered to one channel handle.",
                inputSchema: {
                    type: "object" as const,
                    properties: {
                        channel: { type: "string", description: "Channel handle, e.g. @bridgemindai" },
                        limit: { type: "number", description: "Max rows (default 50)" },
                    },
                },
            },
            {
                name: "get_video",
                description: "Metadata, transcript availability and the stored summary for one video, in one call.",
                inputSchema: {
                    type: "object" as const,
                    properties: { videoId: { type: "string" } },
                    required: ["videoId"],
                },
            },
            {
                name: "search_transcripts",
                description: "Keyword (full-text) search across stored transcripts. Fast, exact, no embedding cost.",
                inputSchema: {
                    type: "object" as const,
                    properties: {
                        query: { type: "string" },
                        videoIds: { type: "array", items: { type: "string" } },
                        limit: { type: "number" },
                    },
                    required: ["query"],
                },
            },
            {
                name: "transcript_window",
                description: "The transcript text around a timestamp, for quoting a passage a citation points at.",
                inputSchema: {
                    type: "object" as const,
                    properties: {
                        videoId: { type: "string" },
                        atSec: { type: "number" },
                        windowSec: { type: "number", description: "Half-width in seconds (default 45)" },
                    },
                    required: ["videoId", "atSec"],
                },
            },
            {
                name: "ask",
                description:
                    "Ask a question across a channel or an explicit video set. Returns the answer plus citations carrying timestamps and deep links.",
                inputSchema: {
                    type: "object" as const,
                    properties: {
                        question: { type: "string" },
                        channel: { type: "string", description: "Ask over every stored video of this channel" },
                        videoIds: { type: "array", items: { type: "string" } },
                        topK: { type: "number" },
                    },
                    required: ["question"],
                },
            },
            {
                name: "queue_add",
                description: "Enqueue a pipeline job for a video id, URL or @handle.",
                inputSchema: {
                    type: "object" as const,
                    properties: {
                        target: { type: "string" },
                        stages: { type: "array", items: { type: "string" } },
                    },
                    required: ["target"],
                },
            },
            {
                name: "queue_status",
                description: "Queue depth, or one job by id.",
                inputSchema: {
                    type: "object" as const,
                    properties: { jobId: { type: "number" } },
                },
            },
        ],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const args = (request.params.arguments ?? {}) as Record<string, unknown>;

        try {
            switch (request.params.name) {
                case "list_videos": {
                    const videos = yt.db.listVideos({
                        ...(typeof args.channel === "string" ? { channel: args.channel as ChannelHandle } : {}),
                        limit: typeof args.limit === "number" ? args.limit : 50,
                    });

                    return text(
                        SafeJSON.stringify(
                            videos.map((video) => publicVideo(video as unknown as Record<string, unknown>)),
                            null,
                            2
                        )
                    );
                }

                case "get_video": {
                    const videoId = String(args.videoId) as VideoId;
                    const video = yt.db.getVideo(videoId);

                    if (!video) {
                        return { ...text(`No stored video ${videoId}.`), isError: true };
                    }

                    const transcript = yt.db.getTranscript(videoId);

                    return text(
                        SafeJSON.stringify(
                            {
                                video: publicVideo(video as unknown as Record<string, unknown>),
                                url: videoUrl(videoId),
                                hasTranscript: Boolean(transcript),
                                segments: transcript?.segments.length ?? 0,
                            },
                            null,
                            2
                        )
                    );
                }

                case "search_transcripts": {
                    const hits = yt.qa.keywordSearch(
                        String(args.query),
                        asVideoIds(args.videoIds),
                        typeof args.limit === "number" ? args.limit : 20
                    );

                    return text(SafeJSON.stringify(hits, null, 2));
                }

                case "transcript_window": {
                    const videoId = String(args.videoId) as VideoId;
                    const transcript = yt.db.getTranscript(videoId);

                    if (!transcript) {
                        return { ...text(`No transcript stored for ${videoId}.`), isError: true };
                    }

                    const at = Number(args.atSec);
                    const half = typeof args.windowSec === "number" ? args.windowSec : 45;
                    const inWindow = transcript.segments.filter(
                        (segment) => segment.end >= at - half && segment.start <= at + half
                    );

                    return text(
                        inWindow.map((segment) => `[${formatClock(segment.start)}] ${segment.text}`).join("\n") ||
                            "(nothing in that window)"
                    );
                }

                case "ask": {
                    return await withConsoleContext(yt.db, async () => {
                        const scope = await resolveAskScope(yt, {
                            ...(typeof args.channel === "string" ? { channel: args.channel } : {}),
                            ...(Array.isArray(args.videoIds) ? { videoIds: asVideoIds(args.videoIds) } : {}),
                        });

                        const result = await answerOverVideos({
                            yt,
                            videoIds: scope.videoIds,
                            question: String(args.question),
                            topK: typeof args.topK === "number" ? args.topK : undefined,
                            providerChoice: await resolveProviderChoice({}),
                        });

                        return text(
                            `${result.answer}\n\nCitations:\n${formatCitationLines(result.citations).join("\n")}`
                        );
                    });
                }

                case "queue_add": {
                    return await withConsoleContext(yt.db, async (user) => {
                        const stages = toJobStages(
                            Array.isArray(args.stages) && args.stages.length > 0
                                ? args.stages.map(String)
                                : ["metadata", "captions", "transcribe", "summarize"]
                        );

                        const enqueued = yt.queue.enqueue({
                            target: String(args.target),
                            stages,
                            userId: user.id,
                        });

                        return text(SafeJSON.stringify(enqueued, null, 2));
                    });
                }

                case "queue_status": {
                    return await withConsoleContext(yt.db, async (user) => {
                        // Deliberately NOT the operator the CLI uses. This door treats its
                        // caller as untrusted-ish (see the header), so it reads the queue as
                        // the same console account `queue_add` enqueues under: it sees its
                        // own work, and never another user's jobs, ids or queue depth.
                        const actor: JobActor = { kind: "user", userId: user.id };

                        if (typeof args.jobId === "number") {
                            const found = yt.queue.get(args.jobId, { redact: true, actor });

                            return found
                                ? text(SafeJSON.stringify(found, null, 2))
                                : { ...text(`Job ${args.jobId} not found.`), isError: true };
                        }

                        return text(SafeJSON.stringify(yt.queue.stats(actor), null, 2));
                    });
                }

                default:
                    return { ...text(`Unknown tool: ${request.params.name}`), isError: true };
            }
        } catch (err) {
            // A thrown tool must not kill the server: an MCP client sees the
            // message and can correct its call.
            logger.warn({ err, tool: request.params.name }, "youtube mcp: tool failed");
            return { ...text(err instanceof Error ? err.message : String(err)), isError: true };
        }
    });

    logger.info({ tools: 7 }, "youtube mcp server starting on stdio");
    await server.connect(new StdioServerTransport());
}

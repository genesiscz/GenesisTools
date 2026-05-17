import { SafeJSON } from "@dashboard/shared";
import { chat, type ModelMessage, type StreamChunk, toServerSentEventsResponse } from "@tanstack/ai";
import { createAnthropicChat } from "@tanstack/ai-anthropic";
import { createFileRoute } from "@tanstack/react-router";
import { and, eq } from "drizzle-orm";
import { aiConversations, aiMessages, db } from "@/drizzle";
import { getUserIdFromRequest, isSameOrigin } from "@/lib/auth/requireUser";
import { env } from "@/lib/env";
import { emitDomainEvent } from "@/lib/events/event-bus.server";

export const Route = createFileRoute("/api/ai-chat")({
    server: {
        handlers: {
            POST: async ({ request }) => {
                const apiKey = env.ANTHROPIC_API_KEY;

                if (!apiKey) {
                    return new Response(
                        SafeJSON.stringify({
                            error: "AI chat is not configured. Set ANTHROPIC_API_KEY in .env.local and restart the server.",
                        }),
                        {
                            status: 503,
                            headers: { "Content-Type": "application/json" },
                        }
                    );
                }

                if (!isSameOrigin(request)) {
                    return new Response(SafeJSON.stringify({ error: "Cross-origin request rejected" }), {
                        status: 403,
                        headers: { "Content-Type": "application/json" },
                    });
                }

                const userId = await getUserIdFromRequest(request);
                if (!userId) {
                    return new Response(SafeJSON.stringify({ error: "Unauthorized" }), {
                        status: 401,
                        headers: { "Content-Type": "application/json" },
                    });
                }

                const url = new URL(request.url);
                const conversationId = url.searchParams.get("conversationId");

                if (!conversationId) {
                    return new Response(SafeJSON.stringify({ error: "Missing conversationId query parameter" }), {
                        status: 400,
                        headers: { "Content-Type": "application/json" },
                    });
                }

                // Verify conversation belongs to user
                const conv = db
                    .select()
                    .from(aiConversations)
                    .where(and(eq(aiConversations.id, conversationId), eq(aiConversations.userId, userId)))
                    .get();

                if (!conv) {
                    return new Response(SafeJSON.stringify({ error: "Conversation not found" }), {
                        status: 404,
                        headers: { "Content-Type": "application/json" },
                    });
                }

                // Narrow-stable captures — the early-return guards above prove these
                // are non-null, but that narrowing is lost across the async generator
                // closure below, so bind them as `string` consts here.
                const safeConversationId: string = conversationId;
                const safeUserId: string = userId;

                let body: { messages: ModelMessage<string>[] };

                try {
                    body = (await request.json()) as { messages: ModelMessage<string>[] };
                } catch {
                    return new Response(SafeJSON.stringify({ error: "Invalid JSON body" }), {
                        status: 400,
                        headers: { "Content-Type": "application/json" },
                    });
                }

                const messages = body.messages ?? [];

                // Persist the last user message (the client has already added it to its local state)
                const lastMsg = messages[messages.length - 1];

                if (lastMsg?.role === "user") {
                    const content = typeof lastMsg.content === "string" ? lastMsg.content : "";

                    db.insert(aiMessages)
                        .values({
                            id: crypto.randomUUID(),
                            conversationId: safeConversationId,
                            role: "user",
                            content,
                            createdAt: new Date().toISOString(),
                        })
                        .run();

                    // Bump updatedAt on conversation so sidebar re-sorts correctly
                    db.update(aiConversations)
                        .set({ updatedAt: new Date().toISOString() })
                        .where(eq(aiConversations.id, safeConversationId))
                        .run();

                    emitDomainEvent(safeUserId, "ai", { type: "conversation_changed" });
                }

                const adapter = createAnthropicChat("claude-sonnet-4-5", apiKey);
                const abortController = new AbortController();

                request.signal.addEventListener("abort", () => abortController.abort());

                // Build the async iterable stream
                const aiStream = chat({
                    adapter,
                    messages,
                    abortController,
                    systemPrompts: [
                        "You are a helpful AI assistant embedded in a productivity dashboard. Be concise, thoughtful, and precise.",
                    ],
                });

                // Tee the stream: one side for HTTP SSE, one side to accumulate
                // assistant text for persistence after the stream ends (or errors).
                let assistantText = "";

                async function* teedStream(): AsyncIterable<StreamChunk> {
                    try {
                        for await (const chunk of aiStream) {
                            if (chunk.type === "TEXT_MESSAGE_CONTENT" && chunk.delta) {
                                assistantText += chunk.delta;
                            }

                            yield chunk;
                        }
                    } finally {
                        if (assistantText.trim()) {
                            try {
                                db.insert(aiMessages)
                                    .values({
                                        id: crypto.randomUUID(),
                                        conversationId: safeConversationId,
                                        role: "assistant",
                                        content: assistantText,
                                        createdAt: new Date().toISOString(),
                                    })
                                    .run();

                                db.update(aiConversations)
                                    .set({ updatedAt: new Date().toISOString() })
                                    .where(eq(aiConversations.id, safeConversationId))
                                    .run();

                                emitDomainEvent(safeUserId, "ai", { type: "conversation_changed" });
                            } catch (persistErr) {
                                // Client already has the streamed text — log, don't fail the stream.
                                console.error("[ai-chat] Failed to persist assistant message:", persistErr);
                            }
                        }
                    }
                }

                return toServerSentEventsResponse(teedStream(), { abortController });
            },
        },
    },
});

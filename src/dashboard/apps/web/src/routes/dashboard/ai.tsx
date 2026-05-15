import { fetchServerSentEvents, useChat } from "@tanstack/ai-react";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import { Brain } from "lucide-react";
import { useState } from "react";
import { DashboardLayout } from "@/components/dashboard";
import {
    aiQueryKeys,
    useConversations,
    useCreateConversation,
    useDeleteConversation,
    useMessages,
} from "@/lib/ai/useAIQueries";
import { useServerEvents } from "@/lib/events/useServerEvents";
import { ChatInput } from "./-ai/ChatInput";
import { ConversationSidebar } from "./-ai/ConversationSidebar";
import { MessageThread } from "./-ai/MessageThread";

export const Route = createFileRoute("/dashboard/ai")({
    component: AIAssistantPage,
});

const DEV_USER_ID = "dev-user";

function AIAssistantPage() {
    const { user } = useAuth();
    const userId = user?.id ?? (import.meta.env.DEV ? DEV_USER_ID : null);

    const queryClient = useQueryClient();

    // Cross-tab/device sync via the shared SSE event bus — the server emits an
    // "ai" domain event after every conversation/message mutation.
    useServerEvents({
        userId,
        domain: "ai",
        onEvent: () =>
            queryClient.invalidateQueries({ queryKey: aiQueryKeys.conversations(userId ?? "") }),
    });

    const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
    const [apiError, setApiError] = useState<string | null>(null);

    const { data: conversations = [], isLoading: convsLoading } = useConversations(userId);
    const { data: persistedMessages = [] } = useMessages(activeConversationId);

    const createConv = useCreateConversation(userId);
    const deleteConv = useDeleteConversation(userId);

    async function handleNewConversation() {
        if (!userId) {
            return;
        }

        const id = crypto.randomUUID();
        const title = `Chat ${new Date().toLocaleString([], {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
        })}`;

        await createConv.mutateAsync({ id, title });
        setActiveConversationId(id);
        setApiError(null);
    }

    async function handleDeleteConversation(id: string) {
        await deleteConv.mutateAsync(id);

        if (activeConversationId === id) {
            setActiveConversationId(null);
        }
    }

    const {
        messages: streamingMessages,
        sendMessage,
        isLoading: isStreaming,
    } = useChat({
        connection: fetchServerSentEvents(
            () =>
                `/api/ai-chat?conversationId=${encodeURIComponent(
                    activeConversationId ?? ""
                )}&userId=${encodeURIComponent(userId ?? "")}`
        ),
        id: activeConversationId ?? undefined,
        onResponse: async (res) => {
            if (res && res.status === 503) {
                try {
                    const body = (await res.json()) as { error?: string };
                    setApiError(body.error ?? "AI service unavailable. Check ANTHROPIC_API_KEY.");
                } catch {
                    setApiError("AI service unavailable. Check ANTHROPIC_API_KEY in .env.local.");
                }
            } else {
                setApiError(null);
            }
        },
        onError: (err) => {
            setApiError(err.message);
        },
    });

    function handleSend(content: string) {
        if (!activeConversationId || !userId) {
            return;
        }

        void sendMessage(content);
    }

    return (
        <DashboardLayout
            title="AI Assistant"
            description="Your personal AI companion for tasks, research, and creativity"
        >
            <div className="flex h-[calc(100vh-8rem)] overflow-hidden rounded-xl border border-white/10 bg-black/20 shadow-2xl backdrop-blur-sm">
                <ConversationSidebar
                    conversations={conversations}
                    activeId={activeConversationId}
                    isLoading={convsLoading}
                    onSelect={(id) => {
                        setActiveConversationId(id);
                        setApiError(null);
                    }}
                    onNew={handleNewConversation}
                    onDelete={handleDeleteConversation}
                />

                <div className="flex flex-1 flex-col overflow-hidden">
                    <div className="flex items-center gap-2.5 border-b border-white/10 px-4 py-3">
                        <Brain className="h-4 w-4 text-violet-400" />
                        <span className="text-sm font-mono font-semibold text-white/80">
                            {conversations.find((c) => c.id === activeConversationId)?.title ??
                                "AI Assistant"}
                        </span>
                    </div>

                    {apiError && (
                        <div className="border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-xs font-mono text-red-400">
                            {apiError}
                        </div>
                    )}

                    {!activeConversationId && (
                        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-white/30">
                            <Brain className="h-12 w-12" />
                            <p className="text-sm font-mono">
                                Select a conversation or create a new one
                            </p>
                        </div>
                    )}

                    {activeConversationId && (
                        <>
                            <MessageThread
                                persistedMessages={persistedMessages}
                                streamingMessages={streamingMessages}
                                isStreaming={isStreaming}
                            />

                            <ChatInput
                                onSend={handleSend}
                                isStreaming={isStreaming}
                                disabled={!activeConversationId || !userId}
                            />
                        </>
                    )}
                </div>
            </div>
        </DashboardLayout>
    );
}

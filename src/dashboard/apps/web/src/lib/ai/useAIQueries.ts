import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
    appendMessage,
    createConversation,
    deleteConversation,
    listConversations,
    listMessages,
    updateConversationTitle,
} from "./ai.server";

// ============================================
// Query keys
// ============================================

export const aiQueryKeys = {
    conversations: (userId: string) => ["ai-conversations", userId] as const,
    messages: (conversationId: string) => ["ai-messages", conversationId] as const,
};

// ============================================
// Conversations
// ============================================

export function useConversations(userId: string | null) {
    return useQuery({
        queryKey: aiQueryKeys.conversations(userId ?? ""),
        queryFn: () => listConversations(),
        enabled: Boolean(userId),
    });
}

export function useCreateConversation(userId: string | null) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (vars: { id: string; title: string }) =>
            createConversation({ data: { id: vars.id, title: vars.title } }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: aiQueryKeys.conversations(userId ?? "") });
        },
        onError: (err) => {
            throw err;
        },
    });
}

export function useDeleteConversation(userId: string | null) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (conversationId: string) =>
            deleteConversation({ data: { id: conversationId } }),
        onSuccess: (_data, conversationId) => {
            queryClient.invalidateQueries({ queryKey: aiQueryKeys.conversations(userId ?? "") });
            queryClient.removeQueries({ queryKey: aiQueryKeys.messages(conversationId) });
        },
        onError: (err) => {
            throw err;
        },
    });
}

export function useUpdateConversationTitle(userId: string | null) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (vars: { id: string; title: string }) =>
            updateConversationTitle({ data: { id: vars.id, title: vars.title } }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: aiQueryKeys.conversations(userId ?? "") });
        },
        onError: (err) => {
            throw err;
        },
    });
}

// ============================================
// Messages
// ============================================

export function useMessages(conversationId: string | null) {
    return useQuery({
        queryKey: aiQueryKeys.messages(conversationId ?? ""),
        queryFn: () => listMessages({ data: { conversationId: conversationId ?? "" } }),
        enabled: Boolean(conversationId),
    });
}

export function useAppendMessage() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (vars: {
            id: string;
            conversationId: string;
            role: "user" | "assistant" | "system";
            content: string;
        }) => appendMessage({ data: vars }),
        onSuccess: (_data, vars) => {
            queryClient.invalidateQueries({ queryKey: aiQueryKeys.messages(vars.conversationId) });
        },
        onError: (err) => {
            throw err;
        },
    });
}

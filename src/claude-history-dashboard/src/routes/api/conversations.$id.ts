import { getConversationBySessionId } from "@app/claude/lib/history/search";
import { createFileRoute } from "@tanstack/react-router";
import {
	type SerializableConversationDetail,
	extractMessageContent,
	extractToolResults,
	extractToolUses,
	serializeResult,
} from "../../server/serializers";

export const Route = createFileRoute("/api/conversations/$id")({
	server: {
		handlers: {
			GET: async ({ params }: { params: { id: string } }) => {
				const result = await getConversationBySessionId(params.id);

				if (!result) {
					return Response.json({ error: "Conversation not found" }, { status: 404 });
				}

				const detail: SerializableConversationDetail = {
					...serializeResult(result),
					messages: result.matchedMessages.map((msg) => ({
						type: msg.type,
						role: "message" in msg ? (msg.message as { role?: string })?.role : undefined,
						content: extractMessageContent(msg as { type: string; message?: { content: unknown } }),
						timestamp: "timestamp" in msg ? String(msg.timestamp) : undefined,
						toolUses: extractToolUses(msg as { type: string; message?: { content: unknown } }),
						toolResults: extractToolResults(msg as { type: string; message?: { content: unknown } }),
					})),
				};

				return Response.json(detail);
			},
		},
	},
});

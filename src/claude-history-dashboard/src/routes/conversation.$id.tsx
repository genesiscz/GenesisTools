import type { AgentContentBlock, AgentMessage } from "@app/utils/agents/types";
import { SessionTimeline } from "@app/utils/agents/ui/components/SessionTimeline";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Calendar, FolderOpen, GitBranch } from "lucide-react";
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { getConversation } from "@/server/conversations";
import type { SerializableConversationDetail } from "@/server/serializers";

export const Route = createFileRoute("/conversation/$id")({
	component: ConversationPage,
	loader: ({ params }) => getConversation({ data: params.id }),
});

/**
 * Convert the dashboard's serialized messages into AgentMessage[].
 *
 * The server already extracts text, toolUses, and toolResults into a flat
 * shape. We reassemble them into the AgentMessage block model that the
 * shared SessionTimeline component expects.
 */
function toAgentMessages(messages: SerializableConversationDetail["messages"]): AgentMessage[] {
	const result: AgentMessage[] = [];

	for (const msg of messages) {
		if (msg.type !== "user" && msg.type !== "assistant") {
			continue;
		}

		const blocks: AgentContentBlock[] = [];
		const text = msg.content?.trim();

		if (text) {
			blocks.push({ type: "text", text });
		}

		if (msg.type === "assistant" && msg.toolUses) {
			for (const tool of msg.toolUses) {
				blocks.push({
					type: "tool_call",
					id: `${tool.name}-${blocks.length}`,
					name: tool.name,
					input: (tool.input ?? {}) as Record<string, unknown>,
				});
			}
		}

		if (msg.type === "user" && msg.toolResults) {
			for (const tr of msg.toolResults) {
				blocks.push({
					type: "tool_result",
					toolCallId: tr.toolUseId,
					content: tr.content,
					isError: tr.isError,
				});
			}
		}

		if (blocks.length === 0) {
			continue;
		}

		const agentMsg: AgentMessage = {
			role: msg.type === "user" ? "user" : "assistant",
			blocks,
			timestamp: msg.timestamp ? new Date(msg.timestamp) : undefined,
		};

		result.push(agentMsg);
	}

	return result;
}

function ConversationPage() {
	const conversation = Route.useLoaderData();

	const agentMessages = useMemo(() => {
		if (!conversation) {
			return [];
		}

		return toAgentMessages(conversation.messages);
	}, [conversation]);

	if (!conversation) {
		return (
			<div className="min-h-screen bg-background flex items-center justify-center">
				<Card className="p-8">
					<p className="text-muted-foreground">Conversation not found</p>
					<Link to="/" className="mt-4 text-primary hover:underline flex items-center gap-2">
						<ArrowLeft className="w-4 h-4" /> Back to conversations
					</Link>
				</Card>
			</div>
		);
	}

	return (
		<div className="min-h-screen bg-background">
			<header className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border">
				<div className="max-w-5xl mx-auto px-6 py-4">
					<Link
						to="/"
						className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-3"
					>
						<ArrowLeft className="w-4 h-4" />
						Back to conversations
					</Link>
					<h1 className="text-xl font-bold text-foreground line-clamp-2">
						{conversation.customTitle || conversation.summary || conversation.sessionId}
					</h1>
					<div className="flex flex-wrap items-center gap-3 mt-3 text-xs text-muted-foreground">
						<Badge variant="cyber-secondary">
							<FolderOpen className="w-3 h-3 mr-1" />
							{conversation.project}
						</Badge>
						{conversation.gitBranch && (
							<span className="flex items-center gap-1">
								<GitBranch className="w-3.5 h-3.5" />
								{conversation.gitBranch}
							</span>
						)}
						<span className="flex items-center gap-1">
							<Calendar className="w-3.5 h-3.5" />
							{new Date(conversation.timestamp).toLocaleString("en-US", {
								weekday: "short",
								month: "short",
								day: "numeric",
								hour: "2-digit",
								minute: "2-digit",
							})}
						</span>
						{conversation.isSubagent && <Badge>Subagent</Badge>}
					</div>
				</div>
			</header>
			<ScrollArea className="h-[calc(100vh-160px)]">
				<div className="max-w-5xl mx-auto px-6 py-6">
					<SessionTimeline
						messages={agentMessages}
						formatOptions={{ showThinking: true, toolDetailLevel: "full" }}
					/>
				</div>
			</ScrollArea>
		</div>
	);
}

import type { AgentContentBlock, AgentMessage } from "@app/utils/agents/types";
import { SessionTimeline } from "@app/utils/agents/ui/components/SessionTimeline";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Calendar, FolderOpen, GitBranch } from "lucide-react";
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
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

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];

		if (msg.type !== "user" && msg.type !== "assistant") {
			continue;
		}

		const blocks: AgentContentBlock[] = [];
		const text = msg.content?.trim();

		if (text) {
			blocks.push({ type: "text", text });
		}

		if (msg.type === "assistant" && msg.toolUses) {
			// Look ahead: the next user message's toolResults pair with these tool calls
			const nextMsg = messages[i + 1];
			const toolResults = nextMsg?.type === "user" && nextMsg.toolResults ? nextMsg.toolResults : [];

			for (let t = 0; t < msg.toolUses.length; t++) {
				const tool = msg.toolUses[t];
				const toolId = `tool-${t}`;

				blocks.push({
					type: "tool_call",
					id: toolId,
					name: tool.name,
					input: (tool.input ?? {}) as Record<string, unknown>,
				});

				// Attach positionally-matched tool result
				if (t < toolResults.length) {
					blocks.push({
						type: "tool_result",
						toolCallId: toolId,
						content: toolResults[t].content,
						isError: toolResults[t].isError,
					});
				}
			}
		}

		// Skip user messages that only had tool results (merged into preceding assistant)
		if (msg.type === "user" && msg.toolResults && msg.toolResults.length > 0 && blocks.length === 0) {
			continue;
		}

		if (blocks.length === 0) {
			continue;
		}

		result.push({
			role: msg.type === "user" ? "user" : "assistant",
			blocks,
			timestamp: msg.timestamp ? new Date(msg.timestamp) : undefined,
		});
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
					<Link to="/" className="mt-4 text-primary hover:underline text-sm">
						Back to conversations
					</Link>
				</Card>
			</div>
		);
	}

	return (
		<div className="min-h-screen bg-background">
			<header className="sticky top-0 z-30 glass-card border-b border-amber-500/10 shadow-[0_1px_12px_color-mix(in_oklch,var(--color-primary)_8%,transparent)]">
				<div className="max-w-5xl mx-auto px-6 py-3.5">
					<h1 className="text-xl font-bold text-primary neon-text-primary tracking-tight line-clamp-2">
						{conversation.customTitle || conversation.summary || conversation.sessionId}
					</h1>
					<div className="flex flex-wrap items-center gap-2.5 mt-2">
						<Badge variant="cyber-secondary" className="text-[11px]">
							<FolderOpen className="w-3 h-3 mr-1" />
							{conversation.project}
						</Badge>
						{conversation.gitBranch && (
							<Badge variant="cyber" className="text-[11px] font-mono gap-1">
								<GitBranch className="w-3 h-3" />
								{conversation.gitBranch}
							</Badge>
						)}
						<span
							className="flex items-center gap-1 text-[11px] font-mono text-muted-foreground/40 tabular-nums"
							suppressHydrationWarning
						>
							<Calendar className="w-3 h-3" />
							{new Date(conversation.timestamp).toLocaleString("en-US", {
								weekday: "short",
								month: "short",
								day: "numeric",
								hour: "2-digit",
								minute: "2-digit",
							})}
						</span>
						{conversation.isSubagent && (
							<Badge variant="outline" className="text-[10px] text-purple-400 border-purple-500/20">
								Subagent
							</Badge>
						)}
					</div>
				</div>
			</header>
			<main className="max-w-5xl mx-auto px-6 py-6 pb-16">
				<SessionTimeline
					messages={agentMessages}
					formatOptions={{ showThinking: true, toolDetailLevel: "full" }}
				/>
			</main>
		</div>
	);
}

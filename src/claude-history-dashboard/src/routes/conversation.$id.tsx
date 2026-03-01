import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Bot, Calendar, ChevronRight, FolderOpen, GitBranch, User, Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { getConversation } from "@/server/conversations";

export const Route = createFileRoute("/conversation/$id")({
	component: ConversationPage,
	loader: ({ params }) => getConversation({ data: params.id }),
});

function ConversationPage() {
	const conversation = Route.useLoaderData();

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
			{/* Header */}
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

			{/* Messages */}
			<ScrollArea className="h-[calc(100vh-160px)]">
				<div className="max-w-5xl mx-auto px-6 py-6">
					<div className="space-y-4">
						{conversation.messages
							.filter((msg) => msg.type === "user" || msg.type === "assistant")
							.map((msg, idx) => (
								/* biome-ignore lint/suspicious/noArrayIndexKey: messages have no stable unique id */
								<MessageCard key={idx} message={msg} />
							))}
					</div>
				</div>
			</ScrollArea>
		</div>
	);
}

// Format tool call summary for display
function formatToolSummary(tool: { name: string; input?: object }): { title: string; subtitle?: string } {
	const input = tool.input as Record<string, unknown> | undefined;

	switch (tool.name) {
		case "Bash": {
			const cmd = (input?.command as string) || "";
			const desc = input?.description as string;
			const shortCmd = cmd.length > 60 ? `${cmd.slice(0, 60)}...` : cmd;
			return {
				title: `Bash(${shortCmd})`,
				subtitle: desc,
			};
		}
		case "Read": {
			const path = (input?.file_path as string) || "";
			const shortPath = path.split("/").slice(-2).join("/");
			return { title: `Read(${shortPath})` };
		}
		case "Write": {
			const path = (input?.file_path as string) || "";
			const shortPath = path.split("/").slice(-2).join("/");
			return { title: `Write(${shortPath})` };
		}
		case "Edit": {
			const path = (input?.file_path as string) || "";
			const shortPath = path.split("/").slice(-2).join("/");
			return { title: `Edit(${shortPath})` };
		}
		case "Grep": {
			const pattern = (input?.pattern as string) || "";
			const path = (input?.path as string) || ".";
			const shortPath = path.split("/").slice(-1)[0] || ".";
			return { title: `Grep("${pattern}", ${shortPath})` };
		}
		case "Glob": {
			const pattern = (input?.pattern as string) || "";
			return { title: `Glob(${pattern})` };
		}
		case "Task": {
			const desc = (input?.description as string) || "";
			const type = (input?.subagent_type as string) || "";
			return { title: `Task(${type})`, subtitle: desc };
		}
		case "TodoWrite":
			return { title: "TodoWrite" };
		default:
			return { title: tool.name };
	}
}

// Count lines in content
function countLines(content: string): number {
	return content.split("\n").length;
}

function MessageCard({
	message,
}: {
	message: {
		type: string;
		role?: string;
		content: string;
		timestamp?: string;
		toolUses?: Array<{ name: string; input?: object }>;
		toolResults?: Array<{ toolUseId: string; content: string; isError?: boolean }>;
	};
}) {
	const isUser = message.type === "user";
	const hasToolContent =
		(message.toolUses && message.toolUses.length > 0) || (message.toolResults && message.toolResults.length > 0);
	const showTextContent = message.content && message.content.trim().length > 0;

	return (
		<Card className={isUser ? "bg-primary/5 border-primary/20" : ""}>
			<CardHeader className="pb-2 pt-3 px-4">
				<div className="flex items-center gap-2">
					{isUser ? <User className="w-4 h-4 text-primary" /> : <Bot className="w-4 h-4 text-secondary" />}
					<span className={`text-sm font-medium ${isUser ? "text-primary" : "text-secondary"}`}>
						{isUser ? "User" : "Assistant"}
					</span>
					{message.timestamp && (
						<span className="text-xs text-muted-foreground ml-auto">
							{new Date(message.timestamp).toLocaleTimeString("en-US", {
								hour: "2-digit",
								minute: "2-digit",
							})}
						</span>
					)}
				</div>
			</CardHeader>
			<CardContent className="px-4 pb-4">
				{/* Only show text content if there's actual text */}
				{showTextContent && (
					<div className="prose prose-sm prose-invert max-w-none">
						<pre className="whitespace-pre-wrap text-sm text-foreground font-sans leading-relaxed">
							{message.content}
						</pre>
					</div>
				)}

				{/* Show placeholder only if no content at all */}
				{!showTextContent && !hasToolContent && <span className="text-muted-foreground text-sm">(empty)</span>}

				{/* Tool Uses (assistant messages) - expandable */}
				{message.toolUses && message.toolUses.length > 0 && (
					<div className={`${showTextContent ? "mt-3 pt-3 border-t border-border" : ""} space-y-2`}>
						{message.toolUses.map((tool, i) => {
							const formatted = formatToolSummary(tool);
							const inputJson = tool.input ? JSON.stringify(tool.input, null, 2) : "{}";
							const isShort = countLines(inputJson) <= 10;

							return (
								/* biome-ignore lint/suspicious/noArrayIndexKey: tool uses have no stable unique id */
								<details key={i} className="group" open={isShort}>
									<summary className="flex items-center gap-2 cursor-pointer list-none text-sm text-muted-foreground hover:text-foreground">
										<ChevronRight className="w-4 h-4 transition-transform group-open:rotate-90" />
										<Wrench className="w-3 h-3" />
										<span className="font-mono text-xs">{formatted.title}</span>
										{formatted.subtitle && (
											<span className="text-xs text-muted-foreground/70 ml-1">— {formatted.subtitle}</span>
										)}
									</summary>
									<pre className="text-xs bg-muted p-2 rounded mt-2 ml-6 overflow-auto">{inputJson}</pre>
								</details>
							);
						})}
					</div>
				)}

				{/* Tool Results (user messages) - expandable */}
				{message.toolResults && message.toolResults.length > 0 && (
					<div className={`${showTextContent ? "mt-3 pt-3 border-t border-border" : ""} space-y-2`}>
						{message.toolResults.map((result, i) => {
							const isShort = countLines(result.content) <= 10;

							return (
								/* biome-ignore lint/suspicious/noArrayIndexKey: tool results have no stable unique id */
								<details key={i} className="group" open={isShort}>
									<summary
										className={`flex items-center gap-2 cursor-pointer list-none text-sm hover:text-foreground ${result.isError ? "text-red-500" : "text-muted-foreground"}`}
									>
										<ChevronRight className="w-4 h-4 transition-transform group-open:rotate-90" />
										<span className="font-medium">Tool Result {result.isError && "(Error)"}</span>
									</summary>
									<pre
										className={`text-xs p-2 rounded mt-2 ml-6 overflow-auto ${result.isError ? "bg-red-500/10" : "bg-muted"}`}
									>
										{result.content}
									</pre>
								</details>
							);
						})}
					</div>
				)}
			</CardContent>
		</Card>
	);
}

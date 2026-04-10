import { Badge } from "@ui/components/badge";
import { cn } from "@ui/lib/utils";
import { Bot, User } from "lucide-react";
import { useMemo } from "react";

import { messageToBlocks } from "../../formatters/block-parser";
import type { FormatOptions, FormattedBlock } from "../../formatters/types";
import type { AgentMessage } from "../../types";
import type { MessageCardProps } from "../types";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallCard } from "./ToolCallCard";

const DEFAULT_FORMAT_OPTIONS: FormatOptions = {
    showThinking: true,
    toolDetailLevel: "full",
    showRoleHeaders: false,
    showTimestamps: true,
    toolInputMaxChars: 300,
    toolOutputMaxChars: 1000,
};

function formatTime(date: Date): string {
    const h = date.getHours().toString().padStart(2, "0");
    const m = date.getMinutes().toString().padStart(2, "0");
    return `${h}:${m}`;
}

function groupToolBlocks(blocks: FormattedBlock[]): FormattedBlock[][] {
    const groups: FormattedBlock[][] = [];
    let currentToolGroup: FormattedBlock[] | null = null;

    for (const block of blocks) {
        if (block.type === "tool-signature") {
            if (currentToolGroup) {
                groups.push(currentToolGroup);
            }

            currentToolGroup = [block];
        } else if (currentToolGroup && (block.type === "tool-diff" || block.type === "tool-result")) {
            currentToolGroup.push(block);
        } else {
            if (currentToolGroup) {
                groups.push(currentToolGroup);
                currentToolGroup = null;
            }

            groups.push([block]);
        }
    }

    if (currentToolGroup) {
        groups.push(currentToolGroup);
    }

    return groups;
}

function RoleIcon({ role }: { role: AgentMessage["role"] }) {
    if (role === "user") {
        return (
            <div className="flex items-center justify-center w-6 h-6 rounded bg-cyan-500/10 border border-cyan-500/20">
                <User className="w-3.5 h-3.5 text-cyan-400" />
            </div>
        );
    }

    return (
        <div className="flex items-center justify-center w-6 h-6 rounded bg-amber-500/10 border border-amber-500/20">
            <Bot className="w-3.5 h-3.5 text-amber-400" />
        </div>
    );
}

function RoleLabel({ role }: { role: AgentMessage["role"] }) {
    const labels: Record<string, string> = {
        user: "User",
        assistant: "Assistant",
        system: "System",
        metadata: "Metadata",
    };

    const colorClass =
        role === "user" ? "text-cyan-400" : role === "assistant" ? "text-amber-400" : "text-muted-foreground";

    return (
        <span className={cn("text-sm font-semibold font-mono tracking-wide uppercase", colorClass)}>
            {labels[role] ?? role}
        </span>
    );
}

function renderBlockGroup(group: FormattedBlock[], groupIdx: number, defaultExpanded: boolean): React.ReactNode {
    const first = group[0];

    if (first.type === "tool-signature") {
        const diffBlock = group.find((b) => b.type === "tool-diff");
        const resultBlock = group.find((b) => b.type === "tool-result");

        return (
            <ToolCallCard
                key={groupIdx}
                name={first.meta?.toolName ?? "unknown"}
                signature={first.content}
                diffLines={diffBlock?.lines}
                resultContent={resultBlock?.content}
                isError={resultBlock?.meta?.isError}
                defaultExpanded={defaultExpanded}
            />
        );
    }

    return group.map((block, blockIdx) => (
        <BlockRenderer key={`${groupIdx}-${blockIdx}`} block={block} defaultExpanded={defaultExpanded} />
    ));
}

function BlockRenderer({ block, defaultExpanded }: { block: FormattedBlock; defaultExpanded: boolean }) {
    switch (block.type) {
        case "text":
            return <MarkdownRenderer content={block.content} className="text-sm leading-relaxed" />;

        case "thinking":
            return <ThinkingBlock content={block.content} defaultExpanded={defaultExpanded} />;

        case "tool-result":
            return (
                <pre
                    className={cn(
                        "text-xs p-3 rounded-md overflow-auto whitespace-pre-wrap font-mono border",
                        block.meta?.isError
                            ? "bg-red-500/5 border-red-500/20 text-red-300"
                            : "bg-black/20 border-white/5 text-muted-foreground"
                    )}
                >
                    {block.content}
                </pre>
            );

        case "image":
            return (
                <span className="text-xs text-muted-foreground italic flex items-center gap-1.5">
                    <span className="inline-block w-3 h-3 rounded-sm bg-muted-foreground/20" />
                    {block.content}
                </span>
            );

        case "agent-notification":
            return (
                <Badge variant="cyber-secondary" className="text-xs">
                    {block.meta?.agentId && <span className="font-mono mr-1 text-amber-400">{block.meta.agentId}</span>}
                    {block.content}
                </Badge>
            );

        case "role-header":
            return (
                <div className="text-xs font-medium text-muted-foreground flex items-center gap-2">
                    {block.content}
                    {block.meta?.model && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                            {block.meta.model}
                        </Badge>
                    )}
                </div>
            );

        case "code":
            return (
                <div className="md-code-block">
                    <pre className="hljs text-xs p-3 rounded-md overflow-auto">
                        <code>{block.content}</code>
                    </pre>
                </div>
            );

        case "separator":
            return <hr className="border-white/5" />;

        case "metadata":
            return <span className="text-xs text-muted-foreground/60 italic">{block.content}</span>;

        default:
            return null;
    }
}

export function MessageCard({ message, formatOptions, defaultExpanded = false }: MessageCardProps) {
    const options = useMemo(() => ({ ...DEFAULT_FORMAT_OPTIONS, ...formatOptions }), [formatOptions]);

    const blocks = useMemo(() => messageToBlocks(message, options), [message, options]);

    const groups = useMemo(() => groupToolBlocks(blocks), [blocks]);

    const isUser = message.role === "user";
    const isAssistant = message.role === "assistant";
    const hasContent = blocks.length > 0;

    return (
        <div
            className={cn(
                "rounded-lg border overflow-hidden transition-colors",
                isUser && "border-l-2 border-l-cyan-500/40 border-cyan-500/10 bg-cyan-500/[0.03]",
                isAssistant && "border-l-2 border-l-amber-500/30 border-white/[0.04] bg-white/[0.01]",
                !isUser && !isAssistant && "border-white/[0.06] bg-muted/10"
            )}
        >
            {/* Header */}
            <div className="flex items-center gap-2.5 px-4 pt-3 pb-2">
                <RoleIcon role={message.role} />
                <RoleLabel role={message.role} />

                {message.model && (
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 ml-1 font-mono opacity-60">
                        {message.model}
                    </Badge>
                )}

                {message.timestamp && (
                    <span
                        className="text-[11px] text-muted-foreground/50 ml-auto font-mono tabular-nums"
                        suppressHydrationWarning
                    >
                        {formatTime(message.timestamp)}
                    </span>
                )}
            </div>

            {/* Content */}
            <div className="px-4 pb-4">
                {hasContent ? (
                    <div className="space-y-3">
                        {groups.map((group, idx) => renderBlockGroup(group, idx, defaultExpanded))}
                    </div>
                ) : (
                    <span className="text-muted-foreground/40 text-sm italic">(empty)</span>
                )}
            </div>
        </div>
    );
}

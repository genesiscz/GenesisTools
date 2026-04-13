import { Badge } from "@ui/components/badge";
import { cn } from "@ui/lib/utils";
import { Bot, ChevronDown, User } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

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
    toolOutputMaxChars: 50_000,
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
            <div className="w-9 h-9 rounded-lg shrink-0 flex items-center justify-center bg-gradient-to-br from-violet-600 to-purple-500 text-white font-semibold text-sm">
                <User className="w-4 h-4" />
            </div>
        );
    }

    return (
        <div className="w-9 h-9 rounded-lg shrink-0 flex items-center justify-center bg-gradient-to-br from-amber-500 to-yellow-500 text-black font-semibold text-sm">
            <Bot className="w-4 h-4" />
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
        role === "user" ? "text-secondary" : role === "assistant" ? "text-primary" : "text-muted-foreground";

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

const LONG_TEXT_THRESHOLD = 800;

function CollapsibleText({ content, className }: { content: string; className?: string }) {
    const isLong = content.length > LONG_TEXT_THRESHOLD;
    const [expanded, setExpanded] = useState(false);
    const toggle = useCallback(() => setExpanded((prev) => !prev), []);

    if (!isLong) {
        return <MarkdownRenderer content={content} className={className} />;
    }

    return (
        <div>
            <div className={expanded ? "message-content-expanded" : "message-content-collapsed"}>
                <MarkdownRenderer content={content} className={className} />
            </div>
            <button
                type="button"
                onClick={toggle}
                className={cn(
                    "flex items-center gap-1.5 mt-3 text-xs font-mono cursor-pointer transition-all duration-200",
                    "text-amber-500/50 hover:text-amber-400 hover:bg-amber-500/5 rounded-md px-2 py-1 -ml-2"
                )}
            >
                <ChevronDown className={cn("w-3 h-3 transition-transform duration-200", expanded && "rotate-180")} />
                {expanded ? "Show less" : `Show more (${content.split("\n").length} lines)`}
            </button>
        </div>
    );
}

function BlockRenderer({ block, defaultExpanded }: { block: FormattedBlock; defaultExpanded: boolean }) {
    switch (block.type) {
        case "text":
            return <CollapsibleText content={block.content} className="text-sm leading-relaxed" />;

        case "thinking":
            return <ThinkingBlock content={block.content} defaultExpanded={defaultExpanded} />;

        case "tool-result":
            return (
                <pre
                    className={cn(
                        "text-xs p-3 rounded-md overflow-auto whitespace-pre-wrap font-mono border",
                        block.meta?.isError
                            ? "bg-red-500/[0.04] border-red-500/20 text-red-300/80"
                            : "bg-black/30 border-white/[0.06] text-muted-foreground/60"
                    )}
                >
                    {block.content}
                </pre>
            );

        case "image":
            return (
                <span className="text-xs text-muted-foreground/60 italic flex items-center gap-1.5">
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
            return <hr className="border-white/[0.06] my-1" />;

        case "metadata":
            return <span className="text-xs text-muted-foreground/50 italic">{block.content}</span>;

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
        <div className="mb-2.5 animate-[fadeSlideIn_0.4s_ease-out]">
            <div className="flex gap-3">
                <RoleIcon role={message.role} />

                <div className="flex-1 min-w-0">
                    <div
                        className={cn(
                            "rounded-xl p-4 relative transition-all duration-200",
                            "hover:-translate-y-px hover:shadow-lg",
                            isUser &&
                                "bg-gradient-to-br from-violet-600/15 to-purple-500/10 border border-violet-500/25 hover:border-violet-500/40",
                            isAssistant && "glass-card border-l-2 border-l-amber-500/30 hover:border-l-amber-500/60",
                            !isUser && !isAssistant && "rounded-lg border border-border bg-muted/10"
                        )}
                    >
                        {/* Header */}
                        <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                                <RoleLabel role={message.role} />

                                {message.model && (
                                    <Badge
                                        variant="outline"
                                        className="text-[10px] px-1.5 py-0 ml-1 font-mono opacity-60"
                                    >
                                        {message.model}
                                    </Badge>
                                )}
                            </div>

                            {message.timestamp && (
                                <span
                                    className="text-[11px] text-muted-foreground/50 font-mono tabular-nums"
                                    suppressHydrationWarning
                                >
                                    {formatTime(message.timestamp)}
                                </span>
                            )}
                        </div>

                        {/* Content */}
                        {hasContent ? (
                            <div className="space-y-3">
                                {groups.map((group, idx) => renderBlockGroup(group, idx, defaultExpanded))}
                            </div>
                        ) : (
                            <span className="text-muted-foreground/40 text-sm italic">(empty)</span>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

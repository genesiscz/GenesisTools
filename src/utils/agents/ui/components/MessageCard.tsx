import { Badge } from "@ui/components/badge";
import { Card, CardContent, CardHeader } from "@ui/components/card";
import { cn } from "@ui/lib/utils";
import { Bot, User } from "lucide-react";
import { useMemo } from "react";

import { messageToBlocks } from "../../formatters/block-parser";
import type { FormatOptions, FormattedBlock } from "../../formatters/types";
import type { AgentMessage } from "../../types";
import type { MessageCardProps } from "../types";
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
        return <User className="w-4 h-4 text-primary" />;
    }

    return <Bot className="w-4 h-4 text-secondary" />;
}

function RoleLabel({ role }: { role: AgentMessage["role"] }) {
    const labels: Record<string, string> = {
        user: "User",
        assistant: "Assistant",
        system: "System",
        metadata: "Metadata",
    };

    const colorClass = role === "user" ? "text-primary" : "text-secondary";

    return <span className={cn("text-sm font-medium", colorClass)}>{labels[role] ?? role}</span>;
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
            return (
                <div className="prose prose-sm dark:prose-invert max-w-none">
                    <pre className="whitespace-pre-wrap text-sm text-foreground font-sans leading-relaxed">
                        {block.content}
                    </pre>
                </div>
            );

        case "thinking":
            return <ThinkingBlock content={block.content} defaultExpanded={defaultExpanded} />;

        case "tool-result":
            return (
                <pre
                    className={cn(
                        "text-xs p-2 rounded overflow-auto whitespace-pre-wrap",
                        block.meta?.isError ? "bg-red-500/10" : "bg-muted/30"
                    )}
                >
                    {block.content}
                </pre>
            );

        case "image":
            return <span className="text-xs text-muted-foreground italic">{block.content}</span>;

        case "agent-notification":
            return (
                <Badge variant="secondary" className="text-xs text-muted-foreground">
                    {block.meta?.agentId && <span className="font-mono mr-1">{block.meta.agentId}</span>}
                    {block.content}
                </Badge>
            );

        case "role-header":
            return (
                <div className="text-xs font-medium text-muted-foreground">
                    {block.content}
                    {block.meta?.model && (
                        <Badge variant="outline" className="ml-2 text-[10px]">
                            {block.meta.model}
                        </Badge>
                    )}
                </div>
            );

        case "code":
            return (
                <pre className="text-xs p-2 rounded bg-muted/50 overflow-auto">
                    <code>{block.content}</code>
                </pre>
            );

        case "separator":
            return <hr className="border-border" />;

        case "metadata":
            return <span className="text-xs text-muted-foreground italic">{block.content}</span>;

        default:
            return null;
    }
}

export function MessageCard({ message, formatOptions, defaultExpanded = false }: MessageCardProps) {
    const options = useMemo(() => ({ ...DEFAULT_FORMAT_OPTIONS, ...formatOptions }), [formatOptions]);

    const blocks = useMemo(() => messageToBlocks(message, options), [message, options]);

    const groups = useMemo(() => groupToolBlocks(blocks), [blocks]);

    const isUser = message.role === "user";
    const hasContent = blocks.length > 0;

    return (
        <Card className={cn(isUser && "bg-primary/5 border-primary/20")}>
            <CardHeader className="pb-2 pt-3 px-4">
                <div className="flex items-center gap-2">
                    <RoleIcon role={message.role} />
                    <RoleLabel role={message.role} />

                    {message.model && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 ml-1">
                            {message.model}
                        </Badge>
                    )}

                    {message.timestamp && (
                        <span className="text-xs text-muted-foreground ml-auto" suppressHydrationWarning>
                            {formatTime(message.timestamp)}
                        </span>
                    )}
                </div>
            </CardHeader>

            <CardContent className="px-4 pb-4">
                {hasContent ? (
                    <div className="space-y-3">
                        {groups.map((group, idx) => renderBlockGroup(group, idx, defaultExpanded))}
                    </div>
                ) : (
                    <span className="text-muted-foreground text-sm">(empty)</span>
                )}
            </CardContent>
        </Card>
    );
}

import { IconButton } from "@ui/components/icon-button";
import { ScrollArea } from "@ui/components/scroll-area";
import { MessageSquarePlus, MessagesSquare, Trash2 } from "lucide-react";
import type { AiConversation } from "@/drizzle";

interface ConversationSidebarProps {
    conversations: AiConversation[];
    activeId: string | null;
    isLoading: boolean;
    onSelect: (id: string) => void;
    onNew: () => void;
    onDelete: (id: string) => void;
}

export function ConversationSidebar({
    conversations,
    activeId,
    isLoading,
    onSelect,
    onNew,
    onDelete,
}: ConversationSidebarProps) {
    return (
        <aside className="flex h-full w-64 shrink-0 flex-col border-r border-white/10 bg-black/30 backdrop-blur-sm">
            <div className="flex items-center justify-between border-b border-white/10 p-3">
                <span className="text-xs font-mono font-semibold uppercase tracking-widest text-white/50">
                    Conversations
                </span>

                <IconButton
                    onClick={onNew}
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 rounded-lg text-violet-400 hover:bg-violet-400/10 hover:text-violet-300"
                    tooltip="New conversation"
                >
                    <MessageSquarePlus className="h-4 w-4" />
                </IconButton>
            </div>

            <ScrollArea className="flex-1">
                {isLoading && (
                    <div className="flex items-center justify-center py-8 text-white/30">
                        <span className="text-xs font-mono">Loading…</span>
                    </div>
                )}

                {!isLoading && conversations.length === 0 && (
                    <div className="flex flex-col items-center justify-center gap-2 py-8 text-white/30">
                        <MessagesSquare className="h-8 w-8" />
                        <p className="text-xs font-mono">No conversations yet</p>
                    </div>
                )}

                <ul className="flex flex-col gap-0.5 p-2">
                    {conversations.map((conv) => {
                        const isActive = conv.id === activeId;

                        return (
                            <li key={conv.id}>
                                <button
                                    type="button"
                                    onClick={() => onSelect(conv.id)}
                                    className={[
                                        "group relative flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left",
                                        "text-xs font-mono transition-all",
                                        "hover:-translate-y-px hover:shadow-md",
                                        isActive
                                            ? "bg-violet-500/15 text-white shadow-[0_0_12px_rgba(139,92,246,0.15)] ring-1 ring-violet-500/40"
                                            : "text-white/60 hover:bg-white/5 hover:text-white/90",
                                    ].join(" ")}
                                >
                                    <span className="flex-1 truncate">{conv.title}</span>

                                    <IconButton
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        tooltip="Delete conversation"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onDelete(conv.id);
                                        }}
                                        className="h-6 w-6 rounded p-0.5 text-white/40 opacity-0 transition-opacity hover:bg-transparent hover:text-red-400 group-hover:opacity-100"
                                    >
                                        <Trash2 className="h-3.5 w-3.5" />
                                    </IconButton>
                                </button>
                            </li>
                        );
                    })}
                </ul>
            </ScrollArea>
        </aside>
    );
}

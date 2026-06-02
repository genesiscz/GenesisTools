import { IconButton } from "@ui/components/icon-button";
import { ScrollArea } from "@ui/components/scroll-area";
import { Check, MessageSquarePlus, MessagesSquare, Pencil, Search, Trash2, X } from "lucide-react";
import type React from "react";
import { useState } from "react";
import type { AiConversation } from "@/drizzle";

interface ConversationSidebarProps {
    conversations: AiConversation[];
    activeId: string | null;
    isLoading: boolean;
    onSelect: (id: string) => void;
    onNew: () => void;
    onDelete: (id: string) => void;
    onRename: (id: string, title: string) => void;
}

export function ConversationSidebar({
    conversations,
    activeId,
    isLoading,
    onSelect,
    onNew,
    onDelete,
    onRename,
}: ConversationSidebarProps) {
    const [query, setQuery] = useState("");
    const [editingId, setEditingId] = useState<string | null>(null);
    const [draft, setDraft] = useState("");

    const normalizedQuery = query.trim().toLowerCase();
    const filtered = normalizedQuery
        ? conversations.filter((conv) => conv.title.toLowerCase().includes(normalizedQuery))
        : conversations;

    function startEditing(conv: AiConversation) {
        setEditingId(conv.id);
        setDraft(conv.title);
    }

    function cancelEditing() {
        setEditingId(null);
        setDraft("");
    }

    function commitEditing(id: string) {
        const trimmed = draft.trim();

        if (trimmed) {
            const current = conversations.find((conv) => conv.id === id);

            if (current && current.title !== trimmed) {
                onRename(id, trimmed);
            }
        }

        cancelEditing();
    }

    function handleEditKeyDown(e: React.KeyboardEvent<HTMLInputElement>, id: string) {
        if (e.key === "Enter") {
            e.preventDefault();
            commitEditing(id);
        }

        if (e.key === "Escape") {
            e.preventDefault();
            cancelEditing();
        }
    }

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
                    data-testid="ai-new-conversation"
                >
                    <MessageSquarePlus className="h-4 w-4" />
                </IconButton>
            </div>

            <div className="border-b border-white/10 p-2">
                <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/30" />
                    <input
                        type="text"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Search…"
                        data-testid="ai-conversation-search"
                        className="w-full rounded-lg border border-white/10 bg-white/5 py-1.5 pl-8 pr-2 font-mono text-xs text-white/90 placeholder:text-white/30 focus:border-violet-400/40 focus:outline-none focus:ring-1 focus:ring-violet-400/40"
                    />
                </div>
            </div>

            <ScrollArea className="flex-1">
                {isLoading && (
                    <div className="flex items-center justify-center py-8 text-white/30">
                        <span className="text-xs font-mono">Loading…</span>
                    </div>
                )}

                {!isLoading && conversations.length === 0 && (
                    <div
                        className="flex flex-col items-center justify-center gap-2 py-8 text-white/30"
                        data-testid="ai-conversations-empty"
                    >
                        <MessagesSquare className="h-8 w-8" />
                        <p className="text-xs font-mono">No conversations yet</p>
                    </div>
                )}

                {!isLoading && conversations.length > 0 && filtered.length === 0 && (
                    <div className="flex flex-col items-center justify-center gap-2 py-8 text-white/30">
                        <Search className="h-7 w-7" />
                        <p className="text-xs font-mono">No matches</p>
                    </div>
                )}

                <ul className="flex flex-col gap-0.5 p-2">
                    {filtered.map((conv) => {
                        const isActive = conv.id === activeId;
                        const isEditing = conv.id === editingId;

                        if (isEditing) {
                            return (
                                <li key={conv.id}>
                                    <div
                                        className="flex w-full items-center gap-1 rounded-lg bg-violet-500/15 px-2 py-1.5 ring-1 ring-violet-500/40"
                                        data-testid="ai-conversation-card"
                                    >
                                        <input
                                            autoFocus
                                            type="text"
                                            value={draft}
                                            onChange={(e) => setDraft(e.target.value)}
                                            onKeyDown={(e) => handleEditKeyDown(e, conv.id)}
                                            onFocus={(e) => e.currentTarget.select()}
                                            onBlur={() => commitEditing(conv.id)}
                                            onClick={(e) => e.stopPropagation()}
                                            data-testid="ai-conversation-rename-input"
                                            className="min-w-0 flex-1 rounded border border-violet-400/40 bg-black/40 px-1.5 py-0.5 font-mono text-xs text-white focus:outline-none focus:ring-1 focus:ring-violet-400/60"
                                        />

                                        <IconButton
                                            type="button"
                                            variant="ghost"
                                            size="icon"
                                            tooltip="Save"
                                            onMouseDown={(e) => e.preventDefault()}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                commitEditing(conv.id);
                                            }}
                                            className="h-6 w-6 rounded p-0.5 text-emerald-400 hover:bg-emerald-400/10 hover:text-emerald-300"
                                        >
                                            <Check className="h-3.5 w-3.5" />
                                        </IconButton>

                                        <IconButton
                                            type="button"
                                            variant="ghost"
                                            size="icon"
                                            tooltip="Cancel"
                                            onMouseDown={(e) => e.preventDefault()}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                cancelEditing();
                                            }}
                                            className="h-6 w-6 rounded p-0.5 text-white/40 hover:bg-white/5 hover:text-white/80"
                                        >
                                            <X className="h-3.5 w-3.5" />
                                        </IconButton>
                                    </div>
                                </li>
                            );
                        }

                        return (
                            <li key={conv.id}>
                                <button
                                    type="button"
                                    onClick={() => onSelect(conv.id)}
                                    onDoubleClick={() => startEditing(conv)}
                                    data-testid="ai-conversation-card"
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
                                        tooltip="Rename conversation"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            startEditing(conv);
                                        }}
                                        data-testid="ai-conversation-rename-button"
                                        className="h-6 w-6 rounded p-0.5 text-white/40 opacity-0 transition-opacity hover:bg-transparent hover:text-violet-300 group-hover:opacity-100"
                                    >
                                        <Pencil className="h-3.5 w-3.5" />
                                    </IconButton>

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

import { IconButton } from "@ui/components/icon-button";
import { TagChip } from "@ui/custom";
import { cn } from "@ui/lib/utils";
import { ExternalLink, Globe, Trash2 } from "lucide-react";
import type { BookmarkRow } from "@/lib/bookmarks/bookmarks.server";

interface BookmarkCardProps {
    bookmark: BookmarkRow;
    onDelete: (id: string) => void;
    className?: string;
}

export function BookmarkCard({ bookmark, onDelete, className }: BookmarkCardProps) {
    const domain = (() => {
        try {
            return new URL(bookmark.url).hostname.replace(/^www\./, "");
        } catch {
            return bookmark.url;
        }
    })();

    return (
        <article
            className={cn(
                "group relative flex flex-col gap-3 rounded-xl border border-white/10 bg-white/5 p-4",
                "backdrop-blur-sm transition-all duration-200",
                "hover:-translate-y-0.5 hover:border-rose-500/30 hover:bg-white/[0.08] hover:shadow-[0_8px_32px_-8px_rgba(244,63,94,0.2)]",
                className
            )}
        >
            {/* Header row: favicon + domain + delete */}
            <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                    {bookmark.faviconUrl ? (
                        <img
                            src={bookmark.faviconUrl}
                            alt=""
                            width={16}
                            height={16}
                            className="h-4 w-4 shrink-0 rounded-sm object-contain"
                            onError={(e) => {
                                (e.target as HTMLImageElement).style.display = "none";
                            }}
                        />
                    ) : (
                        <Globe className="h-4 w-4 shrink-0 text-muted-foreground/50" />
                    )}
                    <span className="font-mono text-[10px] tracking-widest uppercase text-muted-foreground/60 truncate">
                        {domain}
                    </span>
                </div>

                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <IconButton
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-rose-400"
                        tooltip="Open bookmark"
                        onClick={() => window.open(bookmark.url, "_blank", "noopener,noreferrer")}
                    >
                        <ExternalLink className="h-3.5 w-3.5" />
                    </IconButton>
                    <IconButton
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-rose-400"
                        tooltip="Delete bookmark"
                        onClick={() => onDelete(bookmark.id)}
                    >
                        <Trash2 className="h-3.5 w-3.5" />
                    </IconButton>
                </div>
            </div>

            {/* Title */}
            <a
                href={bookmark.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-semibold text-foreground/90 line-clamp-2 hover:text-rose-300 transition-colors"
            >
                {bookmark.title || bookmark.url}
            </a>

            {/* Description */}
            {bookmark.description && (
                <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">{bookmark.description}</p>
            )}

            {/* Tags */}
            {bookmark.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-auto pt-1">
                    {bookmark.tags.map((tag) => (
                        <TagChip key={tag}>{tag}</TagChip>
                    ))}
                </div>
            )}

            {/* Subtle rose glow on hover */}
            <div className="pointer-events-none absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 bg-gradient-to-br from-rose-500/5 to-transparent" />
        </article>
    );
}

import { Input } from "@ui/components/input";
import { cn } from "@ui/lib/utils";
import { Search, X } from "lucide-react";

interface BookmarkFiltersProps {
    search: string;
    onSearchChange: (v: string) => void;
    activeTag: string | null;
    onTagChange: (tag: string | null) => void;
    allTags: string[];
}

export function BookmarkFilters({ search, onSearchChange, activeTag, onTagChange, allTags }: BookmarkFiltersProps) {
    return (
        <div className="flex flex-col gap-3">
            {/* Search */}
            <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/50 pointer-events-none" />
                <Input
                    value={search}
                    onChange={(e) => onSearchChange(e.target.value)}
                    placeholder="Search bookmarks…"
                    className="pl-9 bg-white/5 border-white/10 focus:border-rose-500/50 focus:ring-rose-500/20"
                />
                {search && (
                    <button
                        type="button"
                        onClick={() => onSearchChange("")}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground"
                    >
                        <X className="h-3.5 w-3.5" />
                        <span className="sr-only">Clear search</span>
                    </button>
                )}
            </div>

            {/* Tag filter chips */}
            {allTags.length > 0 && (
                <div className="flex flex-wrap gap-1.5 items-center">
                    <span className="font-mono text-[10px] tracking-widest uppercase text-muted-foreground/50 mr-1">
                        Filter:
                    </span>

                    {/* "All" chip */}
                    <button
                        type="button"
                        onClick={() => onTagChange(null)}
                        className={cn(
                            "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-mono tracking-widest uppercase transition-all duration-150",
                            activeTag === null
                                ? "border-rose-500/50 bg-rose-500/15 text-rose-300"
                                : "border-white/10 bg-white/5 text-muted-foreground hover:border-white/20 hover:text-foreground/70"
                        )}
                    >
                        All
                    </button>

                    {allTags.map((tag) => (
                        <button
                            type="button"
                            key={tag}
                            onClick={() => onTagChange(activeTag === tag ? null : tag)}
                            className={cn(
                                "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-mono tracking-widest uppercase transition-all duration-150",
                                activeTag === tag
                                    ? "border-rose-500/50 bg-rose-500/15 text-rose-300"
                                    : "border-white/10 bg-white/5 text-muted-foreground hover:border-white/20 hover:text-foreground/70"
                            )}
                        >
                            {tag}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

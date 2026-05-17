const TAG_ACTIVE: Record<string, string> = {
    active: "border-emerald-500/50 bg-emerald-500/15 text-emerald-300",
    inactive: "border-white/10 bg-zinc-900/60 text-zinc-400 hover:border-emerald-500/20 hover:text-zinc-200",
};

interface NoteTagFilterProps {
    tags: string[];
    activeTag: string | null;
    onToggle: (tag: string) => void;
}

export function NoteTagFilter({ tags, activeTag, onToggle }: NoteTagFilterProps) {
    return (
        <div className="flex flex-wrap gap-1.5">
            {tags.map((tag) => {
                const stateKey = activeTag === tag ? "active" : "inactive";
                const cls = TAG_ACTIVE[stateKey] ?? TAG_ACTIVE.inactive;

                return (
                    <button
                        key={tag}
                        type="button"
                        onClick={() => onToggle(tag)}
                        className={[
                            "rounded-full border px-3 py-1 text-[11px] font-medium",
                            "backdrop-blur-sm transition-all hover:-translate-y-0.5",
                            cls,
                        ].join(" ")}
                        style={{ fontFamily: "'JetBrains Mono', monospace" }}
                    >
                        #{tag}
                    </button>
                );
            })}
        </div>
    );
}

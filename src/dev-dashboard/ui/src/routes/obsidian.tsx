import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ObsidianReader } from "@/components/ObsidianReader";
import { ObsidianTree } from "@/components/ObsidianTree";
import { obsidianApi } from "@/lib/api";

export function ObsidianRoute() {
    const { data, error } = useQuery({ queryKey: ["obsidian", "tree"], queryFn: obsidianApi.tree });
    const [selected, setSelected] = useState<string | null>(null);

    return (
        <div className="grid h-[calc(100vh-2rem)] grid-cols-[minmax(220px,280px)_1fr] gap-2">
            <aside className="dd-panel overflow-auto p-2">
                {data ? (
                    <ObsidianTree entries={data.entries} onSelect={setSelected} selected={selected} />
                ) : (
                    <p className="font-mono text-[11px] text-[var(--dd-text-muted)]">
                        {error instanceof Error ? error.message : "Loading vault..."}
                    </p>
                )}
            </aside>
            <main className="overflow-hidden">
                {selected ? (
                    <ObsidianReader path={selected} />
                ) : (
                    <div className="dd-panel flex h-full items-center justify-center text-[var(--dd-text-muted)]">
                        Pick a note on the left.
                    </div>
                )}
            </main>
        </div>
    );
}

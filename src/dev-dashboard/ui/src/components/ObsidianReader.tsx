import { expandedDirsForNote, parseOpenDirs, serializeOpenDirs } from "@app/utils/obsidian/expanded-dirs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Button } from "@ui/components/button";
import { Copy, Globe, GlobeLock } from "lucide-react";
import { useCallback, useState } from "react";
import { obsidianApi } from "@/lib/api";

interface Props {
    path: string;
}

export function ObsidianReader({ path }: Props) {
    const navigate = useNavigate({ from: "/obsidian" });
    const { open } = useSearch({ from: "/obsidian" });
    const queryClient = useQueryClient();
    const { data, isPending, isError } = useQuery({
        queryKey: ["obsidian", "note", path],
        queryFn: () => obsidianApi.note(path),
    });
    const [copied, setCopied] = useState(false);

    const publish = useMutation({
        mutationFn: () => obsidianApi.publish(path),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["obsidian", "note", path] }),
    });
    const unpublish = useMutation({
        mutationFn: (slug: string) => obsidianApi.unpublish(slug),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["obsidian", "note", path] }),
    });

    const onArticleClick = useCallback(
        (event: React.MouseEvent<HTMLElement>) => {
            const anchor = (event.target as HTMLElement).closest("a[data-obsidian-note]");

            if (!anchor) {
                return;
            }

            event.preventDefault();

            const notePath = anchor.getAttribute("data-obsidian-note");

            if (!notePath) {
                return;
            }

            const nextOpen = expandedDirsForNote(notePath, parseOpenDirs(open));
            const search: { note: string; open?: string } = { note: notePath };
            const openSerialized = serializeOpenDirs(nextOpen);

            if (openSerialized) {
                search.open = openSerialized;
            }

            navigate({ search, replace: false });
        },
        [navigate, open]
    );

    if (isPending) {
        return (
            <div className="dd-panel flex h-full items-center justify-center text-[var(--dd-text-muted)]">
                Loading...
            </div>
        );
    }

    if (isError || !data) {
        return (
            <div className="dd-panel flex h-full items-center justify-center text-[var(--dd-text-muted)]">
                Failed to load note.
            </div>
        );
    }

    const shareUrl = data.publishedSlug ? `${window.location.origin}/share/${data.publishedSlug}` : null;

    return (
        <div className="dd-panel flex h-full flex-col overflow-hidden">
            <div className="flex items-center justify-between gap-2 border-b border-[var(--dd-border)] px-3 py-2 text-[11px]">
                <span className="truncate font-mono text-[var(--dd-text-secondary)]">{path}</span>
                {shareUrl ? (
                    <div className="flex min-w-0 items-center gap-2">
                        <code className="truncate text-[10px] text-[var(--dd-text-muted)]">{shareUrl}</code>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={async () => {
                                await navigator.clipboard.writeText(shareUrl);
                                setCopied(true);
                                setTimeout(() => setCopied(false), 1500);
                            }}
                        >
                            <Copy size={12} /> {copied ? "copied" : "copy"}
                        </Button>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                                if (data.publishedSlug) {
                                    unpublish.mutate(data.publishedSlug);
                                }
                            }}
                        >
                            <GlobeLock size={12} /> unpublish
                        </Button>
                    </div>
                ) : (
                    <Button size="sm" variant="outline" onClick={() => publish.mutate()} disabled={publish.isPending}>
                        <Globe size={12} /> publish
                    </Button>
                )}
            </div>
            <article
                className="dd-markdown flex-1 overflow-auto px-5 py-4"
                dangerouslySetInnerHTML={{ __html: data.html }}
                onClick={onArticleClick}
            />
        </div>
    );
}

import { suggestObsidianFilename } from "@app/dev-dashboard/lib/qa-clipboard";
import type { QaRow } from "@app/dev-dashboard/lib/qa-types";
import { SafeJSON } from "@app/utils/json";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { ToggleGroup, ToggleGroupItem } from "@ui/components/toggle-group";
import { useState } from "react";
import { ObsidianTree } from "./ObsidianTree";

export function QaSaveToObsidianDialog({
    entry,
    open,
    onOpenChange,
}: {
    entry: QaRow;
    open: boolean;
    onOpenChange: (b: boolean) => void;
}) {
    const queryClient = useQueryClient();
    const treeQuery = useQuery({
        queryKey: ["obsidian-tree"],
        queryFn: async () => {
            const r = await fetch("/api/obsidian/tree");

            if (!r.ok) {
                throw new Error(`tree: ${r.status}`);
            }

            return SafeJSON.parse(await r.text()) as {
                entries: import("@app/dev-dashboard/lib/obsidian/types").VaultEntry[];
            };
        },
        enabled: open,
    });
    const [dir, setDir] = useState<string>("Inbox/qa-test");
    const [name, setName] = useState<string>(() => suggestObsidianFilename(entry.question));
    const [mode, setMode] = useState<"create" | "append">("create");
    const [createDir, setCreateDir] = useState(true);
    const [includeFrontmatter, setIncludeFrontmatter] = useState(true);
    const [includeQuestion, setIncludeQuestion] = useState(true);

    const save = useMutation({
        mutationFn: async () => {
            const r = await fetch("/api/qa/save-to-obsidian", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: SafeJSON.stringify({
                    entryId: entry.id,
                    relativeDir: dir,
                    baseName: name,
                    mode,
                    createDir,
                    includeFrontmatter,
                    includeQuestion,
                }),
            });

            if (!r.ok) {
                throw new Error(await r.text());
            }

            return SafeJSON.parse(await r.text()) as { path: string };
        },
        onSuccess: () => {
            setTimeout(() => onOpenChange(false), 1500);
        },
    });

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle>Save to Obsidian</DialogTitle>
                </DialogHeader>
                <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                        <Label>Folder</Label>
                        {treeQuery.data ? (
                            <ObsidianTree
                                entries={treeQuery.data.entries}
                                selected={dir}
                                onSelect={setDir}
                                selectDirectories
                                allowAddDir
                                onTreeChange={() => void queryClient.invalidateQueries({ queryKey: ["obsidian-tree"] })}
                            />
                        ) : treeQuery.isError ? (
                            <div className="space-y-1">
                                <p className="text-xs text-[var(--dd-danger)]">
                                    Failed to load vault: {String(treeQuery.error)}
                                </p>
                                <Button size="sm" variant="outline" onClick={() => void treeQuery.refetch()}>
                                    Retry
                                </Button>
                            </div>
                        ) : (
                            <p className="text-xs text-[var(--dd-text-muted)]">Loading vault…</p>
                        )}
                        <div className="flex items-center gap-2">
                            <Checkbox id="create-dir" checked={createDir} onCheckedChange={(v) => setCreateDir(!!v)} />
                            <Label htmlFor="create-dir">Create directory if missing</Label>
                        </div>
                    </div>
                    <div className="flex flex-col gap-3">
                        <div>
                            <Label htmlFor="name">Filename (no .md)</Label>
                            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
                            <p className="mt-1 text-xs text-[var(--dd-text-muted)]">
                                Server appends -2, -3… if name exists.
                            </p>
                        </div>
                        <div className="space-y-1">
                            <Label>Mode</Label>
                            <ToggleGroup
                                type="single"
                                size="sm"
                                value={mode}
                                onValueChange={(v) => {
                                    if (v === "create" || v === "append") {
                                        setMode(v);
                                    }
                                }}
                            >
                                <ToggleGroupItem value="create">Save as new</ToggleGroupItem>
                                <ToggleGroupItem value="append">Append</ToggleGroupItem>
                            </ToggleGroup>
                        </div>
                        <div className="flex items-center gap-2">
                            <Checkbox
                                id="fm"
                                checked={includeFrontmatter}
                                onCheckedChange={(v) => setIncludeFrontmatter(!!v)}
                            />
                            <Label htmlFor="fm">Include frontmatter</Label>
                        </div>
                        <div className="flex items-center gap-2">
                            <Checkbox
                                id="q"
                                checked={includeQuestion}
                                onCheckedChange={(v) => setIncludeQuestion(!!v)}
                            />
                            <Label htmlFor="q">Include question</Label>
                        </div>
                    </div>
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button onClick={() => save.mutate()} disabled={save.isPending || !name.trim()}>
                        {save.isPending ? "Saving…" : mode === "append" ? "Append" : "Save"}
                    </Button>
                </DialogFooter>
                {save.isError ? <p className="text-xs text-[var(--dd-danger)]">{String(save.error)}</p> : null}
                {save.isSuccess ? <p className="text-xs text-emerald-400">Saved to {save.data?.path}</p> : null}
            </DialogContent>
        </Dialog>
    );
}

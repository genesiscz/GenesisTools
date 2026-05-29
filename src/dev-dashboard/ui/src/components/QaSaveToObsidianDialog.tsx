import { suggestObsidianFilename } from "@app/dev-dashboard/lib/qa-clipboard";
import type { QaRow } from "@app/dev-dashboard/lib/qa-types";
import { SafeJSON } from "@app/utils/json";
import { buildObsidianNoteRelativePath } from "@app/utils/obsidian/filename";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import {
    GlassDialogBody,
    GlassDialogContent,
    GlassDialogDescription,
    GlassDialogEyebrow,
    GlassDialogFooter,
    GlassDialogHeader,
    GlassDialogScroll,
    GlassDialogShell,
    GlassDialogTitle,
} from "@ui/components/glass-dialog";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { SegmentedControl } from "@ui/components/segmented-control";
import { useState } from "react";
import { ObsidianTree, splitObsidianNotePath } from "./ObsidianTree";

function questionPreview(question: string, maxLen = 120): string {
    const oneLine = question.replace(/\s+/g, " ").trim();

    if (oneLine.length <= maxLen) {
        return oneLine;
    }

    return `${oneLine.slice(0, maxLen - 1)}…`;
}

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

    const treeSelected =
        mode === "append" && name.trim() && dir
            ? (buildObsidianNoteRelativePath(dir, name) ?? null)
            : mode === "create"
              ? dir
              : null;

    const onTreeSelect = (path: string): void => {
        if (/\.md$/i.test(path)) {
            setMode("append");
            const { dir: nextDir, baseName } = splitObsidianNotePath(path);
            setDir(nextDir);
            setName(baseName);
            return;
        }

        setMode("create");
        setDir(path);
    };

    const targetPath = name.trim() ? buildObsidianNoteRelativePath(dir, name) : null;

    return (
        <GlassDialogShell open={open} onOpenChange={onOpenChange}>
            <GlassDialogContent
                size="lg"
                fixedHeight
                showCloseButton
                className="dd-panel border-[var(--dd-border)] bg-[var(--dd-bg-panel)]/95 text-[var(--dd-text-primary)] shadow-[0_0_80px_rgba(0,0,0,0.55)]"
            >
                <GlassDialogBody className="gap-0 p-0 sm:p-0">
                    <GlassDialogHeader className="shrink-0 space-y-2 border-b border-[var(--dd-border)]/80 px-5 py-4 text-left sm:px-6">
                        <GlassDialogEyebrow className="text-[var(--dd-text-muted)]">Obsidian vault</GlassDialogEyebrow>
                        <GlassDialogTitle className="dd-accent-text text-lg font-bold tracking-wide">
                            Save to Obsidian
                        </GlassDialogTitle>
                        <GlassDialogDescription className="text-left text-sm leading-relaxed text-[var(--dd-text-secondary)]">
                            {questionPreview(entry.question)}
                        </GlassDialogDescription>
                        {targetPath ? (
                            <p className="font-mono text-[11px] text-[var(--dd-text-muted)]">
                                <span className="text-[var(--dd-text-secondary)]">Target:</span> {targetPath}
                            </p>
                        ) : null}
                    </GlassDialogHeader>

                    <GlassDialogScroll className="px-5 py-5 sm:px-6">
                        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:gap-8">
                            <section className="flex min-h-0 flex-col gap-3">
                                <div>
                                    <Label className="text-xs uppercase tracking-wider text-[var(--dd-text-muted)]">
                                        Vault
                                    </Label>
                                    <p className="mt-0.5 text-[11px] text-[var(--dd-text-muted)]">
                                        Click a folder for{" "}
                                        <span className="text-[var(--dd-text-secondary)]">Save as new</span>, or a note
                                        for <span className="text-[var(--dd-text-secondary)]">Append to file</span>.
                                        Mode updates automatically.
                                    </p>
                                </div>
                                <div className="min-h-[min(22rem,42vh)] rounded-md border border-[var(--dd-border)] bg-black/25 p-3">
                                    {treeQuery.data ? (
                                        <ObsidianTree
                                            entries={treeQuery.data.entries}
                                            selected={treeSelected}
                                            onSelect={onTreeSelect}
                                            selection="both"
                                            allowAddDir={mode === "create"}
                                            listClassName="max-h-[min(20rem,38vh)]"
                                            onTreeChange={() =>
                                                void queryClient.invalidateQueries({ queryKey: ["obsidian-tree"] })
                                            }
                                        />
                                    ) : treeQuery.isError ? (
                                        <div className="space-y-2">
                                            <p className="text-xs text-[var(--dd-danger)]">
                                                Failed to load vault: {String(treeQuery.error)}
                                            </p>
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                onClick={() => void treeQuery.refetch()}
                                            >
                                                Retry
                                            </Button>
                                        </div>
                                    ) : (
                                        <p className="text-xs text-[var(--dd-text-muted)]">Loading vault…</p>
                                    )}
                                </div>
                                {mode === "create" ? (
                                    <div className="flex items-center gap-2">
                                        <Checkbox
                                            id="create-dir"
                                            checked={createDir}
                                            onCheckedChange={(v) => setCreateDir(!!v)}
                                        />
                                        <Label htmlFor="create-dir" className="text-sm text-[var(--dd-text-secondary)]">
                                            Create directory if missing
                                        </Label>
                                    </div>
                                ) : null}
                            </section>

                            <section className="flex flex-col gap-4">
                                <div>
                                    <Label
                                        htmlFor="name"
                                        className="text-xs uppercase tracking-wider text-[var(--dd-text-muted)]"
                                    >
                                        Filename
                                    </Label>
                                    <Input
                                        id="name"
                                        value={name}
                                        onChange={(e) => setName(e.target.value)}
                                        className="mt-2 border-[var(--dd-border)] bg-black/20"
                                        placeholder="note-name"
                                    />
                                    <p className="mt-1.5 text-[11px] text-[var(--dd-text-muted)]">
                                        {mode === "append" ? (
                                            "Filled from the selected note — edit only if you need a different file."
                                        ) : (
                                            <>
                                                Optional <code className="text-[var(--dd-text-secondary)]">.md</code> —
                                                server appends -2, -3… if the name already exists.
                                            </>
                                        )}
                                    </p>
                                </div>

                                <div className="space-y-2">
                                    <Label className="text-xs uppercase tracking-wider text-[var(--dd-text-muted)]">
                                        Mode
                                    </Label>
                                    <SegmentedControl
                                        tone="dd"
                                        aria-label="Save mode"
                                        value={mode}
                                        onValueChange={setMode}
                                        options={[
                                            { value: "create", label: "Save as new" },
                                            { value: "append", label: "Append to file" },
                                        ]}
                                    />
                                </div>

                                <div className="space-y-3 rounded-md border border-[var(--dd-border)]/80 bg-black/15 p-3">
                                    <p className="text-[10px] font-mono uppercase tracking-wider text-[var(--dd-text-muted)]">
                                        Include in note
                                    </p>
                                    <div className="flex items-center gap-2">
                                        <Checkbox
                                            id="fm"
                                            checked={includeFrontmatter}
                                            onCheckedChange={(v) => setIncludeFrontmatter(!!v)}
                                        />
                                        <Label htmlFor="fm" className="text-sm text-[var(--dd-text-secondary)]">
                                            Frontmatter (project, branch, tags)
                                        </Label>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <Checkbox
                                            id="q"
                                            checked={includeQuestion}
                                            onCheckedChange={(v) => setIncludeQuestion(!!v)}
                                        />
                                        <Label htmlFor="q" className="text-sm text-[var(--dd-text-secondary)]">
                                            Question section
                                        </Label>
                                    </div>
                                </div>
                            </section>
                        </div>

                        {save.isError ? (
                            <p className="mt-4 text-xs text-[var(--dd-danger)]">{String(save.error)}</p>
                        ) : null}
                        {save.isSuccess ? (
                            <p className="mt-4 text-xs text-emerald-400">Saved to {save.data?.path}</p>
                        ) : null}
                    </GlassDialogScroll>

                    <GlassDialogFooter className="shrink-0 gap-2 border-t border-[var(--dd-border)]/80 px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
                        <Button
                            type="button"
                            variant="outline"
                            className="border-[var(--dd-border)] bg-black/20 text-[var(--dd-text-secondary)] transition-colors hover:border-primary/60 hover:bg-primary/20 hover:text-[var(--dd-text-primary)]"
                            onClick={() => onOpenChange(false)}
                        >
                            Cancel
                        </Button>
                        <Button
                            type="button"
                            className="transition-[filter,box-shadow] hover:brightness-110 hover:shadow-[0_6px_22px_-8px_var(--color-primary)] active:brightness-95"
                            onClick={() => save.mutate()}
                            disabled={save.isPending || !name.trim()}
                        >
                            {save.isPending ? "Saving…" : mode === "append" ? "Append" : "Save note"}
                        </Button>
                    </GlassDialogFooter>
                </GlassDialogBody>
            </GlassDialogContent>
        </GlassDialogShell>
    );
}

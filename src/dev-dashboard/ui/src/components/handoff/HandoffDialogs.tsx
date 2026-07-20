import type { HandoffPostResponse, HandoffTaskInput } from "@app/dev-dashboard/lib/handoff-types";
import { Button } from "@ui/components/button";
import {
    GlassDialogBody,
    GlassDialogContent,
    GlassDialogFooter,
    GlassDialogHeader,
    GlassDialogScroll,
    GlassDialogShell,
    GlassDialogTitle,
} from "@ui/components/glass-dialog";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Textarea } from "@ui/components/textarea";
import { Trash2 } from "lucide-react";
import { type KeyboardEvent, useState } from "react";
import { useHandoffCreate } from "./useHandoffApi";

const DIALOG_PANEL_CLASS =
    "dd-panel border-[var(--dd-border)] bg-[var(--dd-bg-panel)]/95 text-[var(--dd-text-primary)] shadow-[0_0_80px_rgba(0,0,0,0.55)]";
const LABEL_CLASS = "text-xs uppercase tracking-wider text-[var(--dd-text-muted)]";
const INPUT_CLASS = "mt-1.5 border-[var(--dd-border)] bg-black/20";

export interface ProofDraft {
    answer: string;
    commitIds?: string[];
    context?: string;
}

/** Check-a-task proof dialog (§7.3) — answer prefilled for the human owner. */
export function HandoffProofDialog({
    open,
    taskText,
    onOpenChange,
    onSubmit,
}: {
    open: boolean;
    taskText: string;
    onOpenChange: (b: boolean) => void;
    onSubmit: (proof: ProofDraft) => void;
}) {
    const [answer, setAnswer] = useState("Verified manually via dashboard");
    const [commits, setCommits] = useState("");
    const [context, setContext] = useState("");

    const submit = (): void => {
        const proof: ProofDraft = { answer: answer.trim() };
        const commitIds = commits
            .split(/[\s,]+/)
            .map((c) => c.trim())
            .filter((c) => c.length > 0);

        if (commitIds.length > 0) {
            proof.commitIds = commitIds;
        }

        if (context.trim().length > 0) {
            proof.context = context.trim();
        }

        onSubmit(proof);
        onOpenChange(false);
    };

    return (
        <GlassDialogShell open={open} onOpenChange={onOpenChange}>
            <GlassDialogContent size="md" showCloseButton className={DIALOG_PANEL_CLASS}>
                <GlassDialogBody>
                    <GlassDialogHeader className="text-left">
                        <GlassDialogTitle className="dd-accent-text text-base font-bold">Check task</GlassDialogTitle>
                        <p className="text-xs text-[var(--dd-text-secondary)]">{taskText}</p>
                    </GlassDialogHeader>
                    <div className="flex flex-col gap-3">
                        <div>
                            <Label className={LABEL_CLASS} htmlFor="handoff-proof-answer">
                                Proof / answer
                            </Label>
                            <Textarea
                                id="handoff-proof-answer"
                                value={answer}
                                onChange={(e) => setAnswer(e.target.value)}
                                className={INPUT_CLASS}
                                rows={3}
                            />
                        </div>
                        <div>
                            <Label className={LABEL_CLASS} htmlFor="handoff-proof-commits">
                                Commit SHAs (optional, space/comma separated)
                            </Label>
                            <Input
                                id="handoff-proof-commits"
                                value={commits}
                                onChange={(e) => setCommits(e.target.value)}
                                className={INPUT_CLASS}
                                placeholder="a1b2c3d e4f5a6b"
                            />
                        </div>
                        <div>
                            <Label className={LABEL_CLASS} htmlFor="handoff-proof-context">
                                Context (optional)
                            </Label>
                            <Input
                                id="handoff-proof-context"
                                value={context}
                                onChange={(e) => setContext(e.target.value)}
                                className={INPUT_CLASS}
                                placeholder="side effects, caveats, links"
                            />
                        </div>
                    </div>
                    <GlassDialogFooter className="gap-2 sm:flex-row sm:justify-end">
                        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="button" onClick={submit} disabled={answer.trim().length === 0}>
                            Check task
                        </Button>
                    </GlassDialogFooter>
                </GlassDialogBody>
            </GlassDialogContent>
        </GlassDialogShell>
    );
}

interface TaskDraft {
    text: string;
    acceptanceCriteria: string;
}

/** New-handoff dialog (§7.3): title, description, task composer rows, target/refs. */
export function HandoffCreateDialog({
    open,
    onOpenChange,
    onCreated,
}: {
    open: boolean;
    onOpenChange: (b: boolean) => void;
    onCreated: (res: HandoffPostResponse) => void;
}) {
    const create = useHandoffCreate();
    const [title, setTitle] = useState("");
    const [description, setDescription] = useState("");
    const [tasks, setTasks] = useState<TaskDraft[]>([{ text: "", acceptanceCriteria: "" }]);
    const [targetName, setTargetName] = useState("");
    const [refs, setRefs] = useState("");

    const setTask = (index: number, patch: Partial<TaskDraft>): void => {
        setTasks((prev) => prev.map((t, i) => (i === index ? { ...t, ...patch } : t)));
    };

    const addTaskRow = (): void => {
        setTasks((prev) => [...prev, { text: "", acceptanceCriteria: "" }]);
    };

    const validTasks = tasks.filter((t) => t.text.trim().length > 0);

    const submit = (): void => {
        const payload: {
            title: string;
            description?: string;
            tasks: HandoffTaskInput[];
            target?: { sessionName: string };
            refs?: string[];
        } = {
            title: title.trim(),
            tasks: validTasks.map((t) => {
                const task: HandoffTaskInput = { text: t.text.trim() };

                if (t.acceptanceCriteria.trim().length > 0) {
                    task.acceptanceCriteria = t.acceptanceCriteria.trim();
                }

                return task;
            }),
        };

        if (description.trim().length > 0) {
            payload.description = description.trim();
        }

        if (targetName.trim().length > 0) {
            payload.target = { sessionName: targetName.trim() };
        }

        const refList = refs
            .split(/\n+/)
            .map((r) => r.trim())
            .filter((r) => r.length > 0);

        if (refList.length > 0) {
            payload.refs = refList;
        }

        create.mutate(payload, {
            onSuccess: (res) => {
                onCreated(res);
                onOpenChange(false);
                setTitle("");
                setDescription("");
                setTasks([{ text: "", acceptanceCriteria: "" }]);
                setTargetName("");
                setRefs("");
            },
        });
    };

    const onDialogKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();

            if (!create.isPending && title.trim().length > 0 && validTasks.length > 0) {
                submit();
            }
        }
    };

    return (
        <GlassDialogShell open={open} onOpenChange={onOpenChange}>
            <GlassDialogContent
                size="lg"
                fixedHeight
                showCloseButton
                className={DIALOG_PANEL_CLASS}
                onKeyDown={onDialogKeyDown}
            >
                <GlassDialogBody className="gap-0 p-0 sm:p-0">
                    <GlassDialogHeader className="shrink-0 border-b border-[var(--dd-border)]/80 px-5 py-4 text-left">
                        <GlassDialogTitle className="dd-accent-text text-lg font-bold">New handoff</GlassDialogTitle>
                        <p className="text-xs text-[var(--dd-text-secondary)]">
                            A task list for an agent session — it claims, works, checks tasks off with proof.
                        </p>
                    </GlassDialogHeader>
                    <GlassDialogScroll className="px-5 py-4">
                        <div className="flex flex-col gap-4">
                            <div>
                                <Label className={LABEL_CLASS} htmlFor="handoff-create-title">
                                    Title
                                </Label>
                                <Input
                                    id="handoff-create-title"
                                    value={title}
                                    onChange={(e) => setTitle(e.target.value)}
                                    className={INPUT_CLASS}
                                    placeholder="Fix e2e Active-filter semantics"
                                />
                            </div>
                            <div>
                                <Label className={LABEL_CLASS} htmlFor="handoff-create-description">
                                    Description (markdown, optional)
                                </Label>
                                <Textarea
                                    id="handoff-create-description"
                                    value={description}
                                    onChange={(e) => setDescription(e.target.value)}
                                    className={INPUT_CLASS}
                                    rows={3}
                                    placeholder="the why / context the worker needs"
                                />
                            </div>
                            <div className="flex flex-col gap-2">
                                <Label className={LABEL_CLASS}>Tasks</Label>
                                {tasks.map((task, index) => (
                                    <div
                                        key={index}
                                        className="flex flex-col gap-1.5 rounded border border-[var(--dd-border)]/70 bg-black/15 p-2"
                                    >
                                        <div className="flex items-start gap-2">
                                            <span className="mt-2 text-xs text-[var(--dd-text-muted)]">
                                                #{index + 1}
                                            </span>
                                            <Textarea
                                                value={task.text}
                                                onChange={(e) => setTask(index, { text: e.target.value })}
                                                className="min-h-[2.25rem] border-[var(--dd-border)] bg-black/20"
                                                rows={2}
                                                placeholder="what to do"
                                            />
                                            {tasks.length > 1 ? (
                                                <button
                                                    type="button"
                                                    className="mt-1.5 cursor-pointer text-[var(--dd-text-muted)] hover:text-[var(--dd-danger)]"
                                                    onClick={() =>
                                                        setTasks((prev) => prev.filter((_, i) => i !== index))
                                                    }
                                                    title="remove row"
                                                >
                                                    <Trash2 className="h-3.5 w-3.5" />
                                                </button>
                                            ) : null}
                                        </div>
                                        <Input
                                            value={task.acceptanceCriteria}
                                            onChange={(e) => setTask(index, { acceptanceCriteria: e.target.value })}
                                            className="ml-6 border-[var(--dd-border)] bg-black/10 text-xs"
                                            placeholder="acceptance criteria (optional but recommended)"
                                            onKeyDown={(e) => {
                                                if (
                                                    e.key !== "Enter" ||
                                                    e.metaKey ||
                                                    e.ctrlKey ||
                                                    index !== tasks.length - 1
                                                ) {
                                                    return;
                                                }

                                                e.preventDefault();
                                                addTaskRow();
                                            }}
                                        />
                                    </div>
                                ))}
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="self-start"
                                    onClick={addTaskRow}
                                >
                                    + Add task row
                                </Button>
                            </div>
                            <div className="grid gap-4 sm:grid-cols-2">
                                <div>
                                    <Label className={LABEL_CLASS} htmlFor="handoff-create-target">
                                        Target session name (optional)
                                    </Label>
                                    <Input
                                        id="handoff-create-target"
                                        value={targetName}
                                        onChange={(e) => setTargetName(e.target.value)}
                                        className={INPUT_CLASS}
                                        placeholder="gt-worker"
                                    />
                                </div>
                                <div>
                                    <Label className={LABEL_CLASS} htmlFor="handoff-create-refs">
                                        Refs (one per line, optional)
                                    </Label>
                                    <Textarea
                                        id="handoff-create-refs"
                                        value={refs}
                                        onChange={(e) => setRefs(e.target.value)}
                                        className={INPUT_CLASS}
                                        rows={2}
                                        placeholder={"src/foo.ts\nhttps://github.com/...pull/1"}
                                    />
                                </div>
                            </div>
                            {create.isError ? (
                                <p className="text-xs text-[var(--dd-danger)]">{String(create.error)}</p>
                            ) : null}
                        </div>
                    </GlassDialogScroll>
                    <GlassDialogFooter className="shrink-0 gap-2 border-t border-[var(--dd-border)]/80 px-5 py-4 sm:flex-row sm:justify-end">
                        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button
                            type="button"
                            onClick={submit}
                            disabled={create.isPending || title.trim().length === 0 || validTasks.length === 0}
                        >
                            {create.isPending ? "Posting…" : "Post handoff"}
                        </Button>
                    </GlassDialogFooter>
                </GlassDialogBody>
            </GlassDialogContent>
        </GlassDialogShell>
    );
}

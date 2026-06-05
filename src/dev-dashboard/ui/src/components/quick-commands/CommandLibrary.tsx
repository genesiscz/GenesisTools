import type { SavedCommand } from "@app/dev-dashboard/lib/commands/types";
import { Button } from "@ui/components/button";
import { Play, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";

interface CommandLibraryProps {
    commands: SavedCommand[];
    /** Run a snippet → the route spawns a tmux session + opens the send-target dialog. */
    onRun: (command: SavedCommand) => void;
    onCreate: (input: { label: string; command: string }) => void;
    onDelete: (id: string) => void;
    creating: boolean;
    runningId: string | null;
    deletingId: string | null;
}

/**
 * The quick-commands snippet library: an add form on top, then a grid of one-tap snippet cards.
 * Tapping Run hands the snippet to the route (which spawns a tmux session running it, then opens the
 * existing `CmuxSendTargetDialog` to attach it). Styled with the shared `dd-*` tokens (no raw palette).
 */
export function CommandLibrary({
    commands,
    onRun,
    onCreate,
    onDelete,
    creating,
    runningId,
    deletingId,
}: CommandLibraryProps) {
    const [label, setLabel] = useState("");
    const [command, setCommand] = useState("");

    const canSubmit = label.trim().length > 0 && command.trim().length > 0 && !creating;

    const handleSubmit = (e: FormEvent) => {
        e.preventDefault();

        if (!canSubmit) {
            return;
        }

        onCreate({ label: label.trim(), command: command.trim() });
        setLabel("");
        setCommand("");
    };

    return (
        <div className="flex flex-col gap-4">
            <form
                onSubmit={handleSubmit}
                className="dd-panel flex flex-wrap items-center gap-2 p-4"
                aria-label="Add quick command"
            >
                <input
                    type="text"
                    aria-label="Command label"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="Label (e.g. Run tests)"
                    className="min-w-[10rem] flex-1 rounded-md border border-[var(--dd-border)] bg-[var(--dd-bg-panel)] px-3 py-1.5 text-sm text-[var(--dd-text-primary)] outline-none focus:border-[var(--dd-accent-from)]"
                />
                <input
                    type="text"
                    aria-label="Command text"
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    placeholder="Command (e.g. bun test)"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    className="min-w-[12rem] flex-[2] rounded-md border border-[var(--dd-border)] bg-[var(--dd-bg-panel)] px-3 py-1.5 font-mono text-sm text-[var(--dd-text-secondary)] outline-none focus:border-[var(--dd-accent-from)]"
                />
                <Button
                    type="submit"
                    variant="ghost"
                    size="sm"
                    disabled={!canSubmit}
                    className="dd-btn-accent shrink-0 hover:bg-transparent"
                >
                    {creating ? "Saving..." : "Add command"}
                </Button>
            </form>

            {commands.length === 0 ? (
                <div className="dd-panel flex h-40 items-center justify-center p-8 text-center text-[var(--dd-text-muted)]">
                    No saved commands yet — add your first one-tap snippet above.
                </div>
            ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {commands.map((cmd) => (
                        <div key={cmd.id} data-command-id={cmd.id} className="dd-panel flex flex-col gap-3 p-4">
                            <div className="flex min-w-0 flex-col gap-1">
                                <span className="dd-accent-text truncate text-sm font-semibold">{cmd.label}</span>
                                <code className="truncate font-mono text-xs text-[var(--dd-text-muted)]">
                                    {cmd.command}
                                </code>
                            </div>
                            <div className="flex items-center justify-between gap-2">
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    disabled={runningId === cmd.id}
                                    onClick={() => onRun(cmd)}
                                    className="dd-btn-accent hover:bg-transparent"
                                >
                                    <Play size={14} />
                                    {runningId === cmd.id ? "Running..." : "Run"}
                                </Button>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    disabled={deletingId === cmd.id}
                                    onClick={() => onDelete(cmd.id)}
                                    className="font-mono text-[11px] text-[var(--dd-text-muted)] hover:border-rose-400/30 hover:bg-rose-400/10 hover:text-rose-300"
                                >
                                    <Trash2 size={14} />
                                    {deletingId === cmd.id ? "Removing..." : "Delete"}
                                </Button>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

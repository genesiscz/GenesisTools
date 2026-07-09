import type { AnnotationIntent } from "@app/dev-dashboard/contract/dto";
import { useState } from "react";

const INTENTS: AnnotationIntent[] = ["fix", "investigate", "refactor", "redesign", "reshoot", "other"];

export interface AnnotateSubmitInput {
    intent: AnnotationIntent;
    intentOther: string;
    prompt: string;
}

interface AnnotateComposerProps {
    screenX: number;
    screenY: number;
    onSubmit: (input: AnnotateSubmitInput) => void;
    onCancel: () => void;
}

/** Anchored popup opened right after a region drag completes (screen-space, outside the world transform). */
export function AnnotateComposer({ screenX, screenY, onSubmit, onCancel }: AnnotateComposerProps) {
    const [intent, setIntent] = useState<AnnotationIntent>("fix");
    const [intentOther, setIntentOther] = useState("");
    const [prompt, setPrompt] = useState("");

    const submit = () => {
        if (!prompt.trim() || (intent === "other" && !intentOther.trim())) {
            return;
        }

        onSubmit({ intent, intentOther, prompt: prompt.trim() });
    };

    return (
        <div
            className="absolute z-30 w-72 rounded-md border border-[var(--dd-border)] bg-[var(--dd-bg-panel)] p-3 shadow-xl"
            style={{ left: screenX, top: screenY }}
        >
            <div className="mb-2 flex flex-wrap gap-1">
                {INTENTS.map((value) => (
                    <button
                        key={value}
                        type="button"
                        onClick={() => setIntent(value)}
                        className={
                            intent === value
                                ? "dd-btn-accent rounded-full border border-transparent px-2 py-0.5 text-xs"
                                : "rounded-full border border-[var(--dd-border)] px-2 py-0.5 text-xs text-[var(--dd-text-secondary)] hover:text-[var(--dd-text-primary)]"
                        }
                    >
                        {value}
                    </button>
                ))}
            </div>
            {intent === "other" ? (
                <input
                    type="text"
                    value={intentOther}
                    onChange={(e) => setIntentOther(e.target.value)}
                    placeholder="describe intent..."
                    className="mb-2 w-full rounded border border-[var(--dd-border)] bg-transparent px-2 py-1 text-xs text-[var(--dd-text-primary)] outline-none"
                />
            ) : null}
            <textarea
                autoFocus
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        submit();
                    } else if (e.key === "Escape") {
                        onCancel();
                    }
                }}
                placeholder="what should change here?"
                rows={3}
                className="w-full resize-none rounded border border-[var(--dd-border)] bg-transparent px-2 py-1 text-sm text-[var(--dd-text-primary)] outline-none"
            />
            <div className="mt-2 flex justify-end gap-2">
                <button
                    type="button"
                    onClick={onCancel}
                    className="px-2 py-1 text-xs text-[var(--dd-text-secondary)] hover:text-[var(--dd-text-primary)]"
                >
                    cancel
                </button>
                <button
                    type="button"
                    onClick={submit}
                    disabled={!prompt.trim() || (intent === "other" && !intentOther.trim())}
                    className="dd-btn-accent rounded-full px-3 py-1 text-xs"
                >
                    add
                </button>
            </div>
        </div>
    );
}

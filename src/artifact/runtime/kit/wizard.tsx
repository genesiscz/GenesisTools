import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "./forms";
import { type BodyContent, renderBody, TONE_BORDER, TONE_TEXT } from "./primitives";
import { STEP_GLYPH, STEP_TONE, type StepStatus } from "./structure";

/**
 * A multi-step flow: a stepper on top, one step body at a time, Back and Next
 * below. Every body stays mounted (inactive ones are `hidden`), so what a
 * person typed survives Back and Next. A step can block Next with `validate`.
 */

export interface WizardStep {
    id: string;
    label: string;
    description?: BodyContent;
    optional?: boolean;
    /** Return false or a message to block Next. May be async. Default: valid. */
    validate?: () => boolean | string | Promise<boolean | string>;
    content: ReactNode;
}

export interface WizardProps {
    steps: WizardStep[];
    /** Controlled current step id. */
    current?: string;
    /** Start step when uncontrolled. Default: the first. */
    initial?: string;
    onChange?: (id: string, from: string) => void;
    onFinish?: () => void | Promise<void>;
    /** "linear": later steps stay locked until earlier ones are done. "free": any step by click. Default "linear". */
    mode?: "linear" | "free";
    labels?: { back?: string; next?: string; finish?: string; skip?: string };
    /** Keep the step in the URL hash, like Tabs. Default false. */
    hash?: boolean;
}

/** Index of the first step that is neither done nor skipped: the furthest a linear wizard may go. */
export function wizardFrontier(steps: WizardStep[], settled: Record<string, "done" | "skipped">): number {
    const open = steps.findIndex((step) => !settled[step.id]);

    return open === -1 ? steps.length - 1 : open;
}

function hashStep(steps: WizardStep[]): string | null {
    if (typeof window === "undefined" || !window.location.hash) {
        return null;
    }

    let id = window.location.hash.slice(1);

    try {
        id = decodeURIComponent(id);
    } catch {
        // A malformed escape: compare the raw text instead.
    }

    return steps.some((step) => step.id === id) ? id : null;
}

const SINGLE_LINE = new Set([
    "text",
    "number",
    "date",
    "email",
    "search",
    "tel",
    "url",
    "password",
    "month",
    "week",
    "time",
]);

/** Multi-step flow with validation, optional steps and a stepper. */
export function Wizard({
    steps,
    current,
    initial,
    onChange,
    onFinish,
    mode = "linear",
    labels = {},
    hash = false,
}: WizardProps) {
    const [settled, setSettled] = useState<Record<string, "done" | "skipped">>({});
    const frontier = mode === "free" ? steps.length - 1 : wizardFrontier(steps, settled);
    const [own, setOwn] = useState<string>(() => {
        const fromHash = hash ? hashStep(steps) : null;
        const hashIndex = fromHash ? steps.findIndex((s) => s.id === fromHash) : -1;
        const reachable = mode === "free" || hashIndex === 0;

        return fromHash && reachable ? fromHash : (initial ?? steps[0]?.id ?? "");
    });
    const activeId = current ?? own;
    const activeIndex = Math.max(
        0,
        steps.findIndex((step) => step.id === activeId)
    );
    const step = steps[activeIndex];
    const last = activeIndex === steps.length - 1;
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const busyRef = useRef(false);
    const headingRefs = useRef(new Map<string, HTMLHeadingElement>());
    const moved = useRef(false);

    useEffect(() => {
        if (moved.current) {
            headingRefs.current.get(activeId)?.focus();
        }
    }, [activeId]);

    const go = (id: string): void => {
        if (id === activeId) {
            return;
        }

        moved.current = true;
        setError(null);

        if (current === undefined) {
            setOwn(id);
        }

        if (hash && typeof window !== "undefined") {
            window.history.replaceState(null, "", `#${encodeURIComponent(id)}`);
        }

        onChange?.(id, activeId);
    };

    const runValidate = async (): Promise<boolean> => {
        const verdict = step?.validate ? await step.validate() : true;

        if (verdict === true) {
            setError(null);

            return true;
        }

        setError(typeof verdict === "string" ? verdict : "Check this step before you continue.");

        return false;
    };

    const next = async (): Promise<void> => {
        if (!step || busyRef.current) {
            return;
        }

        busyRef.current = true;
        setBusy(true);

        try {
            if (!(await runValidate())) {
                return;
            }

            setSettled((prev) => ({ ...prev, [step.id]: "done" }));

            if (last) {
                await onFinish?.();
            } else {
                go(steps[activeIndex + 1].id);
            }
        } finally {
            busyRef.current = false;
            setBusy(false);
        }
    };

    const skip = (): void => {
        if (!step || last || busyRef.current) {
            return;
        }

        setSettled((prev) => ({ ...prev, [step.id]: "skipped" }));
        go(steps[activeIndex + 1].id);
    };

    const onPanelKey = (event: KeyboardEvent<HTMLDivElement>): void => {
        const target = event.target;

        if (
            event.key === "Enter" &&
            target instanceof HTMLInputElement &&
            SINGLE_LINE.has(target.type) &&
            !event.nativeEvent.isComposing
        ) {
            event.preventDefault();
            void next();
        }
    };

    const statusOf = (s: WizardStep, i: number): StepStatus => {
        if (i === activeIndex) {
            return "active";
        }

        return settled[s.id] ?? "pending";
    };

    return (
        <div className="my-4 rounded-card border border-line bg-panel/60">
            <nav aria-label="Steps" className="border-b border-line px-4 py-3">
                <ol className="flex flex-wrap items-center gap-x-2 gap-y-2">
                    {steps.map((s, i) => {
                        const status = statusOf(s, i);
                        const locked = i > frontier && i !== activeIndex;
                        const tone = STEP_TONE[status];

                        return (
                            <li key={s.id} className="flex items-center gap-2">
                                {i > 0 ? <span aria-hidden="true" className="h-px w-5 bg-line" /> : null}
                                <button
                                    type="button"
                                    aria-current={i === activeIndex ? "step" : undefined}
                                    aria-disabled={locked || undefined}
                                    data-status={status}
                                    onClick={() => {
                                        if (!locked) {
                                            go(s.id);
                                        }
                                    }}
                                    className={`inline-flex items-center gap-2 rounded-card px-1.5 py-1 text-sm focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-info ${
                                        locked ? "cursor-not-allowed text-dim" : "text-ink hover:bg-panel"
                                    }`}
                                >
                                    <span
                                        aria-hidden="true"
                                        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs ${
                                            status === "active"
                                                ? "border-accent bg-accent text-canvas"
                                                : `${TONE_BORDER[tone]} ${TONE_TEXT[tone]} ${status === "done" ? "bg-ok/15" : "bg-panel"}`
                                        }`}
                                    >
                                        {status === "active" ? i + 1 : STEP_GLYPH[status]}
                                    </span>
                                    <span className={status === "pending" || status === "skipped" ? "text-dim" : ""}>
                                        {s.label}
                                        {s.optional ? <span className="ml-1 text-xs text-dim">(optional)</span> : null}
                                    </span>
                                    <span className="sr-only">{`, ${status}${locked ? ", locked" : ""}`}</span>
                                </button>
                            </li>
                        );
                    })}
                </ol>
            </nav>
            <div className="px-4 py-4" onKeyDown={onPanelKey}>
                {steps.map((s, i) => (
                    <section key={s.id} hidden={i !== activeIndex} aria-labelledby={`wizard-${s.id}-title`}>
                        <h3
                            id={`wizard-${s.id}-title`}
                            ref={(el) => {
                                if (el) {
                                    headingRefs.current.set(s.id, el);
                                } else {
                                    headingRefs.current.delete(s.id);
                                }
                            }}
                            tabIndex={-1}
                            className="text-base font-semibold text-ink outline-none"
                        >
                            {s.label}
                        </h3>
                        {s.description ? (
                            <div className="mt-1 text-sm text-dim">{renderBody(s.description)}</div>
                        ) : null}
                        <div className="mt-3">{s.content}</div>
                    </section>
                ))}
            </div>
            <div className="border-t border-line px-4 py-3">
                <div role="alert" className="mb-2 text-sm text-err empty:hidden">
                    {error}
                </div>
                <div className="flex items-center gap-2">
                    <Button
                        variant="secondary"
                        disabled={activeIndex === 0 || busy}
                        onClick={() => go(steps[activeIndex - 1].id)}
                    >
                        {labels.back ?? "Back"}
                    </Button>
                    <span className="flex-1" />
                    {step?.optional && !last ? (
                        <Button variant="ghost" disabled={busy} onClick={skip}>
                            {labels.skip ?? "Skip"}
                        </Button>
                    ) : null}
                    <Button variant="primary" busy={busy} onClick={() => void next()}>
                        {last ? (labels.finish ?? "Finish") : (labels.next ?? "Next")}
                    </Button>
                </div>
            </div>
        </div>
    );
}

import { type ReactNode, useEffect, useId, useState } from "react";
import { Button } from "./forms";
import {
    Badge,
    type BodyContent,
    Card,
    CardGrid,
    Note,
    renderBody,
    SegmentedControl,
    type SegmentedOption,
    type Tone,
} from "./primitives";
import { StickyControls } from "./sticky-controls";
import { Tooltip } from "./tooltip";

export type DecisionChoices = Record<string, string>;

export interface DecisionOption extends SegmentedOption {
    hint?: BodyContent;
    disabledWhen?: (choices: DecisionChoices) => string | undefined;
}

export interface DecisionPoint {
    key: string;
    number?: string;
    title: string;
    state?: string;
    tone?: Tone;
    options: DecisionOption[];
    note?: BodyContent;
    locked?: boolean;
    disabledWhen?: (choices: DecisionChoices) => string | undefined;
}

export interface DecisionPreset {
    id: string;
    label: string;
    choices: DecisionChoices;
    note?: BodyContent;
}

export interface DecisionBoardApi {
    changed: string[];
    preset?: string;
    /** Place this panel inside the page when controlsPlacement is slot. */
    controls: ReactNode;
}

export interface DecisionBoardProps {
    points: DecisionPoint[];
    presets?: DecisionPreset[];
    initial: DecisionChoices;
    /** Persist choices in #d=key:value,...; a string chooses a separate hash namespace. Default on. */
    hash?: boolean | string;
    copy?: boolean;
    columns?: 2 | 3;
    sticky?: boolean;
    initialExpanded?: boolean;
    /** Use slot when the choices drive several sections; render api.controls at the desired section. */
    controlsPlacement?: "before" | "slot";
    /** Apply domain constraints after a preset, a click or a restored URL. */
    normalize?: (choices: DecisionChoices) => DecisionChoices;
    labels?: {
        presets?: string;
        expand?: string;
        collapse?: string;
        copy?: string;
        copied?: string;
        changed?: string;
        unlock?: string;
        locked?: string;
    };
    children: (choices: DecisionChoices, api: DecisionBoardApi) => ReactNode;
}

/** Validate the URL at its boundary, ignoring unknown points and values while preserving defaults. */
export function decisionChoicesFromHash({
    hash,
    namespace = "d",
    points,
    initial,
}: {
    hash: string;
    namespace?: string;
    points: DecisionPoint[];
    initial: DecisionChoices;
}): DecisionChoices {
    const encoded = hash
        .replace(/^#/, "")
        .split("&")
        .find((part) => part.startsWith(`${encodeURIComponent(namespace)}=`));
    const result = { ...initial };
    if (!encoded) {
        return result;
    }

    for (const entry of encoded.slice(encoded.indexOf("=") + 1).split(",")) {
        const separator = entry.indexOf(":");
        if (separator < 0) {
            continue;
        }

        let key: string;
        let value: string;
        try {
            key = decodeURIComponent(entry.slice(0, separator));
            value = decodeURIComponent(entry.slice(separator + 1));
        } catch {
            continue;
        }

        const point = points.find((candidate) => candidate.key === key);
        if (point?.options.some((option) => option.value === value)) {
            result[key] = value;
        }
    }

    return result;
}

export function decisionChoicesHash({
    hash,
    namespace = "d",
    choices,
}: {
    hash: string;
    namespace?: string;
    choices: DecisionChoices;
}): string {
    const prefix = `${encodeURIComponent(namespace)}=`;
    const parts = hash
        .replace(/^#/, "")
        .split("&")
        .filter((part) => part && !part.startsWith(prefix));
    const state = Object.entries(choices)
        .map(([key, value]) => `${encodeURIComponent(key)}:${encodeURIComponent(value)}`)
        .join(",");
    return `#${[...parts, `${prefix}${state}`].join("&")}`;
}

/** Decision controls and a pure render function, with presets and URL-restorable combinations. */
export function DecisionBoard({
    points,
    presets = [],
    initial,
    hash = true,
    copy = true,
    columns = 3,
    sticky = true,
    initialExpanded = false,
    controlsPlacement = "before",
    normalize,
    labels = {},
    children,
}: DecisionBoardProps) {
    const namespace = typeof hash === "string" ? hash : "d";
    const apply = (value: DecisionChoices) => normalize?.(value) ?? value;
    const [choices, setChoices] = useState(() =>
        apply(
            hash && typeof window !== "undefined"
                ? decisionChoicesFromHash({ hash: window.location.hash, namespace, points, initial })
                : { ...initial }
        )
    );
    const [expanded, setExpanded] = useState(initialExpanded);
    const [unlocked, setUnlocked] = useState<string[]>([]);
    const [copied, setCopied] = useState(false);
    const [copyError, setCopyError] = useState<string>();
    const presetChoices = (preset: DecisionPreset) => apply({ ...initial, ...preset.choices });
    const matches = (preset: DecisionPreset) =>
        points.every((point) => presetChoices(preset)[point.key] === choices[point.key]);
    const [baseline, setBaseline] = useState(() => presets.find(matches)?.id);
    const bodyId = useId();
    const preset =
        presets.find((candidate) => candidate.id === baseline && matches(candidate)) ?? presets.find(matches);
    const baselinePreset = presets.find((candidate) => candidate.id === baseline);
    const baselineChoices = baselinePreset ? presetChoices(baselinePreset) : initial;
    const changed = points
        .filter((point) => choices[point.key] !== baselineChoices[point.key])
        .map((point) => point.key);

    useEffect(() => {
        if (!hash) {
            return;
        }

        const next = decisionChoicesHash({ hash: window.location.hash, namespace, choices });
        window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${next}`);
    }, [choices, hash, namespace]);

    useEffect(() => {
        if (!hash) {
            return;
        }

        const restore = () => {
            const prefix = `${encodeURIComponent(namespace)}=`;
            if (
                !window.location.hash
                    .replace(/^#/, "")
                    .split("&")
                    .some((part) => part.startsWith(prefix))
            ) {
                const next = decisionChoicesHash({ hash: window.location.hash, namespace, choices });
                window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${next}`);
                return;
            }

            setChoices(apply(decisionChoicesFromHash({ hash: window.location.hash, namespace, points, initial })));
            setCopied(false);
        };
        window.addEventListener("hashchange", restore);
        return () => window.removeEventListener("hashchange", restore);
    }, [hash, namespace, points, initial, normalize, choices]);

    /** Normalize a change, then put every still-locked choice back: `normalize` may not move a locked decision. */
    const applyKeepingLocks = (current: DecisionChoices, next: DecisionChoices) => {
        const normalized = { ...apply(next) };
        for (const point of points) {
            if (point.locked && !unlocked.includes(point.key)) {
                normalized[point.key] = current[point.key];
            }
        }

        return normalized;
    };
    const setChoice = (point: DecisionPoint, value: string) => {
        setChoices((current) => applyKeepingLocks(current, { ...current, [point.key]: value }));
        setCopied(false);
    };
    const controls = (point: DecisionPoint) => {
        const reason = point.disabledWhen?.(choices);
        const locked = point.locked && !unlocked.includes(point.key);
        const options = point.options.map((option) => ({
            ...option,
            disabled:
                reason ??
                (locked ? (labels.locked ?? "Unlock to change this decision") : undefined) ??
                option.disabledWhen?.(choices) ??
                option.disabled,
        }));
        return (
            <>
                <SegmentedControl
                    ariaLabel={point.title}
                    options={options}
                    value={choices[point.key] ?? ""}
                    onChange={(value) => setChoice(point, value)}
                />
                {locked ? (
                    <Button variant="ghost" size="sm" onClick={() => setUnlocked((current) => [...current, point.key])}>
                        {labels.unlock ?? "Unlock"}
                    </Button>
                ) : null}
                {changed.includes(point.key) ? <Badge tone="info">{labels.changed ?? "Changed"}</Badge> : null}
                {reason ? <Note>{reason}</Note> : null}
            </>
        );
    };

    const panel = (
        <StickyControls sticky={sticky} label="Decision controls">
            <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2">
                {presets.length ? (
                    <SegmentedControl
                        label={labels.presets ?? "Presets"}
                        options={presets.map((item) => ({ value: item.id, label: item.label }))}
                        value={preset?.id ?? ""}
                        onChange={(id) => {
                            const selected = presets.find((item) => item.id === id);
                            if (selected) {
                                setChoices((current) => {
                                    const next = { ...initial, ...selected.choices };
                                    for (const point of points) {
                                        if (point.locked && !unlocked.includes(point.key)) {
                                            next[point.key] = current[point.key];
                                        }
                                    }

                                    return applyKeepingLocks(current, next);
                                });
                                setBaseline(id);
                                setCopied(false);
                            }
                        }}
                    />
                ) : null}
                <Button
                    variant="ghost"
                    size="sm"
                    aria-expanded={expanded}
                    aria-controls={bodyId}
                    onClick={() => setExpanded(!expanded)}
                >
                    {expanded
                        ? (labels.collapse ?? "Collapse decisions ▴")
                        : (labels.expand ?? "Expand decisions with notes ▾")}
                </Button>
                {copy ? (
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={async () => {
                            try {
                                await navigator.clipboard.writeText(
                                    points
                                        .map((point) => `${point.number ?? point.key}: ${choices[point.key] ?? ""}`)
                                        .join(", ")
                                );
                                setCopied(true);
                                setCopyError(undefined);
                            } catch (error) {
                                setCopyError(error instanceof Error ? error.message : "Clipboard unavailable");
                            }
                        }}
                    >
                        {copied ? (labels.copied ?? "Copied") : (labels.copy ?? "Copy choices")}
                    </Button>
                ) : null}
            </div>
            {preset?.note ? <Note>{preset.note}</Note> : null}
            {copyError ? (
                <p role="status" className="text-sm text-err">
                    {copyError}
                </p>
            ) : null}
            <div
                id={bodyId}
                className={
                    expanded ? "max-h-[62vh] overflow-y-auto pr-1" : "flex flex-wrap items-center gap-x-3.5 gap-y-2"
                }
            >
                {expanded ? (
                    <CardGrid columns={columns}>
                        {points.map((point) => (
                            <Card
                                key={point.key}
                                kicker={`${point.number ?? point.key}${point.state ? ` · ${point.state}` : ""}`}
                                title={point.title}
                                tone={point.tone}
                                edge="left"
                            >
                                {controls(point)}
                                {point.note ? <Note>{point.note}</Note> : null}
                                {point.options.find((option) => option.value === choices[point.key])?.hint ? (
                                    <Note>
                                        {renderBody(
                                            point.options.find((option) => option.value === choices[point.key])?.hint
                                        )}
                                    </Note>
                                ) : null}
                            </Card>
                        ))}
                    </CardGrid>
                ) : (
                    points.map((point) => (
                        <Tooltip
                            key={point.key}
                            placement="bottom"
                            content={{
                                title: `${point.number ?? point.key} · ${point.title}`,
                                subtitle: point.state,
                                note: point.note,
                                noteTone: point.tone,
                            }}
                        >
                            <div className="flex min-w-0 max-w-full items-center gap-1.5">
                                <Badge tag tone={point.tone}>
                                    {point.number ?? point.key}
                                </Badge>
                                {controls(point)}
                            </div>
                        </Tooltip>
                    ))
                )}
            </div>
        </StickyControls>
    );
    const result = children(choices, { changed, preset: preset?.id, controls: panel });
    return controlsPlacement === "slot" ? (
        result
    ) : (
        <div className="flex flex-col gap-3" data-decision-board="">
            {panel}
            {result}
        </div>
    );
}

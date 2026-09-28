import type { Snapshot } from "./filesystem";
import { type Evidence, evidenceRequest } from "./requests";
import { type Inspection, inspect, type SourceUnit, sourceForUnit, splitSource } from "./source";
import {
    EvaluationFailure,
    type Evaluator,
    type EvidenceRange,
    type Excerpt,
    type FileEvidence,
    type IssueCount,
    type Range,
    type ReadingLead,
    toJson,
} from "./types";

interface Span {
    start: number;
    end: number;
}

const SOURCE_UNIT_BYTES = 24_000;
/** A span is kept above this value of `max(min(q, scope), ref)`. */
export const KEEP_THRESHOLD = 0.5;
/** A unit becomes a named reading lead above this value. */
export const LEAD_THRESHOLD = 0.25;
/** Printed excerpts are the stricter cut; the second pass still sees everything above KEEP_THRESHOLD. */
export const PRESENTATION_THRESHOLD = 0.7;

export interface SelectionResult {
    file: FileEvidence;
    declarations: Array<Pick<SourceUnit, "name" | "range">>;
    issues: IssueCount[];
    providerFailure?: string;
}

function mergeSpans(spans: Span[]): Span[] {
    const merged: Span[] = [];
    for (const span of spans
        .filter((item) => item.end > item.start)
        .sort((a, b) => a.start - b.start || a.end - b.end)) {
        const last = merged.at(-1);
        if (last && span.start <= last.end) {
            last.end = Math.max(last.end, span.end);
        } else {
            merged.push({ ...span });
        }
    }

    return merged;
}

interface SelectionPlan {
    lines: string[];
    bytes: Buffer;
    /** Byte offset of each line start, plus the end. */
    offsets: number[];
    lineAt(byte: number): number;
    syntax: Inspection;
    units: SourceUnit[];
    /** One Jev call per group per selection pass. */
    groups: SourceUnit[][];
}

/**
 * The units of one snapshot and the groups `selectFile` asks about, one call each per pass. Pure, so a
 * budget can count a file's calls before spending them.
 */
export function planSelection(snapshot: Snapshot): SelectionPlan {
    const lines = snapshot.source.split("\n");
    const bytes = Buffer.from(snapshot.source);
    const offsets = [0];
    for (const line of lines) {
        offsets.push(Math.min(bytes.length, offsets.at(-1)! + Buffer.byteLength(line) + 1));
    }

    function lineAt(byte: number): number {
        let low = 0;
        let high = lines.length;
        while (low + 1 < high) {
            const middle = Math.floor((low + high) / 2);
            if (offsets[middle]! <= byte) {
                low = middle;
            } else {
                high = middle;
            }
        }

        return low + 1;
    }

    const giantLine = lines.some((line) => Buffer.byteLength(line) > SOURCE_UNIT_BYTES);
    const syntax = inspect(snapshot, {
        maxUnitBytes: giantLine ? SOURCE_UNIT_BYTES : Math.max(SOURCE_UNIT_BYTES, bytes.length),
    });
    // Giant lines keep byte coordinates; the ordinary text fallback uses complete-line fragments.
    let units = syntax.units;
    if (!giantLine && (syntax.mode === "text" || units.every((unit) => unit.partial))) {
        units = splitSource(snapshot, 3000).map((unit) => ({
            ...unit,
            range: { ...unit.range, endLine: lineAt(Math.max(unit.sourceByteStart, unit.sourceByteEnd - 1)) },
        }));
    }

    if (!giantLine) {
        units = units.flatMap((unit) => {
            if (
                Buffer.byteLength(lines.slice(unit.range.startLine - 1, unit.range.endLine).join("\n")) <=
                SOURCE_UNIT_BYTES
            ) {
                return [unit];
            }

            const blocks: SourceUnit[] = [];
            for (let start = unit.range.startLine; start <= unit.range.endLine; start += 16) {
                const end = Math.min(unit.range.endLine, start + 15);
                blocks.push({
                    id: `${unit.name}:${start}:${end}`,
                    name: unit.name,
                    range: { startLine: start, endLine: end },
                    sourceByteStart: offsets[start - 1]!,
                    sourceByteEnd: offsets[end]!,
                    partial: true,
                });
            }

            return blocks;
        });
    }

    const groups: SourceUnit[][] = [];
    let pending: SourceUnit[] = [];
    for (const unit of units) {
        if (
            pending.length &&
            (pending.length >= 8 ||
                Buffer.byteLength(lines.slice(pending[0]!.range.startLine - 1, unit.range.endLine).join("\n")) > 14000)
        ) {
            groups.push(pending);
            pending = [];
        }

        pending.push(unit);
    }

    if (pending.length) {
        groups.push(pending);
    }

    return { lines, bytes, offsets, lineAt, syntax, units, groups };
}

function validProbability(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Choose ranges inside one admitted file. The bounded follow-up (`prepare` returning evidence) sees the
 * first pass's spans once more; positive selections keep separate provenance from the printed cut.
 * `prepare` returning null means the snapshot changed: every span is dropped and the file is omitted.
 */
export async function selectFile({
    snapshot,
    query,
    score,
    evaluator,
    prepare,
    previous,
}: {
    snapshot: Snapshot;
    query: string;
    score: number;
    evaluator: Pick<Evaluator, "evaluate">;
    prepare?: () => Promise<{ evidence?: Evidence[] } | null>;
    previous?: FileEvidence;
}): Promise<SelectionResult> {
    const issues = new Map<string, number>();
    let providerFailure: string | undefined;
    const warn = (kind: string) => issues.set(kind, (issues.get(kind) ?? 0) + 1);
    let prior = previous;
    if (prior && (prior.path !== snapshot.path || prior.contentHash !== snapshot.contentHash)) {
        warn("changed");
        prior = undefined;
    }

    const { lines, bytes, offsets, lineAt, syntax, units, groups } = planSelection(snapshot);

    function spanForRange(range: EvidenceRange): Span {
        return {
            start: range.sourceByteStart ?? offsets[range.startLine - 1]!,
            end: range.sourceByteEnd ?? offsets[range.endLine]!,
        };
    }

    function rangeForSpan(span: Span): EvidenceRange {
        const startLine = lineAt(span.start);
        const endLine = lineAt(Math.max(span.start, span.end - 1));
        return {
            startLine,
            endLine,
            ...(span.start !== offsets[startLine - 1] || span.end !== offsets[endLine]
                ? { sourceByteStart: span.start, sourceByteEnd: span.end }
                : {}),
        };
    }

    function partialLine(unit: SourceUnit): boolean {
        return (
            unit.sourceByteStart !== (offsets[unit.range.startLine - 1] ?? bytes.length) ||
            unit.sourceByteEnd !== (offsets[unit.range.endLine] ?? bytes.length)
        );
    }

    const selectedCoordinates: Range[] = [];
    const selected: Span[] = (prior?.selected ?? []).map(spanForRange);
    const sourceDecisions = new Map<string, { range: EvidenceRange; score: number }>();
    for (const decision of prior?.sourceDecisions ?? []) {
        const span = spanForRange(decision.range);
        sourceDecisions.set(`${span.start}:${span.end}`, decision);
    }

    const contextSpans: Span[] = (prior?.rendered ?? []).map(spanForRange);
    const leads = new Map<string, ReadingLead>();
    const addLead = (lead: ReadingLead) => leads.set(toJson([lead.name, lead.range]), lead);
    for (const lead of prior?.leads ?? []) {
        addLead({ ...lead, range: { ...lead.range } });
    }

    let invalidated = false;
    for (const group of groups) {
        try {
            const prepared = prepare ? await prepare() : {};
            if (prepared === null) {
                invalidated = true;
                selected.length = 0;
                selectedCoordinates.length = 0;
                contextSpans.length = 0;
                leads.clear();
                break;
            }

            const first = Math.max(1, group[0]!.range.startLine - 8);
            const last = Math.min(lines.length, group.at(-1)!.range.endLine + 8);
            const oversizedContext = [...lines.slice(0, 20), ...lines.slice(first - 1, last)].some(
                (line) => Buffer.byteLength(line) > SOURCE_UNIT_BYTES
            );
            // Line windows cannot describe a slice of a giant line; send only the bounded byte spans.
            const context =
                group.some(partialLine) || oversizedContext
                    ? group
                          .map(
                              (unit) =>
                                  `Source lines ${unit.range.startLine}-${unit.range.endLine}; source bytes ${unit.sourceByteStart}-${unit.sourceByteEnd}:\n${sourceForUnit(snapshot, unit)}`
                          )
                          .join("\n")
                    : bytes.length <= 16000
                      ? snapshot.source
                      : `Opening context:\n${lines.slice(0, 20).join("\n")}\nSource lines ${first}-${last}:\n${lines.slice(first - 1, last).join("\n")}`;
            const request = evidenceRequest({
                query,
                path: snapshot.path,
                source: context,
                declarations: group.map((unit) => ({ name: unit.name, ...unit.range })),
                selectedEvidence: prepared.evidence,
            });
            // jev-instrumentation-ignore: the grep evaluator times every transport attempt under jev-grep
            const answers = await evaluator.evaluate(request);
            const values = group.map((unit, index) => {
                const found = [
                    answers[`q${index}`],
                    answers[`scope${index}`],
                    ...(prepared.evidence !== undefined ? [answers[`ref${index}`]] : []),
                ];
                if (!found.every(validProbability)) {
                    throw new EvaluationFailure("provider");
                }

                return { unit, value: Math.max(Math.min(found[0]!, found[1]!), found[2] ?? 0) };
            });
            for (const { unit, value } of values) {
                const decisionSpan = { start: unit.sourceByteStart, end: unit.sourceByteEnd };
                sourceDecisions.set(`${decisionSpan.start}:${decisionSpan.end}`, {
                    range: rangeForSpan(decisionSpan),
                    score: value,
                });
                // Only a valid contextual rejection retracts an earlier selection. Failed or
                // unprocessed groups keep their previous spans.
                if (prepared.evidence !== undefined && value <= KEEP_THRESHOLD) {
                    const start = unit.sourceByteStart;
                    const end = unit.sourceByteEnd;
                    const retained = selected.flatMap((span) => {
                        if (span.end <= start || span.start >= end) {
                            return [span];
                        }

                        return [
                            ...(span.start < start ? [{ start: span.start, end: start }] : []),
                            ...(span.end > end ? [{ start: end, end: span.end }] : []),
                        ];
                    });
                    selected.splice(0, selected.length, ...retained);
                }

                if (value > KEEP_THRESHOLD) {
                    const span = { start: unit.sourceByteStart, end: unit.sourceByteEnd };
                    selected.push(span);
                    contextSpans.push(span);
                    if (!partialLine(unit)) {
                        selectedCoordinates.push(unit.range);
                    }
                }

                if (value > LEAD_THRESHOLD && !unit.name.endsWith(".context")) {
                    addLead({
                        name: unit.name,
                        range: partialLine(unit)
                            ? rangeForSpan({ start: unit.sourceByteStart, end: unit.sourceByteEnd })
                            : unit.range,
                        score: value,
                    });
                }
            }
        } catch (error) {
            if (!(error instanceof EvaluationFailure)) {
                throw error;
            }

            warn(error.kind);
            if (error.kind === "provider") {
                providerFailure ??= error.message;
            }

            if (error.kind !== "provider") {
                break;
            }
        }
    }

    const chosen = mergeSpans(selected);
    const wholeRanges: Range[] = [...selectedCoordinates];
    const rendered: Span[] = [];
    for (const span of mergeSpans(contextSpans)) {
        const range = rangeForSpan(span);
        if (range.sourceByteStart !== undefined) {
            rendered.push(span);
        } else {
            wholeRanges.push(range);
        }
    }

    function excerptsFor(ranges: Range[], renderedSpans: Span[]): { rendered: EvidenceRange[]; excerpts: Excerpt[] } {
        const output: Span[] = [...renderedSpans];
        const windows = ranges.map((range) => ({
            startLine: Math.max(1, range.startLine - 3),
            endLine: Math.min(lines.length, range.endLine + 3),
        }));
        for (const window of windows) {
            let changed = true;
            while (changed) {
                changed = false;
                for (const comment of syntax.comments) {
                    const before =
                        comment.endLine < window.startLine &&
                        lines.slice(comment.endLine, window.startLine - 1).every((line) => !line.trim());
                    const after =
                        comment.startLine > window.endLine &&
                        lines.slice(window.endLine, comment.startLine - 1).every((line) => !line.trim());
                    if (
                        (comment.startLine <= window.endLine && comment.endLine >= window.startLine) ||
                        before ||
                        after
                    ) {
                        const start = Math.min(window.startLine, comment.startLine);
                        const end = Math.max(window.endLine, comment.endLine);
                        if (start !== window.startLine || end !== window.endLine) {
                            window.startLine = start;
                            window.endLine = end;
                            changed = true;
                        }
                    }
                }
            }

            let segmentStart = offsets[window.startLine - 1]!;
            for (let line = window.startLine; line <= window.endLine; line++) {
                const start = offsets[line - 1]!;
                const end = offsets[line]!;
                // An adjacent selected declaration must not pull in an unselected giant line.
                if (end - start > SOURCE_UNIT_BYTES) {
                    output.push({ start: segmentStart, end: start });
                    for (const span of chosen) {
                        if (span.start < end && span.end > start) {
                            output.push({ start: Math.max(span.start, start), end: Math.min(span.end, end) });
                        }
                    }

                    segmentStart = end;
                }
            }

            output.push({ start: segmentStart, end: offsets[window.endLine]! });
        }

        const merged = mergeSpans(output);
        function renderedRange(span: Span): EvidenceRange {
            const range = rangeForSpan(span);
            // A trailing empty line has no byte interval but still belongs to a line window.
            if (
                range.sourceByteStart === undefined &&
                span.end === bytes.length &&
                windows.some((window) => window.endLine === lines.length)
            ) {
                range.endLine = lines.length;
            }

            return range;
        }

        return {
            rendered: merged.map(renderedRange),
            excerpts: merged.map((span) => {
                const range = renderedRange(span);
                const partial = range.sourceByteStart !== undefined;
                return {
                    range,
                    source: partial
                        ? bytes.subarray(span.start, span.end).toString("utf8")
                        : lines.slice(range.startLine - 1, range.endLine).join("\n"),
                    ...(partial ? { sourceByteStart: span.start, sourceByteEnd: span.end, partial: true } : {}),
                };
            }),
        };
    }

    const expanded = excerptsFor(wholeRanges, rendered);
    // Presentation can be stricter without narrowing the evidence sent to Jev.
    const displayed = mergeSpans(
        [...sourceDecisions.values()]
            .filter((decision) => decision.score > PRESENTATION_THRESHOLD)
            .map((decision) => spanForRange(decision.range))
            .flatMap((span) =>
                chosen.flatMap((selectedSpan) => {
                    const start = Math.max(span.start, selectedSpan.start);
                    const end = Math.min(span.end, selectedSpan.end);
                    return start < end ? [{ start, end }] : [];
                })
            )
    );

    function presentationFor(spans: Span[]) {
        const selectedRanges = spans.map(rangeForSpan);
        const ownerHeaders = new Map<string, Range>();
        for (const unit of syntax.units) {
            if (!spans.some((span) => span.start < unit.sourceByteEnd && span.end > unit.sourceByteStart)) {
                continue;
            }

            for (const header of unit.ownerHeaders ?? []) {
                const byteLength = offsets[header.endLine]! - offsets[header.startLine - 1]!;
                if (byteLength <= SOURCE_UNIT_BYTES) {
                    ownerHeaders.set(`${header.startLine}:${header.endLine}`, header);
                }
            }
        }

        return excerptsFor(
            [...selectedRanges.filter((range) => range.sourceByteStart === undefined), ...ownerHeaders.values()],
            spans.filter((span) => rangeForSpan(span).sourceByteStart !== undefined)
        );
    }

    const presentation = presentationFor(displayed);
    const file: FileEvidence = {
        path: snapshot.path,
        contentHash: snapshot.contentHash,
        score,
        roles: [...(prior?.roles ?? [])],
        leads: [...leads.values()],
        selected: chosen.map(rangeForSpan),
        rendered: expanded.rendered,
        excerpts: expanded.excerpts,
        presentationExcerpts: presentation.excerpts,
        selectedPresentationExcerpts: presentationFor(chosen).excerpts,
        presentationSelected: displayed.map(rangeForSpan),
        sourceDecisions: [...sourceDecisions.values()],
        sourceOmitted: invalidated,
    };
    return {
        file,
        declarations: units.map(({ name, range }) => ({ name, range })),
        issues: [...issues].map(([kind, count]) => ({ kind, count })),
        providerFailure,
    };
}

/**
 * Swift rules that need structure: a brace-balanced scan of `struct … : View` bodies and of modifier chains,
 * over source whose comments and strings are already masked (`maskSwiftNonCode` in lint-rules.ts). Swift has no
 * grammar in the ast-grep package, so this is the parser: enough to know which struct a line is in, which lines
 * belong to a modifier chain, and how deep a line sits in braces.
 *
 * The rules come from the dense-row campaign of 2026-10-29 (the proposals in
 * `.claude/plans/2026-10-29-SwiftLintRuleProposals/`): a row sets its liveness once with `.liveRow(selected:)`
 * (GenesisKitBase Style/LiveRow.swift) and the kit's controls read `rowLive`. Two mistakes that compile, look the
 * same and silently keep every control alive at rest are gates here; an Observation re-arm that runs late is the
 * third.
 */

import type { Finding, Severity } from "./lint-rules";
import {
    SWIFT_EQUATABLE_SKIPS_RATCHET,
    SWIFT_FORMATTER_IN_VIEW_RATCHET,
    SWIFT_ROW_CONTROL_RATCHET,
    SWIFT_ROW_OBSERVES_RATCHET,
} from "./swift-row-ratchet";

export interface SwiftStruct {
    name: string;
    conformances: string[];
    /** 1-based, inclusive. */
    start: number;
    end: number;
}

interface SwiftStructRule {
    name: string;
    severity: Severity;
    message: string;
}

const STRUCT_HEAD =
    /^\s*(?:(?:public|private|fileprivate|internal|final|open)\s+)*struct\s+(\w+)(?:<[^>{]*>)?\s*(?::\s*([^{]+?))?\s*\{/;

/** Every `struct` with its line range, nested ones included (each is its own entry). */
export function swiftStructs(codeLines: string[]): SwiftStruct[] {
    const structs: SwiftStruct[] = [];

    for (const [index, line] of codeLines.entries()) {
        const head = STRUCT_HEAD.exec(line);

        if (!head) {
            continue;
        }

        const conformances = (head[2] ?? "")
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean);
        structs.push({ name: head[1], conformances, start: index + 1, end: closingLine(codeLines, index) });
    }

    return structs;
}

/** The 1-based line where the braces opened on `openIndex` close again (the last line when they never do). */
function closingLine(codeLines: string[], openIndex: number): number {
    let depth = 0;

    for (let index = openIndex; index < codeLines.length; index++) {
        depth += braceDelta(codeLines[index]);

        if (depth <= 0 && index > openIndex) {
            return index + 1;
        }

        if (depth <= 0 && index === openIndex && codeLines[index].includes("}")) {
            return index + 1;
        }
    }

    return codeLines.length;
}

function braceDelta(line: string): number {
    let delta = 0;

    for (const char of line) {
        if (char === "{") {
            delta++;
        } else if (char === "}") {
            delta--;
        }
    }

    return delta;
}

/** A struct's own lines: the lines of structs nested in it are blanked, so a child view's reads are not its own. */
function ownLines(struct: SwiftStruct, all: SwiftStruct[], codeLines: string[]): string[] {
    const lines = codeLines.slice(struct.start - 1, struct.end);

    for (const nested of all) {
        if (nested === struct || nested.start <= struct.start || nested.end > struct.end) {
            continue;
        }

        for (let line = nested.start; line <= nested.end; line++) {
            lines[line - struct.start] = "";
        }
    }

    return lines;
}

const ROW_LIVE_READ = /@Environment\(\\\.rowLive\)/;
const LIVE_ROW_SET = /\.liveRow\(/;
const LIVE_SETTER = /\.(?:liveRow|rowLive)\(/;
const GATED_CONTROL = /\.(?:rowButton\b|instantTooltip\()/;
const ROW_CONTROL =
    /\.(?:rowButton\b|instantTooltip\()|\b(?:IconButton|PathLabel|MenuButton|ExternalLink|LiveButton)\s*\(|\bButton\s*[({]/;
const STORED_PROPERTY =
    /^\s*(?:(?:public|private|fileprivate|internal)\s+)?(?:let|var)\s+(\w+)\s*(?::\s*([^={]+?))?\s*(?:=|$)/;
const OBSERVATION_TRACKING = /\bwithObservationTracking\s*[({]/;
const ASYNC_OPENER = /DispatchQueue\.\w+\.async(?:After)?\b|\bTask(?:\.detached)?\s*(?:\(|\{)|MainActor\.run\b/;

const ROW_LIVE_READ_IN_LIVE_ROW_RULE: SwiftStructRule = {
    name: "swift-rowlive-read-in-liverow-struct",
    severity: "error",
    message:
        "A view that applies `.liveRow(` in its own body and reads `@Environment(\\.rowLive)` reads its PARENT's value " +
        "(true), not its own: the environment applies to what is inside the modifier, so the read never turns the " +
        "controls off. Move the piece that needs the value into a child view with its own `@Environment(\\.rowLive)` " +
        "(Style/LiveRow.swift).",
};

const LIVE_ROW_OUTSIDE_CONTROL_RULE: SwiftStructRule = {
    name: "swift-liverow-outside-control",
    severity: "error",
    message:
        "`.liveRow(` / `.rowLive(` sits before a `.rowButton` or `.instantTooltip(` in the same modifier chain: the " +
        "control is outside the environment it sets and stays a responder at rest (the 119 ms Agents sidebar step). " +
        "Put `.liveRow(` after the row's controls, or `// lint-rules-ignore: <why the control belongs to the container>`.",
};

const OBSERVATION_ASYNC_REARM_RULE: SwiftStructRule = {
    name: "swift-observation-async-rearm",
    severity: "error",
    message:
        "`withObservationTracking`'s `onChange` fires once, on willSet, on the mutating thread, as `@Published` did. " +
        "Re-arming it (calling the enclosing function again) inside `DispatchQueue.main.async`/`Task` misses every " +
        "change until that turn runs and moves the synchronous part a turn late (15 hub tests failed on a request id " +
        "that flipped after its reader looked, 2026-10-29). Re-arm synchronously in `onChange`; defer only the work " +
        "that must see the landed value.",
};

const OBSERVATION_NO_REARM_RULE: SwiftStructRule = {
    name: "swift-observation-no-rearm",
    severity: "error",
    message:
        "`withObservationTracking` fires its `onChange` once, and this `onChange` never calls the enclosing function " +
        "again: the first change is seen, every later one is missed, with no error. Re-arm it synchronously inside " +
        "`onChange` (HubWindow.swift `watchOwnPlace`), or `// lint-rules-ignore: one shot on purpose, <why>`.",
};

/** The struct rules over masked code lines; `lines` are the raw ones (for the finding's text). */
export function checkSwiftStructRules(
    file: string,
    lines: string[],
    codeLines: string[],
    isSuppressed: (lines: string[], lineNumber: number) => boolean
): Finding[] {
    const findings: Finding[] = [];
    const push = (rule: SwiftStructRule, lineNumber: number, column: number) => {
        if (isSuppressed(lines, lineNumber)) {
            return;
        }

        findings.push({
            file,
            line: lineNumber,
            column: column + 1,
            rule: rule.name,
            severity: rule.severity,
            message: rule.message,
            text: (lines[lineNumber - 1] ?? "").trim().slice(0, 120),
        });
    };

    const structs = swiftStructs(codeLines);

    for (const struct of structs) {
        if (!struct.conformances.some((name) => /^View$/.test(name))) {
            continue;
        }

        const own = ownLines(struct, structs, codeLines);
        const readAt = own.findIndex((line) => ROW_LIVE_READ.test(line));

        if (readAt !== -1 && own.some((line) => LIVE_ROW_SET.test(line))) {
            push(ROW_LIVE_READ_IN_LIVE_ROW_RULE, struct.start + readAt, own[readAt].search(ROW_LIVE_READ));
        }
    }

    for (const [index, line] of codeLines.entries()) {
        const setterColumn = line.search(LIVE_SETTER);

        if (setterColumn !== -1) {
            const hit = controlAfterSetter(codeLines, index, setterColumn);

            if (hit) {
                push(LIVE_ROW_OUTSIDE_CONTROL_RULE, hit.line, hit.column);
            }
        }

        if (OBSERVATION_TRACKING.test(line)) {
            const rearm = observationRearm(codeLines, index);

            if (rearm.async) {
                push(OBSERVATION_ASYNC_REARM_RULE, rearm.async.line, rearm.async.column);
            } else if (rearm.missing) {
                push(OBSERVATION_NO_REARM_RULE, index + 1, line.search(OBSERVATION_TRACKING));
            }
        }
    }

    return findings;
}

/**
 * A `.rowButton` or `.instantTooltip(` later in the chain that `.liveRow(` / `.rowLive(` sits in: the rest of the
 * setter's own line, then every continuation line of the chain (`walkChain`).
 */
function controlAfterSetter(
    codeLines: string[],
    index: number,
    setterColumn: number
): { line: number; column: number } | null {
    const hits: Array<{ line: number; column: number }> = [];
    walkChain(codeLines, index, setterColumn + 1, (lineIndex, text, offset) => {
        const column = text.search(GATED_CONTROL);

        if (column !== -1) {
            hits.push({ line: lineIndex + 1, column: offset + column });
            return true;
        }

        return false;
    });

    return hits[0] ?? null;
}

/**
 * Inside the `onChange:` closure of the `withObservationTracking` call that starts on `index`: where the enclosing
 * function is called again (the re-arm). `async` names a re-arm that sits inside an asynchronous block; `missing`
 * says the closure never re-arms at all.
 */
function observationRearm(
    codeLines: string[],
    index: number
): { async: { line: number; column: number } | null; missing: boolean } {
    const enclosing = enclosingFunctionName(codeLines, index);

    if (!enclosing) {
        return { async: null, missing: false };
    }

    const end = closingLine(codeLines, index);
    let onChangeDepth: number | null = null;
    let depth = 0;
    let rearmed = false;
    const asyncDepths: number[] = [];
    const rearm = new RegExp(`\\b(?:self\\.)?${enclosing}\\(`);

    for (let line = index; line < end; line++) {
        const text = codeLines[line];

        if (onChangeDepth === null && /\bonChange\s*:/.test(text)) {
            onChangeDepth = depth + braceDelta(text.slice(0, text.indexOf("onChange")));
        }

        if (onChangeDepth !== null) {
            if (ASYNC_OPENER.test(text)) {
                asyncDepths.push(depth);
            }

            const column = text.search(rearm);

            if (column !== -1) {
                rearmed = true;

                if (asyncDepths.length > 0) {
                    return { async: { line: line + 1, column }, missing: false };
                }
            }
        }

        depth += braceDelta(text);

        while (asyncDepths.length > 0 && depth <= asyncDepths[asyncDepths.length - 1]) {
            asyncDepths.pop();
        }
    }

    return { async: null, missing: onChangeDepth !== null && !rearmed };
}

function enclosingFunctionName(codeLines: string[], index: number): string | null {
    for (let line = index; line >= 0; line--) {
        const head = /^\s*(?:(?:public|private|fileprivate|internal|static|final|@\w+)\s+)*func\s+(\w+)\s*\(/.exec(
            codeLines[line]
        );

        if (head) {
            return head[1];
        }
    }

    return null;
}

// MARK: - Rows: the structs a `ForEach` makes, their chains, and what a row may not carry

export interface SwiftRange {
    /** 1-based, inclusive. */
    start: number;
    end: number;
}

/** Every `ForEach(` call with the lines its closure spans. */
export function forEachRanges(codeLines: string[]): SwiftRange[] {
    const ranges: SwiftRange[] = [];

    for (const [index, line] of codeLines.entries()) {
        if (/\bForEach\s*\(/.test(line) && line.includes("{")) {
            ranges.push({ start: index + 1, end: closingLine(codeLines, index) });
        }
    }

    return ranges;
}

const ROW_CONSTRUCTION = /^\s*([A-Z]\w*)\s*\(/;

/** The `View` structs whose name is constructed inside a `ForEach` closure of the same file: the rows. */
export function rowStructs(codeLines: string[], structs: SwiftStruct[]): SwiftStruct[] {
    const views = structs.filter((struct) => struct.conformances.includes("View"));
    const ranges = forEachRanges(codeLines);
    const made = new Set<string>();

    for (const range of ranges) {
        for (let line = range.start; line <= range.end; line++) {
            const head = ROW_CONSTRUCTION.exec(codeLines[line - 1]);

            if (head) {
                made.add(head[1]);
            }
        }
    }

    return views.filter((struct) => made.has(struct.name));
}

/**
 * Walks the modifier chain that starts on `index` after `fromColumn`: the rest of that line, then every
 * continuation line (one that starts with `.`), skipping the inside of closures a modifier opened and the blank
 * lines a masked comment leaves (a comment between two modifiers is still one chain: AgentDraftsList.swift,
 * 2026-10-29). `visit` gets each depth-0 text, and what follows a closure's closing `}` on its own line
 * (`}.equatable()`); returning true stops the walk.
 */
function walkChain(
    codeLines: string[],
    index: number,
    fromColumn: number,
    visit: (lineIndex: number, text: string, offset: number) => boolean
): void {
    const rest = codeLines[index].slice(fromColumn);

    if (visit(index, rest, fromColumn)) {
        return;
    }

    let depth = braceDelta(rest);

    for (let next = index + 1; next < codeLines.length; next++) {
        const line = codeLines[next];

        if (depth > 0) {
            depth += braceDelta(line);

            if (depth <= 0) {
                const tail = line.lastIndexOf("}") + 1;

                if (visit(next, line.slice(tail), tail)) {
                    return;
                }
            }

            continue;
        }

        if (line.trim() === "") {
            continue;
        }

        if (!/^\s*\./.test(line) || visit(next, line, 0)) {
            return;
        }

        depth += braceDelta(line);
    }
}

/** Every line that constructs `name` as a statement (`Name(` or `Name {` first on the line). */
function constructionSites(codeLines: string[], name: string): number[] {
    const head = new RegExp(`^\\s*${name}\\s*[({]`);
    const sites: number[] = [];

    for (const [index, line] of codeLines.entries()) {
        if (head.test(line)) {
            sites.push(index);
        }
    }

    return sites;
}

/** Does the modifier chain of the construction on `index` contain `pattern`? */
function chainHas(codeLines: string[], index: number, pattern: RegExp): boolean {
    let found = false;
    walkChain(codeLines, index, codeLines[index].search(/[({]/) + 1, (_lineIndex, text) => {
        found = pattern.test(text);
        return found;
    });

    return found;
}

/** The lines at the struct's own member depth (its stored and computed properties, its functions' heads). */
function memberLines(own: string[]): number[] {
    const members: number[] = [];
    let depth = 0;

    for (const [offset, line] of own.entries()) {
        if (offset > 0 && depth === 1) {
            members.push(offset);
        }

        depth += braceDelta(line);
    }

    return members;
}

const CLASS_HEAD = /^\s*(?:(?:public|private|fileprivate|internal|final|open|@\w+)\s+)*class\s+(\w+)/;

/** The classes a file declares: a stored reference to one is held, not compared, by a value view. */
function classNames(codeLines: string[]): Set<string> {
    const names = new Set<string>();

    for (const line of codeLines) {
        const head = CLASS_HEAD.exec(line);

        if (head) {
            names.add(head[1]);
        }
    }

    return names;
}

/**
 * The stored values of a view's `static func ==` that it never compares: a stored property with no wrapper, no
 * closure type, no class type (a `…Model`/`…Store`, or a class this file declares: a reference a row holds without
 * comparing it), not suppressed on its line, that the `==` body never names as `.<name>`. `null` when the struct has
 * no `==`.
 */
function equalsSkips(
    struct: SwiftStruct,
    own: string[],
    rawLines: string[],
    classes: Set<string>
): { offset: number; names: string[] } | null {
    const members = memberLines(own);
    const equals = members.find((offset) => /static\s+func\s+==\s*\(/.test(own[offset]));

    if (equals === undefined) {
        return null;
    }

    const body = own.slice(equals, closingLine(own, equals)).join("\n");
    const names = members
        .map((offset) => ({ offset, match: STORED_PROPERTY.exec(own[offset]) }))
        .filter((entry): entry is { offset: number; match: RegExpExecArray } => entry.match !== null)
        .filter(({ offset, match }) => {
            const type = (match[2] ?? "").trim().replace(/[?!]$/, "");
            const raw = struct.start - 1 + offset;

            return (
                !type.includes("->") &&
                !/(?:Model|Store)$/.test(type) &&
                !classes.has(type) &&
                !/\{\s*$/.test(own[offset]) &&
                !/lint-rules-ignore\b/.test(`${rawLines[raw - 1] ?? ""}\n${rawLines[raw] ?? ""}`)
            );
        })
        .map(({ match }) => match[1])
        .filter((name) => !new RegExp(`\\.${name}\\b`).test(body));

    return { offset: equals, names };
}

const PRESENTATION = /\.(?:popover|sheet)\s*\(/;
const SELF_GATED = /LiveButton\(\s*live:|\binteractive:\s*(?!true\b|false\b)\w+/;

const CONTROL_CHAINED_TO_ROW_RULE: SwiftStructRule = {
    name: "swift-control-chained-to-row-construction",
    severity: "error",
    message:
        "A `.rowButton` or `.instantTooltip(` on the chain that constructs a row inside a `ForEach` sits outside the " +
        "row's `.liveRow(`: it is a responder on every row at rest (the old Inbox and session rows). Move it into the " +
        "row, or end this chain with `.liveRow(` after it.",
};

const PRESENTATION_INSIDE_LIVEROW_RULE: SwiftStructRule = {
    name: "swift-presentation-inside-liverow",
    severity: "error",
    message:
        "A `.popover(` or `.sheet(` before `.liveRow(` / `.rowLive(` in the same chain inherits the row's environment: " +
        "when the row rests, every control in the presented content becomes a resting label. Put the presentation " +
        "after `.liveRow(`, or keep the row live while it is shown (`selected: popoverOpen`).",
};

const ROW_GATES_CONTROL_ITSELF_RULE: SwiftStructRule = {
    name: "swift-row-gates-control-itself",
    severity: "error",
    message:
        "A view that sets its liveness with `.liveRow(` / `.rowLive(` still gates a control by hand (`LiveButton(live:`, " +
        "`interactive: <value>`). The components read `rowLive` themselves (Style/LiveRow.swift); drop the argument.",
};

const ROW_OBSERVES_STORE_RULE: SwiftStructRule = {
    name: "swift-row-observes-store",
    severity: "error",
    message:
        "A row a `ForEach` makes observes a store (`@ObservedObject`, `@EnvironmentObject`, `@StateObject` or " +
        "`X.shared`): every publish of the store runs every row's body (PRThreadRow ran 54 times for a 5-thread PR, " +
        "2026-10-29). The parent reads the store once and passes values; the row takes closures for its actions and " +
        "is `Equatable` with `.equatable()`. A short fixed list: `// lint-rules-ignore: <n> rows, observes on purpose`. " +
        "scripts/ci/swift-row-ratchet.ts lists the rows not converted yet.",
};

const ROW_CONTROL_AT_REST_RULE: SwiftStructRule = {
    name: "swift-row-control-at-rest",
    severity: "error",
    message:
        "A row a `ForEach` makes carries a control at rest (`.rowButton`, `.instantTooltip(`, `IconButton(`, `Button`…) " +
        "and sets no liveness: with an accessibility client attached every row's controls are responders, and a " +
        "click's cost grows with rows × controls (the PRs sidebar step p95 540 ms → 54 ms once the rows rested, " +
        "2026-10-29). End the row's outer view with `.liveRow(selected:)` (Style/LiveRow.swift): the kit's controls " +
        "read it; a raw `Button`/`Toggle` becomes `LiveButton`. A short fixed list: `// lint-rules-ignore: short " +
        "list (<n> rows)`. scripts/ci/swift-row-ratchet.ts lists the rows not converted yet.",
};

const EQUATABLE_SKIPS_VALUE_RULE: SwiftStructRule = {
    name: "swift-equatable-eq-skips-value",
    severity: "error",
    message:
        "An `Equatable` view's `==` never compares a stored value: while the compared ones hold, SwiftUI keeps the " +
        "old body, and the view shows stale data with no error. Compare it, or mark the property with " +
        "`// lint-rules-ignore: <it follows a compared value>` (a `…Model`/`…Store` reference and a closure are " +
        "skipped by the rule). Skipped",
};

const FORMATTER_IN_VIEW_RULE: SwiftStructRule = {
    name: "swift-formatter-in-view",
    severity: "error",
    message:
        "A formatter or a regex is made inside a view (`DateFormatter()`, `NSRegularExpression(`, `Regex(`): it is " +
        "built on every run of the body that reaches it, and a row's body runs per row per update (TitleFormatter " +
        "compiled its regexes per title until 2026-10-29). Make it a `static let` of the view or of a formatter type " +
        "and reuse it, or `// lint-rules-ignore: <runs once, on a click>`. scripts/ci/swift-row-ratchet.ts lists the " +
        "views not converted yet.",
};

const ROW_OBSERVES = /@ObservedObject\b|@EnvironmentObject\b|@StateObject\b|\b[A-Z]\w*\.shared\b/;
const MAKES_FORMATTER =
    /\b(?:DateFormatter|NumberFormatter|ISO8601DateFormatter|RelativeDateTimeFormatter|ByteCountFormatter|DateComponentsFormatter|MeasurementFormatter|NSRegularExpression)\s*\(|\btry[!?]?\s+Regex\s*\(/;

/** The row rules: gates over chains and row structs. Appended to `checkSwiftStructRules`'s findings. */
export function checkSwiftRowRules(
    file: string,
    lines: string[],
    codeLines: string[],
    isSuppressed: (lines: string[], lineNumber: number) => boolean,
    ratchets = true
): Finding[] {
    const findings: Finding[] = [];
    const push = (rule: SwiftStructRule, lineNumber: number, column: number, subject?: string, detail = "") => {
        if (isSuppressed(lines, lineNumber)) {
            return;
        }

        findings.push({
            file,
            line: lineNumber,
            column: column + 1,
            rule: rule.name,
            severity: rule.severity,
            message: `${rule.message}${detail}`,
            text: (lines[lineNumber - 1] ?? "").trim().slice(0, 120),
            ...(subject ? { subject } : {}),
        });
    };

    for (const range of forEachRanges(codeLines)) {
        for (let line = range.start; line <= range.end; line++) {
            const index = line - 1;
            const head = ROW_CONSTRUCTION.exec(codeLines[index]);

            if (!head || !/(?:Row|Card|Cell)$/.test(head[1])) {
                continue;
            }

            const controls: Array<{ line: number; column: number }> = [];
            let gated = false;
            walkChain(codeLines, index, head[0].length, (lineIndex, text, offset) => {
                const column = text.search(GATED_CONTROL);

                if (column !== -1) {
                    controls.push({ line: lineIndex + 1, column: offset + column });
                }

                if (LIVE_SETTER.test(text)) {
                    gated = true;
                }

                return false;
            });

            if (controls.length > 0 && !gated) {
                push(CONTROL_CHAINED_TO_ROW_RULE, controls[0].line, controls[0].column);
            }
        }
    }

    for (const [index, line] of codeLines.entries()) {
        const column = line.search(PRESENTATION);

        if (column === -1) {
            continue;
        }

        walkChain(codeLines, index, column + 1, (lineIndex, text, offset) => {
            const setter = text.search(LIVE_SETTER);

            if (setter !== -1) {
                push(PRESENTATION_INSIDE_LIVEROW_RULE, lineIndex + 1, offset + setter);
                return true;
            }

            return false;
        });
    }

    const structs = swiftStructs(codeLines);
    const rows = rowStructs(codeLines, structs);
    const classes = classNames(codeLines);

    for (const struct of structs) {
        if (!struct.conformances.includes("View")) {
            continue;
        }

        const own = ownLines(struct, structs, codeLines);
        const key = `${file}#${struct.name}`;
        const skips = equalsSkips(struct, own, lines, classes);

        if (skips && skips.names.length > 0 && !(ratchets && SWIFT_EQUATABLE_SKIPS_RATCHET.has(key))) {
            push(
                EQUATABLE_SKIPS_VALUE_RULE,
                struct.start + skips.offset,
                0,
                struct.name,
                `: ${skips.names.join(", ")}.`
            );
        }

        if (!(ratchets && SWIFT_FORMATTER_IN_VIEW_RATCHET.has(key))) {
            for (const [offset, line] of own.entries()) {
                const column = line.search(MAKES_FORMATTER);

                if (column !== -1 && !/\bstatic\b/.test(line)) {
                    push(FORMATTER_IN_VIEW_RULE, struct.start + offset, column, struct.name);
                }
            }
        }

        if (rows.includes(struct)) {
            const observes = own.findIndex((line) => ROW_OBSERVES.test(line));

            if (observes !== -1 && !(ratchets && SWIFT_ROW_OBSERVES_RATCHET.has(key))) {
                push(ROW_OBSERVES_STORE_RULE, struct.start + observes, own[observes].search(ROW_OBSERVES), struct.name);
            }

            const control = own.findIndex((line) => ROW_CONTROL.test(line));
            const gated =
                own.some((line) => LIVE_SETTER.test(line) || ROW_LIVE_READ.test(line)) ||
                constructionSites(codeLines, struct.name).every((site) => chainHas(codeLines, site, LIVE_SETTER));

            if (control !== -1 && !gated && !(ratchets && SWIFT_ROW_CONTROL_RATCHET.has(key))) {
                push(ROW_CONTROL_AT_REST_RULE, struct.start + control, own[control].search(ROW_CONTROL), struct.name);
            }
        }

        if (!own.some((line) => LIVE_SETTER.test(line))) {
            continue;
        }

        for (const [offset, line] of own.entries()) {
            const column = line.search(SELF_GATED);

            if (column !== -1) {
                push(ROW_GATES_CONTROL_ITSELF_RULE, struct.start + offset, column);
            }
        }
    }

    return findings;
}

// MARK: - The scan: candidates for the swift skill's scanner, never a gate

/**
 * What a row still carries, one line per finding: a model it observes, controls with no `.liveRow(`, a missing
 * `Equatable` or `.equatable()`, an `==` that skips a stored value, its own hover state. For
 * `.claude/skills/swift/scripts/swift-scan.ts`; the proposals of 2026-10-29 are the source of each check.
 */
export function swiftRowAudit(codeLines: string[]): string[] {
    const out: string[] = [];
    const structs = swiftStructs(codeLines);
    const rows = rowStructs(codeLines, structs);
    const ranges = forEachRanges(codeLines);
    const text = codeLines.join("\n");
    const classes = classNames(codeLines);

    for (const row of rows) {
        const own = ownLines(row, structs, codeLines);
        const where = `${row.name} (L${row.start}-L${row.end})`;
        const sites = constructionSites(codeLines, row.name);
        const madeWithEquatable = sites.every((site) => chainHas(codeLines, site, /\.equatable\(\)/));
        const madeWithLiveRow = sites.every((site) => chainHas(codeLines, site, LIVE_SETTER));

        if (own.some((line) => ROW_OBSERVES.test(line))) {
            out.push(`${where}: observes a model or a shared store; a row takes values`);
        }

        if (
            own.some((line) => ROW_CONTROL.test(line)) &&
            !own.some((line) => LIVE_SETTER.test(line) || ROW_LIVE_READ.test(line)) &&
            !madeWithLiveRow
        ) {
            out.push(`${where}: controls at rest and no .liveRow(selected:) on the row`);
        }

        const equatable =
            row.conformances.includes("Equatable") ||
            new RegExp(`extension\\s+${row.name}\\s*:\\s*Equatable`).test(text);

        if (!equatable) {
            out.push(`${where}: not Equatable (closures and class references defeat the automatic compare)`);
        } else if (!madeWithEquatable) {
            out.push(`${where}: Equatable but made without .equatable()`);
        }

        const skips = equalsSkips(row, own, codeLines, classes);

        if (skips && skips.names.length > 0) {
            out.push(`${where}: == skips ${skips.names.join(", ")} (a value the body reads is stale)`);
        }

        if (own.some((line) => /@State\s+(?:private\s+)?var\s+hovering\b/.test(line))) {
            out.push(`${where}: tracks its own hover (@State hovering); .liveRow does it`);
        }

        // A hover animation on the whole row cross-fades every label that turns into a control (pr-threads.md 2);
        // `.rowLive(state)` on a view animated by that state swaps the view and stops the animation (pr-threads.md 4).
        for (const [offset, line] of own.entries()) {
            const setter = line.search(LIVE_SETTER);

            if (setter === -1) {
                continue;
            }

            let animated = false;
            walkChain(own, offset, 0, (_lineIndex, text) => {
                if (/\.animation\(/.test(text)) {
                    animated = true;
                    return true;
                }

                return false;
            });

            if (animated) {
                out.push(
                    `${where}: .animation( on the chain that sets the row's liveness (L${row.start + offset}); animate the fill and border only`
                );
            }

            const swapped = /\.rowLive\(\s*(\w+)\s*\)/.exec(line);

            if (
                swapped &&
                own.some((other) => new RegExp(`\\.animation\\([^)]*value:\\s*${swapped[1]}\\b`).test(other))
            ) {
                out.push(
                    `${where}: .rowLive(${swapped[1]}) swaps a view that .animation(value: ${swapped[1]}) animates (L${row.start + offset})`
                );
            }
        }
    }

    for (const struct of structs) {
        if (!struct.conformances.includes("View") || rows.includes(struct)) {
            continue;
        }

        const own = ownLines(struct, structs, codeLines);

        for (const [offset, line] of own.entries()) {
            const head = /^\s*(?:private\s+)?func\s+(\w*[Rr]ow\w*)\s*\(/.exec(line);

            if (!head) {
                continue;
            }

            const end = closingLine(own, offset);
            const body = own.slice(offset, end);

            if (body.some((bodyLine) => ROW_CONTROL.test(bodyLine))) {
                out.push(
                    `${struct.name}.${head[1]} (L${struct.start + offset}): a row builder method with controls; make a value row struct`
                );
            }
        }
    }

    const reads = new Map<string, number>();

    for (const range of ranges) {
        for (let line = range.start; line <= range.end; line++) {
            const text = codeLines[line - 1];

            for (const match of text.matchAll(
                /\b(store|model|inbox|agents|prs|timeline|review|prefs)\.\w+(?:\.\w+)*(?:\([^)]*\))?/g
            )) {
                // An action inside a closure on the line (`select: { model.select(id) }`) runs on a click, not per body.
                if (text.slice(0, match.index).includes("{")) {
                    continue;
                }

                reads.set(match[0], (reads.get(match[0]) ?? 0) + 1);
            }
        }
    }

    for (const [read, count] of reads) {
        if (count >= 2) {
            out.push(`ForEach reads \`${read}\` ${count} times; read it once above the loop`);
        }
    }

    return out;
}

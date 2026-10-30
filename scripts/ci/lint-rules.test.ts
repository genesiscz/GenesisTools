import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Lang, parse } from "@ast-grep/napi";
import { SafeJSON } from "@genesiscz/utils/json";
import { keptExecutable } from "@genesiscz/utils/test/kept-executable";
import { AGENT_PROCESS_MATCH_RATCHET, HARNESS_BRANCH_RATCHET, HOOK_PAYLOAD_READ_RATCHET } from "./harness-ratchet";
import {
    BARE_REQUIRE_RATCHET,
    changedFiles,
    checkSource,
    checkSwiftSource,
    type Finding,
    maskSwiftNonCode,
    namesToolCommand,
    namesTranscriptFormat,
    pluginsDisabledFor,
    ratchetAdditions,
    withinCountRatchets,
} from "./lint-rules";
import { EFFORT_LIST_RATCHET, MODEL_ID_LITERAL_RATCHET, MODEL_PRICE_TABLE_RATCHET } from "./model-facts-ratchet";
import { NATIVE_HOME_CLAUDE_RATCHET, NATIVE_HOME_CODEX_GROK_RATCHET } from "./native-home-ratchet";
import { PROXY_PROVIDER_BRANCH_RATCHET } from "./proxy-provider-ratchet";
import { swiftRowAudit } from "./swift-lint-rules";
import {
    SWIFT_EQUATABLE_SKIPS_RATCHET,
    SWIFT_FORMATTER_IN_VIEW_RATCHET,
    SWIFT_ROW_CONTROL_RATCHET,
    SWIFT_ROW_OBSERVES_RATCHET,
} from "./swift-row-ratchet";
import { TOOL_COMMAND_RATCHET } from "./tool-command-ratchet";
import { TRANSCRIPT_FORMAT_RATCHET } from "./transcript-format-ratchet";

/**
 * These pin the behaviour of the six GritQL plugins this checker replaced.
 *
 * Storage-path enforcement now requires the canonical root helper for every home expression, including
 * env.tools.getHome(), so explicit sandbox roots and the user's root follow the same construction contract.
 */

function rules(source: string, file = "src/example.ts"): string[] {
    return checkSource(file, source).map((f) => f.rule);
}

describe("swift struct and chain rules (dense rows, Observation)", () => {
    const swiftRules = (source: string) => checkSwiftSource("Sources/Example.swift", source).map((f) => f.rule);

    test("a view that reads rowLive and applies .liveRow in its own body is flagged at the read", () => {
        const source = [
            "struct AgentProcsRow: View {",
            "    @Environment(\\.rowLive) private var live",
            "    var body: some View {",
            '        HStack { if live { IconButton(systemName: "stop", tooltip: "Stop") {} } }',
            "            .liveRow()",
            "    }",
            "}",
        ].join("\n");
        expect(checkSwiftSource("Sources/Example.swift", source)).toMatchObject([
            { rule: "swift-rowlive-read-in-liverow-struct", line: 2, column: 5 },
        ]);
    });

    test("a child view that reads rowLive inside a row that applies .liveRow is the fix, not a hit", () => {
        const source = [
            "struct AgentProcsRow: View {",
            "    var body: some View {",
            "        HStack { AgentProcsActions() }.liveRow()",
            "    }",
            "    private struct AgentProcsActions: View {",
            "        @Environment(\\.rowLive) private var live",
            '        var body: some View { if live { Text("x") } }',
            "    }",
            "}",
        ].join("\n");
        expect(swiftRules(source)).toEqual([]);
    });

    test(".liveRow before .rowButton or .instantTooltip in one chain is flagged; after them it is not", () => {
        const wrong = [
            "struct Row: View {",
            "    var body: some View {",
            "        label",
            "            .liveRow(selected: selected)",
            "            .rowButton { select() }",
            "            .contextMenu { menu }",
            "    }",
            "}",
        ].join("\n");
        expect(checkSwiftSource("Sources/Example.swift", wrong)).toMatchObject([
            { rule: "swift-liverow-outside-control", line: 5 },
        ]);
        const right = wrong.replace(
            "            .liveRow(selected: selected)\n            .rowButton { select() }",
            "            .rowButton { select() }\n            .instantTooltip(path)\n            .liveRow(selected: selected)"
        );
        expect(swiftRules(right)).toEqual([]);
        expect(swiftRules('label.rowLive(true).instantTooltip("x")')).toEqual(["swift-liverow-outside-control"]);
        expect(swiftRules('label.instantTooltip("x").rowLive(true)')).toEqual([]);
    });

    test("a control inside a closure of a later modifier, or in a new statement, does not count as the chain", () => {
        const source = [
            "struct Row: View {",
            "    var body: some View {",
            "        label",
            "            .liveRow()",
            "            .contextMenu {",
            '                Button("Open") { open() }.instantTooltip("Opens it")',
            "            }",
            "        other.rowButton { select() }",
            "    }",
            "}",
        ].join("\n");
        expect(swiftRules(source)).toEqual([]);
    });

    test("a comment between two modifiers keeps the chain: .liveRow after a commented .rowButton is seen", () => {
        // AgentDraftsList.swift:41 on 2026-10-29: the masked comment line ended the chain walk, and CI failed on a
        // row that was already gated.
        const source = [
            "struct List: View {",
            "    var body: some View {",
            "        ForEach(drafts) { draft in",
            "            AgentDraftRow(draft: draft)",
            "                .rowButton(cornerRadius: 6) { reveal(draft.id) }",
            "                // The button exists under the pointer or on the focused draft (`liveRow`).",
            "                .liveRow(selected: focused == draft.id)",
            "        }",
            "    }",
            "}",
        ].join("\n");
        expect(swiftRules(source)).toEqual([]);
        expect(swiftRules(source.replace("                .liveRow(selected: focused == draft.id)\n", ""))).toEqual([
            "swift-control-chained-to-row-construction",
        ]);
    });

    test("a modifier after a trailing closure's closing brace is still the chain (`}.liveRow()`)", () => {
        const source = [
            "struct List: View {",
            "    var body: some View {",
            "        ForEach(rows) { row in",
            "            SessionRow(row: row)",
            "                .rowButton {",
            "                    select(row)",
            "                }.liveRow(selected: row.selected)",
            "        }",
            "    }",
            "}",
        ].join("\n");
        expect(swiftRules(source)).toEqual([]);
    });

    test("an Observation onChange that never re-arms is flagged; a suppressed one-shot is not", () => {
        const once = [
            "final class Model {",
            "    private func watchOnce() {",
            "        withObservationTracking {",
            "            _ = mode",
            "        } onChange: { [weak self] in",
            "            self?.modeChanged()",
            "        }",
            "    }",
            "}",
        ].join("\n");
        expect(checkSwiftSource("Sources/Example.swift", once)).toMatchObject([
            { rule: "swift-observation-no-rearm", line: 3 },
        ]);
        expect(
            swiftRules(once.replace("self?.modeChanged()", "self?.modeChanged()\n            self?.watchOnce()"))
        ).toEqual([]);
        expect(
            swiftRules(
                once.replace(
                    "        withObservationTracking {",
                    "        // lint-rules-ignore: one shot on purpose, the test waits for the first change\n        withObservationTracking {"
                )
            )
        ).toEqual([]);
    });

    test("an Observation re-arm inside DispatchQueue.main.async is flagged; a synchronous re-arm is not", () => {
        const late = [
            "final class Model {",
            "    private func watchOwnPlace() {",
            "        withObservationTracking {",
            "            _ = (mode, selectedID)",
            "        } onChange: { [weak self] in",
            "            DispatchQueue.main.async {",
            "                guard let self else { return }",
            "                self.placeChanged()",
            "                self.watchOwnPlace()",
            "            }",
            "        }",
            "    }",
            "}",
        ].join("\n");
        expect(checkSwiftSource("Sources/Example.swift", late)).toMatchObject([
            { rule: "swift-observation-async-rearm", line: 9 },
        ]);
        const sync = [
            "final class Model {",
            "    private func watchOwnPlace() {",
            "        withObservationTracking {",
            "            _ = (mode, selectedID)",
            "        } onChange: { [weak self] in",
            "            guard let self else { return }",
            "            self.placeChanged()",
            "            self.watchOwnPlace()",
            "            DispatchQueue.main.async { self.record() }",
            "        }",
            "    }",
            "}",
        ].join("\n");
        expect(swiftRules(sync)).toEqual([]);
        expect(
            swiftRules(
                late.replace(
                    "                self.watchOwnPlace()",
                    "                // lint-rules-ignore: fixture\n                self.watchOwnPlace()"
                )
            )
        ).toEqual([]);
    });
});

describe("swift row rules (a ForEach makes the rows)", () => {
    const swiftRules = (source: string) => checkSwiftSource("Sources/Example.swift", source).map((f) => f.rule);
    const list = (chain: string) =>
        [
            "struct List: View {",
            "    var body: some View {",
            "        ForEach(rows) { row in",
            chain,
            "        }",
            "    }",
            "}",
        ].join("\n");

    test("a .rowButton or .instantTooltip chained to a row's construction in a ForEach is flagged", () => {
        expect(
            checkSwiftSource(
                "Sources/Example.swift",
                list(
                    "            SessionRow(row: row)\n                .rowButton { select(row) }\n                .id(row.id)"
                )
            )
        ).toMatchObject([{ rule: "swift-control-chained-to-row-construction", line: 5 }]);
        expect(swiftRules(list("            SessionRow(row: row).instantTooltip(row.path)"))).toEqual([
            "swift-control-chained-to-row-construction",
        ]);
    });

    test("the same chain is fine when it ends in .liveRow, and a plain construction is fine", () => {
        expect(
            swiftRules(
                list(
                    "            SessionRow(row: row)\n                .rowButton { select(row) }\n                .liveRow(selected: row.selected)"
                )
            )
        ).toEqual([]);
        expect(swiftRules(list("            SessionRow(row: row).equatable().id(row.id)"))).toEqual([]);
        expect(swiftRules(list("            Text(row.title).instantTooltip(row.path)"))).toEqual([]);
    });

    test("a popover or sheet before .liveRow in one chain is flagged at the .liveRow", () => {
        const source = [
            "struct Row: View {",
            "    var body: some View {",
            "        label",
            "            .popover(isPresented: $open) { Panel() }",
            "            .liveRow(selected: selected)",
            "    }",
            "}",
        ].join("\n");
        expect(checkSwiftSource("Sources/Example.swift", source)).toMatchObject([
            { rule: "swift-presentation-inside-liverow", line: 5 },
        ]);
        expect(
            swiftRules(
                source.replace(
                    ".popover(isPresented: $open) { Panel() }\n            .liveRow(selected: selected)",
                    ".liveRow(selected: selected)\n            .popover(isPresented: $open) { Panel() }"
                )
            )
        ).toEqual([]);
    });

    test("a view that sets .liveRow and still passes live: or interactive: by hand is flagged", () => {
        const source = [
            "struct Row: View {",
            "    var body: some View {",
            "        HStack {",
            '            LiveButton(live: live, tooltip: nil, action: open) { Text("Open") }',
            "            ExternalLink(text: name, url: url, interactive: live)",
            "            ExternalLink(text: other, url: url, interactive: false)",
            "        }",
            "        .liveRow(selected: selected)",
            "    }",
            "}",
        ].join("\n");
        expect(checkSwiftSource("Sources/Example.swift", source)).toMatchObject([
            { rule: "swift-row-gates-control-itself", line: 4 },
            { rule: "swift-row-gates-control-itself", line: 5 },
        ]);
        expect(
            swiftRules(source.replace("LiveButton(live: live, ", "LiveButton(").replace(", interactive: live)", ")"))
        ).toEqual([]);
    });
});

describe("swift row gates (what a row a ForEach makes may not carry)", () => {
    const swiftRules = (source: string, file = "Sources/Example.swift") =>
        checkSwiftSource(file, source).map((f) => f.rule);
    const listOf = (row: string, chain = "") =>
        [
            "struct List: View {",
            "    var body: some View {",
            "        ForEach(items) { item in",
            `            ItemRow(item: item)${chain}`,
            "        }",
            "    }",
            "}",
            row,
        ].join("\n");

    test("a row that observes a store is flagged at the property; the same struct outside a ForEach is not", () => {
        const row = [
            "struct ItemRow: View {",
            "    @ObservedObject var store: ItemStore",
            "    let item: Item",
            "    var body: some View { Text(item.title) }",
            "}",
        ].join("\n");
        expect(checkSwiftSource("Sources/Example.swift", listOf(row))).toMatchObject([
            { rule: "swift-row-observes-store", line: 9, subject: "ItemRow" },
        ]);
        expect(swiftRules(row)).toEqual([]);
        expect(
            swiftRules(listOf(row.replace("@ObservedObject var store: ItemStore", "let store = ItemStore.shared")))
        ).toEqual(["swift-row-observes-store"]);
        expect(swiftRules(listOf(row.replace("@ObservedObject var store: ItemStore", "let selected: Bool")))).toEqual(
            []
        );
        expect(
            swiftRules(
                listOf(
                    row.replace(
                        "    @ObservedObject var store: ItemStore",
                        "    // lint-rules-ignore: 3 rows, observes on purpose\n    @ObservedObject var store: ItemStore"
                    )
                )
            )
        ).toEqual([]);
    });

    test("a row with a control and no liveness is flagged; .liveRow inside, at the site, or a rowLive read passes", () => {
        const row = (body: string) =>
            ["struct ItemRow: View {", "    let item: Item", "    var body: some View {", body, "    }", "}"].join(
                "\n"
            );
        const resting = row("        Text(item.title).instantTooltip(item.path)");
        expect(checkSwiftSource("Sources/Example.swift", listOf(resting))).toMatchObject([
            { rule: "swift-row-control-at-rest", line: 11, subject: "ItemRow" },
        ]);
        expect(swiftRules(listOf(row("        Text(item.title).instantTooltip(item.path).liveRow()")))).toEqual([]);
        expect(swiftRules(listOf(resting, "\n                .liveRow(selected: item.selected)"))).toEqual([]);
        expect(
            swiftRules(
                listOf(
                    resting.replace(
                        "    let item: Item",
                        "    let item: Item\n    @Environment(\\.rowLive) private var live"
                    )
                )
            )
        ).toEqual([]);
        expect(swiftRules(listOf(row("        Text(item.title)")))).toEqual([]);
        expect(swiftRules(listOf(row('        Button("Open") { open(item) }')))).toEqual(["swift-row-control-at-rest"]);
    });

    test("an == that skips a stored value is flagged with the names; closures, class references and a marked property are not", () => {
        const view = (equals: string, extra = "") =>
            [
                "final class ItemStore {}",
                "struct ItemRow: View, Equatable {",
                "    let item: Item",
                "    let count: Int",
                "    let store: ItemStore",
                "    let model: HubModel",
                "    let select: () -> Void",
                "    var onHover: ((Bool) -> Void)? = nil",
                extra,
                "    static func == (a: ItemRow, b: ItemRow) -> Bool {",
                `        ${equals}`,
                "    }",
                "    var body: some View { Text(item.title) }",
                "}",
            ].join("\n");
        const narrow = checkSwiftSource("Sources/Example.swift", view("a.item == b.item"));
        expect(narrow).toMatchObject([{ rule: "swift-equatable-eq-skips-value", line: 10, subject: "ItemRow" }]);
        expect(narrow[0].message).toEndWith("Skipped: count.");
        expect(swiftRules(view("a.item == b.item && a.count == b.count"))).toEqual([]);
        expect(
            swiftRules(view("a.item == b.item", "    // lint-rules-ignore: count follows item\n    let count: Int"))
        ).toEqual(["swift-equatable-eq-skips-value"]);
        expect(
            swiftRules(
                view("a.item == b.item").replace(
                    "    let count: Int",
                    "    // lint-rules-ignore: count follows item\n    let count: Int"
                )
            )
        ).toEqual([]);
    });

    test("a formatter or a regex made in a view is flagged; a static let is not", () => {
        const view = (line: string) =>
            [
                "struct StampLabel: View {",
                "    let date: Date",
                `    ${line}`,
                "    var body: some View { Text(formatter.string(from: date)) }",
                "}",
            ].join("\n");
        expect(
            checkSwiftSource("Sources/Example.swift", view("private var formatter: DateFormatter { DateFormatter() }"))
        ).toMatchObject([{ rule: "swift-formatter-in-view", line: 3, subject: "StampLabel" }]);
        expect(swiftRules(view("private static let formatter = DateFormatter()"))).toEqual([]);
        expect(
            swiftRules(view('private var regex: NSRegularExpression? { try? NSRegularExpression(pattern: "x") }'))
        ).toEqual(["swift-formatter-in-view"]);
        expect(swiftRules("enum Stamps {\n    static func make() -> DateFormatter { DateFormatter() }\n}")).toEqual([]);
    });
});

describe("the swift row ratchets (scripts/ci/swift-row-ratchet.ts)", () => {
    const lists: Array<[string, ReadonlySet<string>]> = [
        ["swift-row-observes-store", SWIFT_ROW_OBSERVES_RATCHET],
        ["swift-row-control-at-rest", SWIFT_ROW_CONTROL_RATCHET],
        ["swift-formatter-in-view", SWIFT_FORMATTER_IN_VIEW_RATCHET],
        ["swift-equatable-eq-skips-value", SWIFT_EQUATABLE_SKIPS_RATCHET],
    ];

    test("every ratchet entry still trips its gate with the ratchet off, and passes with it on", async () => {
        const stale: string[] = [];
        const leaking: string[] = [];

        for (const [rule, list] of lists) {
            for (const key of list) {
                const [file, subject] = key.split("#");
                const source = await Bun.file(file).text();
                const trips = checkSwiftSource(file, source, { ratchets: false }).some(
                    (f) => f.rule === rule && f.subject === subject
                );
                const passes = !checkSwiftSource(file, source).some((f) => f.rule === rule && f.subject === subject);

                if (!trips) {
                    stale.push(`${rule}: ${key}`);
                }

                if (!passes) {
                    leaking.push(`${rule}: ${key}`);
                }
            }
        }

        expect(stale).toEqual([]);
        expect(leaking).toEqual([]);
    });
});

describe("swiftRowAudit (the scanner's candidates)", () => {
    test("names a row that observes a store, carries controls with no .liveRow, is not Equatable, and tracks hover", () => {
        const source = [
            "struct List: View {",
            "    var body: some View {",
            "        ForEach(items) { item in",
            "            ItemRow(item: item)",
            "        }",
            "    }",
            "}",
            "struct ItemRow: View {",
            "    @ObservedObject var store: ItemStore",
            "    let item: Item",
            "    @State private var hovering = false",
            "    var body: some View {",
            "        Text(item.title).instantTooltip(item.path)",
            "    }",
            "}",
        ].join("\n");
        const audit = swiftRowAudit(maskSwiftNonCode(source).split("\n"));
        expect(audit).toEqual([
            "ItemRow (L8-L15): observes a model or a shared store; a row takes values",
            "ItemRow (L8-L15): controls at rest and no .liveRow(selected:) on the row",
            "ItemRow (L8-L15): not Equatable (closures and class references defeat the automatic compare)",
            "ItemRow (L8-L15): tracks its own hover (@State hovering); .liveRow does it",
        ]);
    });

    test("a value row with .liveRow, Equatable, .equatable() and a full == is clean; a skipped field is named", () => {
        const source = [
            "struct List: View {",
            "    var body: some View {",
            "        ForEach(items) { item in",
            "            ItemRow(item: item, selected: item.id == selectedID, select: { select(item) }).equatable()",
            "        }",
            "    }",
            "}",
            "struct ItemRow: View, Equatable {",
            "    let item: Item",
            "    let selected: Bool",
            "    let select: () -> Void",
            "    static func == (a: ItemRow, b: ItemRow) -> Bool {",
            "        a.item == b.item && a.selected == b.selected",
            "    }",
            "    var body: some View {",
            "        Text(item.title).rowButton(select).instantTooltip(item.path).liveRow(selected: selected)",
            "    }",
            "}",
        ].join("\n");
        expect(swiftRowAudit(maskSwiftNonCode(source).split("\n"))).toEqual([]);
        const narrow = source.replace("a.item == b.item && a.selected == b.selected", "a.item == b.item");
        expect(swiftRowAudit(maskSwiftNonCode(narrow).split("\n"))).toEqual([
            "ItemRow (L8-L18): == skips selected (a value the body reads is stale)",
        ]);
    });
});

describe("swift-no-entry-macro", () => {
    const swiftRules = (source: string) => checkSwiftSource("Sources/Example.swift", source).map((f) => f.rule);

    test("flags @Entry, which needs Xcode's SwiftUIMacros plugin", () => {
        expect(swiftRules("extension EnvironmentValues {\n    @Entry public var flag = false\n}\n")).toEqual([
            "swift-no-entry-macro",
        ]);
    });

    test("ignores inline comments and ordinary, escaped, raw and multiline string literals", () => {
        const source = [
            "let flag = false // @Entry",
            'let text = "@Entry"',
            'let escaped = "quote: \\" @Entry"',
            'let raw = #"@Entry "quoted""#',
            'let multiline = """',
            "@Entry",
            '"""',
            'let rawMultiline = ##"""',
            '@Entry """ still raw',
            '"""##',
            'let multipleHashes = ##"@Entry"##',
            String.raw`let interpolated = "\("@Entry")"`,
            String.raw`let rawInterpolated = #"\#("@Entry")"#`,
        ].join("\n");
        expect(swiftRules(source)).toEqual([]);
    });

    test("ignores nested block comments while preserving the position of a real attribute", () => {
        const source = [
            "/* @Entry",
            "   /* nested @Entry */ still a comment",
            "*/ extension EnvironmentValues {",
            "/* @Entry */ @Entry var flag = false",
            "}",
        ].join("\n");
        expect(checkSwiftSource("Sources/Example.swift", source)).toMatchObject([
            { rule: "swift-no-entry-macro", line: 4, column: 14, text: "/* @Entry */ @Entry var flag = false" },
        ]);
    });

    test("still flags attributes after strings and honours an explicit suppression", () => {
        expect(swiftRules('let text = "@Entry"; @Entry var flag = false')).toEqual(["swift-no-entry-macro"]);
        expect(swiftRules('let raw = #"@Entry"#; @Entry var flag = false')).toEqual(["swift-no-entry-macro"]);
        expect(swiftRules("// lint-rules-ignore: fixture\n@Entry var flag = false")).toEqual([]);
    });

    test("ignores hash-delimited regex contents, including quotes and escaped delimiters", () => {
        for (const pattern of ["#/@Entry/#", '#/"/#', '##/@Entry /# " /##', String.raw`#/\/# @Entry/#`]) {
            expect(swiftRules(`let pattern = ${pattern}`)).toEqual([]);
        }

        expect(swiftRules('let pattern = #/\n@Entry " // /*\n/#')).toEqual([]);
    });

    test("a quote inside a regex cannot hide a later real attribute or move its diagnostic", () => {
        for (const pattern of ['#/"/#', '##/" /# @Entry /##', String.raw`#/\/# " @Entry/#`]) {
            const source = `let pattern = ${pattern}\n@Entry var flag = false`;
            expect(checkSwiftSource("Sources/Example.swift", source)).toMatchObject([
                { rule: "swift-no-entry-macro", line: 2, column: 1, text: "@Entry var flag = false" },
            ]);
        }
    });

    test("leaves a hand-written EnvironmentKey and a mention in a comment alone", () => {
        const source = [
            "private struct FlagKey: EnvironmentKey { static let defaultValue = false }",
            "// was @Entry before #564",
            "extension EnvironmentValues {",
            "    var flag: Bool { get { self[FlagKey.self] } set { self[FlagKey.self] = newValue } }",
            "}",
        ].join("\n");
        expect(swiftRules(source)).toEqual([]);
    });
});

describe("no-hardcoded-tmp", () => {
    test("flags a /tmp literal in the binding contexts GritQL enumerated", () => {
        expect(rules('const p = "/tmp/x";')).toContain("no-hardcoded-tmp");
        expect(rules('foo("/tmp/x");')).toContain("no-hardcoded-tmp");
        expect(rules('return "/tmp/x";')).toContain("no-hardcoded-tmp");
    });

    test("also flags contexts GritQL could not reach — the reason it missed real bugs", () => {
        // An object property. `videoOut: "/tmp/run.mp4"` sat in the repo
        // unflagged because no GritQL pattern covered this position.
        expect(rules('const plan = { videoOut: "/tmp/run.mp4" };')).toContain("no-hardcoded-tmp");
        expect(rules('const p = process.env.X ?? "/tmp/db.sqlite";')).toContain("no-hardcoded-tmp");
    });

    test("leaves bare /tmp and other paths alone", () => {
        expect(rules('const p = "/tmp";')).toEqual([]);
        expect(rules('const p = "/var/tmp/x";')).toEqual([]);
    });

    test("honours the suppression comment", () => {
        expect(rules('// lint-rules-ignore: fixture\nconst p = "/tmp/x";')).toEqual([]);
        expect(rules('const p = "/tmp/x"; // lint-rules-ignore: fixture')).toEqual([]);
    });

    test("does NOT honour biome's own marker, which biome would then call unused", () => {
        expect(rules('// biome-ignore lint/plugin: stale\nconst p = "/tmp/x";')).toContain("no-hardcoded-tmp");
    });
});

describe("no-hardcoded-user-paths", () => {
    test("flags an absolute /Users path", () => {
        expect(rules('const p = "/Users/Martin/Projects/x";')).toContain("no-hardcoded-user-paths");
    });

    test("reports it as a warning, matching the original severity", () => {
        const [finding] = checkSource("src/example.ts", 'const p = "/Users/Martin/x";');
        expect(finding.severity).toBe("warn");
    });

    test("leaves a bare /Users prefix alone", () => {
        expect(rules('const p = "/UsersGuide";')).toEqual([]);
    });
});

describe("no-hand-joined-genesis-tools", () => {
    test("flags the data directory reached through homedir()", () => {
        expect(rules('const d = join(homedir(), ".genesis-tools", "daemon");')).toContain(
            "no-hand-joined-genesis-tools"
        );
    });

    test("flags a template that builds the same path", () => {
        expect(rules("const d = `${homedir()}/.genesis-tools/daemon`;")).toContain("no-hand-joined-genesis-tools");
    });

    test("flags arbitrary homes and path function forms", () => {
        for (const home of ["env.tools.getHome()", "env.paths.getHome()", "home", "resolve(home)"]) {
            expect(rules(`const d = join(${home}, ".genesis-tools", "daemon");`)).toContain(
                "no-hand-joined-genesis-tools"
            );
        }
        expect(rules('const d = path.resolve(home, ".genesis-tools/daemon");')).toContain(
            "no-hand-joined-genesis-tools"
        );
        expect(rules("const d = `${home}/.genesis-tools/daemon`;")).toContain("no-hand-joined-genesis-tools");
    });

    test("allows helpers, the canonical implementation, tests, plugins and lookalike names", () => {
        expect(rules('const d = genesisToolsDir("daemon");')).toEqual([]);
        expect(rules('const d = genesisToolsDirIn(home, "daemon");')).toEqual([]);
        const direct = 'const d = join(home, ".genesis-tools", "daemon");';
        expect(rules(direct, "src/utils/storage/root.ts")).toEqual([]);
        expect(rules(direct, "plugins/example/index.ts")).toEqual([]);
        expect(rules(direct, "src/example.test.ts")).toEqual([]);
        expect(rules('const d = join(home, ".genesis-tools-backup");')).toEqual([]);
        expect(rules(`// lint-rules-ignore: intentional fixture\n${direct}`)).toEqual([]);
        expect(rules("const shell = '\"${HOME}/.genesis-tools/cmux\"';")).toEqual([]);
    });

    test("LEAVES LaunchAgent plist names alone", () => {
        // `com.genesis-tools.daemon.plist` contains the string but is not the
        // data directory, and homedir() is correct for ~/Library/LaunchAgents.
        expect(
            rules('const p = join(homedir(), "Library", "LaunchAgents", "com.genesis-tools.daemon.plist");')
        ).toEqual([]);
    });
});

describe("no-direct-prompt-backend", () => {
    test("flags a direct backend call", () => {
        expect(rules("await inquirerBackend.select({});")).toContain("no-direct-prompt-backend");
        expect(rules("await clackBackend.confirm({});")).toContain("no-direct-prompt-backend");
    });

    test("leaves the p facade and unrelated methods alone", () => {
        expect(rules("await p.select({});")).toEqual([]);
        expect(rules("await inquirerBackend.dispose();")).toEqual([]);
    });
});

describe("no-mock-module-prompts", () => {
    test("flags a mocked prompt module", () => {
        expect(rules('mock.module("@genesiscz/utils/prompts/p", () => ({}));')).toContain("no-mock-module-prompts");
        expect(rules('mock.module("inquirer/prompts", () => ({}));')).toContain("no-mock-module-prompts");
    });

    test("leaves other mocked modules alone", () => {
        expect(rules('mock.module("node:fs", () => ({}));')).toEqual([]);
    });
});

describe("test-spawn-needs-env (test files only)", () => {
    const inTest = (source: string) => rules(source, "src/foo.test.ts");
    const CP = 'import { spawnSync, execSync } from "node:child_process";\n';

    test("flags Bun.spawn / Bun.spawnSync without env, with or without an options object", () => {
        expect(inTest('Bun.spawnSync(["ls"]);')).toContain("test-spawn-needs-env");
        expect(inTest('Bun.spawn(["ls"], { stdout: "pipe" });')).toContain("test-spawn-needs-env");
        expect(inTest('Bun.spawn({ cmd: ["ls"], stdout: "pipe" });')).toContain("test-spawn-needs-env");
    });

    test("passes when env is given in any form", () => {
        expect(inTest('Bun.spawn(["ls"], { stdout: "pipe", env: process.env });')).toEqual([]);
        expect(inTest('Bun.spawn(["ls"], { env: { ...process.env, X: "1" } });')).toEqual([]);
        expect(inTest('const env = process.env; Bun.spawn(["ls"], { env });')).toEqual([]);
        expect(inTest('Bun.spawn({ cmd: ["ls"], env: process.env });')).toEqual([]);
    });

    test("does not guess about options it cannot see into", () => {
        expect(inTest('Bun.spawn(["ls"], opts);')).toEqual([]);
        expect(inTest('Bun.spawn(["ls"], { ...base, stdout: "pipe" });')).toEqual([]);
        expect(inTest('Bun.spawn(["ls"], withEnv({ stdout: "pipe" }));')).toEqual([]);
    });

    test("flags node:child_process calls without env, but only when the module is imported", () => {
        expect(inTest(`${CP}spawnSync("ls", ["-la"], { encoding: "utf8" });`)).toContain("test-spawn-needs-env");
        expect(inTest(`${CP}execSync("ls");`)).toContain("test-spawn-needs-env");
        expect(inTest(`${CP}spawnSync("ls", ["-la"], { encoding: "utf8", env: process.env });`)).toEqual([]);
        // A bare spawn() from somewhere else (a local helper, a mock) is not the rule's business.
        expect(inTest('spawnSync("ls", ["-la"], { encoding: "utf8" });')).toEqual([]);
    });

    test("stays out of production files and honours the suppression comment", () => {
        expect(rules('Bun.spawnSync(["ls"]);', "src/foo.ts")).toEqual([]);
        expect(inTest('// lint-rules-ignore: child writes nothing\nBun.spawnSync(["ls"]);')).toEqual([]);
    });

    test("the literal rules stay off in test files even though the spawn rule runs there", () => {
        expect(inTest('const p = "/tmp/x"; Bun.spawnSync(["ls"], { env: process.env });')).toEqual([]);
    });
});

describe("the biome.json override that disabled plugins for tests", () => {
    /**
     * biome.json carries `{"includes": ["**\/*.test.ts", …], "plugins": []}`, so
     * the GritQL rules never ran on tests. Test files legitimately hardcode
     * /tmp paths and call prompt backends directly; without this the checker
     * reported 300+ findings the originals allowed by design.
     */
    test("skips the same files", () => {
        expect(pluginsDisabledFor("src/foo.test.ts")).toBe(true);
        expect(pluginsDisabledFor("src/foo.test.tsx")).toBe(true);
        expect(pluginsDisabledFor("src/__tests__/foo.ts")).toBe(true);
        expect(pluginsDisabledFor("src/foo.data.ts")).toBe(true);
        expect(pluginsDisabledFor("src/foo.ts")).toBe(false);
    });

    test("a /tmp literal in a test file is not reported", () => {
        expect(rules('const p = "/tmp/x";', "src/foo.test.ts")).toEqual([]);
    });
});

describe("tsx and plain js", () => {
    test("parses .tsx", () => {
        expect(rules('const C = () => <div data-p="/tmp/x" />;', "src/c.tsx")).toContain("no-hardcoded-tmp");
    });

    test("parses every extension the file lister passes in", () => {
        // langFor and targetFiles must agree: a tracked .mts or .cts that one
        // accepts and the other never lists bypasses all six rules.
        for (const file of ["src/a.ts", "src/a.tsx", "src/a.mts", "src/a.cts", "src/a.js", "src/a.mjs", "src/a.cjs"]) {
            expect(rules('const p = "/tmp/x";', file)).toContain("no-hardcoded-tmp");
        }
    });

    test("ignores non-source files", () => {
        expect(rules('const p = "/tmp/x";', "README.md")).toEqual([]);
    });
});

describe("no-sub-100ms-interval", () => {
    test("flags a timer under 100 ms and leaves 100 ms and above alone", () => {
        expect(rules("setInterval(tick, 50);")).toContain("no-sub-100ms-interval");
        expect(rules("const t = setInterval(() => poll(), 20);")).toContain("no-sub-100ms-interval");
        expect(rules("globalThis.setInterval(tick, 0);")).toContain("no-sub-100ms-interval");
        expect(rules("setInterval(tick, 100);")).toEqual([]);
        expect(rules("setInterval(tick, 2_000);")).toEqual([]);
        expect(rules("setTimeout(tick, 20);")).toEqual([]);
    });

    test("a computed delay is not judged, and a suppression names the reason", () => {
        expect(rules("setInterval(tick, opts.pollMs);")).toEqual([]);
        expect(rules("setInterval(tick, 60 * 60 * 1000);")).toEqual([]);
        expect(rules("// lint-rules-ignore: spinner frame rate\nsetInterval(spin, 80);")).toEqual([]);
    });

    test("a delay bound to a sub-100 ms constant is still a violation", () => {
        expect(rules("const ms = 10;\nsetInterval(tick, ms);")).toContain("no-sub-100ms-interval");
        expect(rules("const DEFAULT_TICK_MS = 10;\nsetInterval(tick, DEFAULT_TICK_MS);")).toContain(
            "no-sub-100ms-interval"
        );
        expect(rules("const ms = 200;\nsetInterval(tick, ms);")).toEqual([]);
    });
});

describe("no-sync-poll-loop", () => {
    test("flags sleepSync inside any loop, bare or on Bun", () => {
        expect(rules("while (!done()) { Bun.sleepSync(50); }")).toContain("no-sync-poll-loop");
        expect(rules("for (let i = 0; i < 5; i++) { sleepSync(50); }")).toContain("no-sync-poll-loop");
        expect(rules("do { Bun.sleepSync(1); } while (busy());")).toContain("no-sync-poll-loop");
        expect(rules("for (const step of steps) { run(step); if (gap) { Bun.sleepSync(gap); } }")).toContain(
            "no-sync-poll-loop"
        );
    });

    test("leaves a one-off sleepSync and an async loop alone", () => {
        expect(rules("Bun.sleepSync(400);")).toEqual([]);
        expect(rules("async function wait() { while (!done()) { await Bun.sleep(50); } }")).toEqual([]);
        expect(rules("// lint-rules-ignore: bounded retry\nfor (;;) { Bun.sleepSync(5); }")).toEqual([]);
    });
});

describe("no-process-tool-spawn", () => {
    test("flags ps, lsof and pgrep in every spawn shape", () => {
        for (const source of [
            'exec(["ps", "-axo", "pid=,command="]);',
            'Bun.spawnSync(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN"]);',
            'runCommand(["pgrep", "-P", String(pid)]);',
            'spawnSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" });',
            'childProcess.execFileSync("lsof", ["-p", "1"]);',
            'execSync("pgrep -f claude");',
            'execSync("/bin/ps -ax");',
            "await $`/usr/sbin/lsof -nP`;",
            "await $`ps -axo pid=`;",
            'Bun.spawn(["/bin/ps", "-p", String(pid), "-o", "command="]);',
            'const lsofBinary = process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof";',
            'Bun.spawnSync({ cmd: ["pgrep", "-fl", "cloudflared"], stdout: "pipe" });',
            'Bun.spawnSync(["env", "LC_ALL=C", "ps", "-axo", "pid="]);',
            'probeRun("listeners", "lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]);',
            'probeRun("processes", "env", ["LC_ALL=C", "ps", "-axo", COLUMNS]);',
            'deps.run("ps", ["-Ao", "pid=,rss="]);',
            'const lsof = Bun.which("lsof");',
            'Bun.spawn(["sh", "-c", "ps -ax"]);',
            'Bun.spawn(["sh", "-c", " /bin/ps -ax"]);',
            'spawnSync("sh", ["-c", "lsof -nP"]);',
            'childProcess.spawn("/bin/bash", ["-lc", "pgrep -f server"]);',
            'Bun.spawn({ cmd: ["env", "LC_ALL=C", "zsh", "-c", "ps -ax"] });',
        ]) {
            expect({ source, rules: rules(source) }).toEqual({ source, rules: ["no-process-tool-spawn"] });
        }
    });

    test("one line is one finding, however many shapes it holds", () => {
        expect(
            rules('const lsof = Bun.which("lsof") ?? (existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : null);')
        ).toEqual(["no-process-tool-spawn"]);
    });

    test("leaves other programs, log text and a bare string alone", () => {
        expect(rules('exec(["git", "status"]);')).toEqual([]);
        expect(rules('log.debug("ps -axo did not exit cleanly");')).toEqual([]);
        expect(rules('spawnSync("psql", ["-c", "select 1"]);')).toEqual([]);
        expect(rules('const program = "ps";')).toEqual([]);
        expect(rules('this.run(["ps", "--filter", "name=db"]);')).toEqual([]);
        expect(rules('program.command("ps").description("list running artifacts");')).toEqual([]);
        expect(rules('Bun.spawnSync(["env", "LC_ALL=C", "git", "status"]);')).toEqual([]);
        expect(rules('const docs = "/usr/share/man/man1/ps.1";')).toEqual([]);
        expect(rules('Bun.spawn(["sh", "-c", "echo ps"]);')).toEqual([]);
        expect(rules('spawnSync("sh", ["ps", "-c", "echo ok"]);')).toEqual([]);
    });

    test("the process layer and the benchmarks may spawn them, and a suppression names the reason", () => {
        const source = 'Bun.spawnSync(["ps", "-axo", "pid="]);';
        expect(rules(source, "src/utils/process/ps.ts")).toEqual([]);
        expect(rules(source, "scripts/benchmarks/process/process-child.ts")).toEqual([]);
        expect(rules(`// lint-rules-ignore: Linux fallback\n${source}`)).toEqual([]);
    });
});

/**
 * A fake tool the wrapper starts, made once per body and kept: a new script per run, deleted with the run's folder,
 * was one of the executables syspolicyd crashed on when the Mac froze on 2026-10-14.
 */
const fakeTool = keptExecutable;

describe("lint-changed wrapper dispatch", () => {
    test("Swift-only and empty diffs still run repo rules while Biome remains scoped", () => {
        const dir = mkdtempSync(join(tmpdir(), "lint-changed-"));
        const trace = join(dir, "trace");
        const bun = fakeTool(
            "bun",
            '#!/bin/sh\nprintf "bun %s\\n" "$*" >> "$LINT_TRACE"\nexit "${FAKE_BUN_EXIT:-0}"\n'
        );
        const biome = fakeTool("biome", '#!/bin/sh\nprintf "biome %s\\n" "$*" >> "$LINT_TRACE"\n');
        const run = (args: string[], extraEnv: Record<string, string> = {}) =>
            spawnSync(args[0]!, args.slice(1), {
                cwd: dir,
                encoding: "utf8",
                env: {
                    ...process.env,
                    PATH: `${dirname(bun)}:${process.env.PATH ?? ""}`,
                    LINT_TRACE: trace,
                    ...extraEnv,
                },
            });

        try {
            mkdirSync(join(dir, "scripts", "ci"), { recursive: true });
            mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
            cpSync(join(import.meta.dir, "lint-changed.sh"), join(dir, "scripts", "ci", "lint-changed.sh"));
            symlinkSync(biome, join(dir, "node_modules", ".bin", "biome"));
            expect(run(["git", "init", "-q"]).status).toBe(0);
            expect(run(["git", "config", "user.name", "Fixture User"]).status).toBe(0);
            expect(run(["git", "config", "user.email", "fixture@example.com"]).status).toBe(0);
            writeFileSync(join(dir, "Native.swift"), "let ready = true\n");
            expect(run(["git", "add", "Native.swift"]).status).toBe(0);
            expect(run(["git", "commit", "-qm", "base"]).status).toBe(0);
            const base = run(["git", "rev-parse", "HEAD"]).stdout.trim();

            writeFileSync(join(dir, "Native.swift"), "let ready = sem.wait()\n");
            const swiftOnly = run(["bash", "scripts/ci/lint-changed.sh", base]);
            expect(swiftOnly.status).toBe(0);
            expect(readFileSync(trace, "utf8")).toBe(`bun scripts/ci/lint-rules.ts --changed ${base}\n`);

            writeFileSync(trace, "");
            expect(run(["git", "add", "Native.swift"]).status).toBe(0);
            expect(run(["git", "commit", "-qm", "swift"]).status).toBe(0);
            const current = run(["git", "rev-parse", "HEAD"]).stdout.trim();
            const empty = run(["bash", "scripts/ci/lint-changed.sh", current]);
            expect(empty.status).toBe(0);
            expect(readFileSync(trace, "utf8")).toBe(`bun scripts/ci/lint-rules.ts --changed ${current}\n`);

            writeFileSync(trace, "");
            const crashed = run(["bash", "scripts/ci/lint-changed.sh", current], { FAKE_BUN_EXIT: "7" });
            expect(crashed.status).toBe(7);

            // A config-only change touches no source file, yet it can break any of them.
            writeFileSync(join(dir, "biome.json"), '{ "linter": { "enabled": true } }\n');
            expect(run(["git", "add", "biome.json"]).status).toBe(0);
            expect(run(["git", "commit", "-qm", "config"]).status).toBe(0);
            writeFileSync(trace, "");
            const configOnly = run(["bash", "scripts/ci/lint-changed.sh", current]);
            expect(configOnly.status).toBe(0);
            expect(readFileSync(trace, "utf8")).toBe(
                `bun run lint:biome\nbun scripts/ci/lint-rules.ts --changed ${current}\n`
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("no-raw-genesis-link", () => {
    test("flags a router link built outside the router utils", () => {
        expect(rules("const u = `https://genesis.tools/md/open?path=${p}`;", "src/agents/x.ts")).toContain(
            "no-raw-genesis-link"
        );
    });

    test("flags an app scheme link built by hand", () => {
        expect(rules("const u = `genesis-md://open?path=${p}`;", "src/gitlab/x.ts")).toContain("no-raw-genesis-link");
        expect(rules('const u = "genesis-tools://hub";', "src/hub/x.ts")).toContain("no-raw-genesis-link");
    });

    test("allows the router utils, which own the gate", () => {
        expect(rules('const u = "https://genesis.tools/t/";', "src/utils/browser-router/x.ts")).not.toContain(
            "no-raw-genesis-link"
        );
    });
});

describe("no-tool-command-in-utils", () => {
    const rule = "no-tool-command-in-utils";

    test("flags a toolCommand call and a written-out tools command under src/utils", () => {
        expect(rules('const h = `run ${toolCommand("question show")} <id>`;', "src/utils/x/a.ts")).toContain(rule);
        expect(rules('const h = suggestCommand("tools notify", {});', "src/utils/x/a.ts")).toContain(rule);
        expect(rules('const h = "run `tools json2md build` again";', "src/utils/x/a.ts")).toContain(rule);
    });

    test("passes prose, comments, hints.ts and code outside src/utils", () => {
        expect(rules('const h = "the tools are slow";', "src/utils/x/a.ts")).not.toContain(rule);
        expect(rules("// run tools json2md build\nconst a = 1;", "src/utils/x/a.ts")).not.toContain(rule);
        expect(rules('const h = toolCommand("say");', "src/utils/genesis-tools/tools/hints.ts")).not.toContain(rule);
        expect(rules('const h = toolCommand("say");', "src/notify/index.ts")).not.toContain(rule);
    });

    test("every ratchet entry still names a command, so a migrated file leaves the list", async () => {
        const stale: string[] = [];

        for (const file of TOOL_COMMAND_RATCHET) {
            const root = parse(file.endsWith(".tsx") ? Lang.Tsx : Lang.TypeScript, await Bun.file(file).text()).root();
            const literals = root.findAll({ rule: { any: [{ kind: "string" }, { kind: "template_string" }] } });

            if (!literals.some((node) => namesToolCommand(node.text(), node))) {
                stale.push(file);
            }
        }

        expect(stale).toEqual([]);
    });
});

describe("no-bun-only-import-meta", () => {
    const rule = "no-bun-only-import-meta";

    test("flags the line that broke tools clarity ui, and every Bun-only member, in shared and dashboard code", () => {
        const broke = 'const PASS_SCRIPT = path.join(import.meta.dir, "..", "compress", "daily-pass.ts");';
        expect(rules(broke, "src/utils/logger/daily-trigger.ts")).toContain(rule);
        for (const member of ["dir", "dirname", "filename", "path"]) {
            expect(rules(`const a = import.meta.${member};`, "src/clarity/ui/src/server.ts")).toContain(rule);
        }
        // The two dashboards whose sources live outside a `ui/` folder.
        expect(rules("const a = import.meta.dir;", "src/claude-history-dashboard/src/server.ts")).toContain(rule);
        expect(rules("const a = import.meta.dir;", "src/debugging-master/dashboard/src/server.ts")).toContain(rule);
    });

    test("passes module-dir.ts, tests, vite configs, import.meta.url and code no dashboard loads", () => {
        expect(rules("const a = import.meta.dir;", "src/utils/fs/module-dir.ts")).not.toContain(rule);
        expect(rules("const a = import.meta.dir;", "src/utils/x/a.test.ts")).not.toContain(rule);
        expect(rules("const a = import.meta.dirname;", "src/monitor/ui/vite.config.ts")).not.toContain(rule);
        expect(rules("const a = import.meta.url;", "src/utils/x/a.ts")).not.toContain(rule);
        expect(rules("const a = import.meta.dir;", "src/du/index.ts")).not.toContain(rule);
    });
});

describe("no-bare-require-in-utils", () => {
    const rule = "no-bare-require-in-utils";

    test("flags a bare require under src/utils, and passes createRequire, member calls and other folders", () => {
        expect(rules('function f() { return require("./x"); }', "src/utils/x/a.ts")).toContain(rule);
        expect(rules('const load = createRequire(import.meta.url); load("./x");', "src/utils/x/a.ts")).not.toContain(
            rule
        );
        expect(rules('const r = module.require("./x");', "src/utils/x/a.ts")).not.toContain(rule);
        expect(rules('const r = require("./x");', "src/du/index.ts")).not.toContain(rule);
    });

    test("every ratchet entry still calls require, so a migrated file leaves the list", async () => {
        const stale: string[] = [];

        for (const file of BARE_REQUIRE_RATCHET) {
            const root = parse(Lang.TypeScript, await Bun.file(file).text()).root();
            const calls = root.findAll({
                rule: { kind: "call_expression", has: { field: "function", regex: "^require$" } },
            });

            if (calls.length === 0) {
                stale.push(file);
            }
        }

        expect(stale).toEqual([]);
    });
});

describe("no-transcript-format-outside-readers", () => {
    const rule = "no-transcript-format-outside-readers";

    test("flags a record type or a raw-line probe outside the readers, and passes the readers and other chat formats", () => {
        expect(rules('if (row.type === "continued-in") {}', "src/claude/lib/x.ts")).toContain(rule);
        expect(rules('const at = text.indexOf(\'"type":"turn_context"\');', "src/hub/lib/x.ts")).toContain(rule);
        expect(rules('if (line.includes(\'"type":"user"\')) {}', "src/agents/lib/hooks/x.ts")).toContain(rule);
        expect(
            rules('if (row.type === "continued-in") {}', "src/utils/agent-sessions/readers/claude.ts")
        ).not.toContain(rule);
        // An LLM chat message is not a transcript record, and a bare role names nothing provider-specific.
        expect(rules('const m = \'{"role":"user","content":"hi"}\';', "src/jev/lib/x.ts")).not.toContain(rule);
        expect(rules('const role = "assistant";', "src/ask/lib/x.ts")).not.toContain(rule);
    });

    test("every ratchet entry still names the transcript format, so a migrated file leaves the list", async () => {
        const stale: string[] = [];

        for (const file of TRANSCRIPT_FORMAT_RATCHET) {
            const root = parse(file.endsWith(".tsx") ? Lang.Tsx : Lang.TypeScript, await Bun.file(file).text()).root();
            const literals = root.findAll({ rule: { any: [{ kind: "string" }, { kind: "template_string" }] } });

            if (!literals.some((node) => namesTranscriptFormat(node.text()))) {
                stale.push(file);
            }
        }

        expect(stale).toEqual([]);
    });
});

describe("the agent and model ratchet rules (❓ DECISION 22 b)", () => {
    test("each rule flags its shape outside the owners and passes the owner and a look-alike", () => {
        const cases: { rule: string; hit: [string, string]; owner?: [string, string]; miss: [string, string] }[] = [
            {
                rule: "no-hand-built-claude-home",
                hit: ['const p = join(homedir(), ".claude", "projects");', "src/hub/lib/x.ts"],
                owner: ['const p = join(homedir(), ".claude");', "src/utils/providers/session-paths.ts"],
                miss: ['const p = join(repoRoot, ".claude", "rules");', "src/hub/lib/x.ts"],
            },
            {
                rule: "no-hand-built-codex-grok-home",
                hit: ['const p = join(homedir(), ".codex");', "src/hub/lib/x.ts"],
                owner: ['const p = join(homedir(), ".codex");', "src/utils/providers/session-paths.ts"],
                miss: ['const p = join(repoRoot, ".codex-review");', "src/hub/lib/x.ts"],
            },
            {
                rule: "no-model-id-literal-outside-catalog",
                hit: ['export const DEFAULT_MODEL = "claude-opus-5";', "src/ai/lib/x.ts"],
                owner: ['const id = "claude-opus-5-5";', "src/utils/ai/catalog/static.ts"],
                miss: ['const hint = "Try: opus, claude-sonnet-5-5, haiku";', "src/ai/lib/x.ts"],
            },
            {
                rule: "no-model-price-table",
                hit: ["const P = { opus: { input: 15, output: 75 } };", "src/ai-spend/lib/x.ts"],
                miss: ["const P = { opus: { ...base } };", "src/ai-spend/lib/x.ts"],
            },
            {
                rule: "no-effort-vocabulary-list",
                hit: ['export const E = ["low", "medium", "high", "xhigh"] as const;', "src/utils/worker/x.ts"],
                owner: ['export const E = ["low", "high", "xhigh"];', "src/utils/ai/catalog/efforts.ts"],
                miss: ['const args = ["--effort", "xhigh", "--yes"];', "src/claude/lib/x.ts"],
            },
            {
                rule: "no-harness-name-branch",
                hit: ['if (node.harness === "claude") {}', "src/hub/lib/x.ts"],
                owner: ['if (kind === "codex") {}', "src/utils/agent-sessions/x.ts"],
                miss: ['if (theme.name === "claude") {}', "src/hub/lib/x.ts"],
            },
            {
                rule: "no-hook-payload-read",
                hit: ["const t = payload.raw.transcript_path;", "src/agents/lib/hooks/x.ts"],
                owner: ["const t = raw.transcript_path;", "src/agents/lib/hooks/payload.ts"],
                miss: ['const fixture = { transcript_path: "/x.jsonl" };', "src/agents/lib/hooks/x.ts"],
            },
            {
                rule: "no-agent-name-in-command-match",
                hit: ["const live = /claude/i.test(process.command);", "src/question/lib/x.ts"],
                owner: ["const live = /claude/i.test(process.command);", "src/utils/process/classify.ts"],
                miss: ['const t = text.includes("claude");', "src/timely/x.ts"],
            },
            {
                rule: "no-proxy-provider-branch",
                hit: ['if (account.provider === "grok-subscription") {}', "src/ai-proxy/lib/x.ts"],
                owner: ['if (account.provider === "grok-subscription") {}', "src/ai-proxy/lib/providers/x.ts"],
                miss: ['if (format === "openai") {}', "src/ai-proxy/lib/x.ts"],
            },
        ];

        for (const { rule, hit, owner, miss } of cases) {
            expect({ rule, found: rules(...hit).includes(rule) }).toEqual({ rule, found: true });
            expect({ rule, miss: rules(...miss).includes(rule) }).toEqual({ rule, miss: false });

            if (owner) {
                expect({ rule, owner: rules(...owner).includes(rule) }).toEqual({ rule, owner: false });
            }
        }
    });

    test("standalone home templates are native roots, while repository-relative templates are not", () => {
        for (const provider of ["claude", "codex", "grok"]) {
            const rule = provider === "claude" ? "no-hand-built-claude-home" : "no-hand-built-codex-grok-home";

            for (const home of ["homedir()", "env.paths.getHome()", "home"]) {
                const source = `const root = \`\${${home}}/.${provider}\`;`;
                expect(rules(source)).toContain(rule);
                expect(rules(source, "src/utils/providers/session-paths.ts")).not.toContain(rule);
            }

            const repositorySource = `const root = \`\${repoRoot}/.${provider}\`;`;
            expect(rules(repositorySource)).not.toContain(rule);
        }
    });

    test("hook payload reads include destructuring and literal indexes, but not payload construction", () => {
        const rule = "no-hook-payload-read";
        const file = "src/agents/lib/hooks/example.ts";
        const owner = "src/agents/lib/hooks/payload.ts";

        for (const source of [
            "const { transcript_path } = payload.raw;",
            "const { tool_input: input } = payload.raw;",
            "const { tool_response = {} } = payload.raw;",
            "({ hook_event_name: event } = payload.raw);",
            "const { toolInput } = payload.raw;",
            "const { raw: { toolInput } } = payload;",
            'const { ["tool_input"]: input } = payload.raw;',
            'const input = payload.raw["tool_input"];',
            "const input = payload.raw['toolInput'];",
            'const input = payload["raw"].toolInput;',
        ]) {
            expect(rules(source, file)).toContain(rule);
            expect(rules(source, owner)).not.toContain(rule);
        }

        for (const source of [
            'const payload = { transcript_path: "/fixture.jsonl", tool_input: {} };',
            "const { unrelated: tool_input } = config;",
            "const { toolInput } = config;",
            'const input = config["toolInput"];',
        ]) {
            expect(rules(source, file)).not.toContain(rule);
        }
    });

    test("harness, payload and process diagnostics name their migration owner", () => {
        for (const [source, owner] of [
            ['if (node.harness === "claude") {}', "ProviderPlugin or NativeSessionReader"],
            ["const input = payload.raw.tool_input;", "src/agents/lib/hooks/payload.ts"],
            ["const live = /claude/i.test(process.command);", "src/utils/process/classify.ts"],
        ]) {
            const findings = checkSource("src/example.ts", source);
            expect(findings).toHaveLength(1);
            expect(findings[0].message).toContain(owner);
            expect(findings[0].message).not.toContain("PROBE");
        }
    });

    test("process match methods use the regex and command in their actual positions", () => {
        const rule = "no-agent-name-in-command-match";

        for (const source of [
            "process.command.match(/claude/i);",
            "process.command.search(/codex/);",
            "/grok/.test(process.command);",
        ]) {
            expect(rules(source)).toContain(rule);
            expect(rules(source, "src/utils/process/classify.ts")).not.toContain(rule);
        }

        expect(rules("text.match(/claude/i);")).not.toContain(rule);
        expect(rules("process.command.search(/editor/);")).not.toContain(rule);
    });

    test("established lists reject additions, including a new offender, but allow removals and initialization", () => {
        const list = (files: string[]) =>
            `export const EXAMPLE_RATCHET = new Set<string>(${SafeJSON.stringify(files)});`;
        const source = 'const id = "claude-opus-5";';
        expect(rules(source, "src/new-offender.ts")).toContain("no-model-id-literal-outside-catalog");
        expect(ratchetAdditions(list(["src/old.ts"]), list(["src/old.ts", "src/new-offender.ts"]))).toEqual([
            "EXAMPLE_RATCHET: src/new-offender.ts",
        ]);
        expect(ratchetAdditions(list(["src/old.ts"]), list([]))).toEqual([]);
        expect(ratchetAdditions("", list(["src/old.ts"]))).toEqual([]);
        expect(() => ratchetAdditions(list([]), "const EXAMPLE_RATCHET = loadExemptions();")).toThrow(
            "literal new Set"
        );
    });

    test("changing any imported ratchet rescans an unchanged offender and rejects growth against the base", () => {
        const dir = mkdtempSync(join(tmpdir(), "lint-ratchet-"));
        const run = (args: string[]) => {
            const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
                cwd: dir,
                encoding: "utf8",
                env: { ...process.env },
            });
            expect(result.status, result.stderr).toBe(0);
            return result.stdout.trim();
        };
        const inputs = [
            "harness-ratchet.ts",
            "model-facts-ratchet.ts",
            "native-home-ratchet.ts",
            "proxy-provider-ratchet.ts",
            "tool-command-ratchet.ts",
            "transcript-format-ratchet.ts",
        ];
        const list = (files: string[]) =>
            `export const EXAMPLE_RATCHET = new Set<string>(${SafeJSON.stringify(files)});`;

        try {
            mkdirSync(join(dir, "scripts/ci"), { recursive: true });
            mkdirSync(join(dir, "src"));
            writeFileSync(join(dir, "src/offender.ts"), 'const id = "claude-opus-5";');

            for (const file of inputs) {
                writeFileSync(join(dir, "scripts/ci", file), list(["src/offender.ts"]));
            }

            run(["init", "-q"]);
            run(["config", "user.name", "Fixture User"]);
            run(["config", "user.email", "fixture@example.com"]);
            run(["add", "--", "src/offender.ts", ...inputs.map((file) => `scripts/ci/${file}`)]);
            run(["commit", "-qm", "base"]);
            const base = run(["rev-parse", "HEAD"]);
            expect(changedFiles(base, { cwd: dir })).toEqual(new Set());

            let previous = base;

            for (const file of inputs) {
                writeFileSync(join(dir, "scripts/ci", file), list([]));
                run(["add", "--", `scripts/ci/${file}`]);
                run(["commit", "-qm", "remove exemption"]);
                expect(changedFiles(previous, { cwd: dir })).toBeNull();
                previous = run(["rev-parse", "HEAD"]);
                const source = readFileSync(join(dir, "src/offender.ts"), "utf8");
                expect(rules(source, "src/offender.ts")).toContain("no-model-id-literal-outside-catalog");
            }

            writeFileSync(join(dir, "scripts/ci/harness-ratchet.ts"), list(["src/offender.ts", "src/new.ts"]));
            run(["add", "--", "scripts/ci/harness-ratchet.ts"]);
            run(["commit", "-qm", "grow exemption"]);
            expect(() => changedFiles(base, { cwd: dir })).toThrow("EXAMPLE_RATCHET: src/new.ts");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 30_000);

    test("every file on a ratchet list still offends its rule, so a migrated file leaves the list", async () => {
        const lists: [string, ReadonlySet<string>][] = [
            ["no-transcript-format-outside-readers", TRANSCRIPT_FORMAT_RATCHET],
            ["no-hand-built-claude-home", NATIVE_HOME_CLAUDE_RATCHET],
            ["no-hand-built-codex-grok-home", NATIVE_HOME_CODEX_GROK_RATCHET],
            ["no-model-id-literal-outside-catalog", MODEL_ID_LITERAL_RATCHET],
            ["no-model-price-table", MODEL_PRICE_TABLE_RATCHET],
            ["no-effort-vocabulary-list", EFFORT_LIST_RATCHET],
            ["no-harness-name-branch", HARNESS_BRANCH_RATCHET],
            ["no-hook-payload-read", HOOK_PAYLOAD_READ_RATCHET],
            ["no-agent-name-in-command-match", AGENT_PROCESS_MATCH_RATCHET],
        ];
        const stale: string[] = [];
        const files = [...new Set(lists.flatMap(([, entries]) => [...entries]))];
        const found = new Map(
            await Promise.all(
                files.map(async (file) => {
                    const source = await Bun.file(file).text();
                    return [
                        file,
                        new Set(checkSource(file, source, { ratchets: false }).map((finding) => finding.rule)),
                    ] as const;
                })
            )
        );

        for (const [rule, entries] of lists) {
            for (const file of entries) {
                if (!found.get(file)?.has(rule)) {
                    stale.push(`${rule}: ${file}`);
                }
            }
        }

        expect(stale).toEqual([]);
    }, 30_000);
});

describe("no-proxy-provider-branch", () => {
    const rule = "no-proxy-provider-branch";

    test("flags a switch case and any comparison against a provider name that only the proxy uses", () => {
        for (const source of [
            'switch (account.provider) { case "openrouter": break; }',
            'const codex = accounts.filter((item) => item.provider !== "openai-subscription");',
            'if (type === "xai-api-key") {}',
            'if (provider.id === "openai") {}',
        ]) {
            expect({ source, flagged: rules(source, "src/ai-proxy/commands/x.ts").includes(rule) }).toEqual({
                source,
                flagged: true,
            });
        }
    });

    test("leaves the shared names alone unless the other side is a provider, and leaves other tools alone", () => {
        expect(rules('if (wire === "openrouter") {}', "src/ai-proxy/lib/x.ts")).not.toContain(rule);
        expect(rules('if (account.provider === "grok-subscription") {}', "src/utils/ai/x.ts")).not.toContain(rule);
    });

    test("a per-file count lets that many findings pass and reports every one of a file that has more", () => {
        const finding = (file: string, line: number, name = rule): Finding => ({
            file,
            line,
            column: 1,
            rule: name,
            severity: "error",
            message: "provider branch",
            text: "x",
        });
        const counts = new Map([[rule, new Map([["src/a.ts", 2]])]]);

        const atCount = withinCountRatchets([finding("src/a.ts", 1), finding("src/a.ts", 2)], counts);
        const overCount = withinCountRatchets(
            [finding("src/a.ts", 1), finding("src/a.ts", 2), finding("src/a.ts", 3)],
            counts
        );
        const unlisted = withinCountRatchets([finding("src/b.ts", 1), finding("src/a.ts", 1, "other-rule")], counts);

        expect([atCount.length, overCount.map((item) => item.line), unlisted.length]).toEqual([0, [1, 2, 3], 2]);
        expect(overCount[0].message).toContain("3 in this file");
    });

    test("an established count list rejects a new file and a higher count, and allows a lower one", () => {
        const list = (entries: [string, number][]) =>
            `export const EXAMPLE_RATCHET = new Map<string, number>(${SafeJSON.stringify(entries)});`;

        expect(
            ratchetAdditions(
                list([["src/a.ts", 2]]),
                list([
                    ["src/a.ts", 3],
                    ["src/b.ts", 1],
                ])
            )
        ).toEqual(["EXAMPLE_RATCHET: src/a.ts (2 → 3)", "EXAMPLE_RATCHET: src/b.ts"]);
        expect(ratchetAdditions(list([["src/a.ts", 2]]), list([["src/a.ts", 1]]))).toEqual([]);
        expect(() => ratchetAdditions(list([]), "export const EXAMPLE_RATCHET = new Map([[name, 1]]);")).toThrow(
            "literal"
        );
    });

    test("the empty proxy provider baseline parses and rejects a new entry", async () => {
        const baseline = await Bun.file("scripts/ci/proxy-provider-ratchet.ts").text();
        const grown = 'export const PROXY_PROVIDER_BRANCH_RATCHET = new Map([["src/new.ts", 1]]);';

        expect(ratchetAdditions(baseline, baseline)).toEqual([]);
        expect(ratchetAdditions(baseline, grown)).toEqual(["PROXY_PROVIDER_BRANCH_RATCHET: src/new.ts"]);
    });

    test("every count on the list is the file's real number of findings, so a fixed branch lowers its count", async () => {
        const stale: string[] = [];

        for (const [file, allowed] of PROXY_PROVIDER_BRANCH_RATCHET) {
            const source = await Bun.file(file).text();
            const found = checkSource(file, source, { ratchets: false }).filter((item) => item.rule === rule).length;

            if (found !== allowed) {
                stale.push(`${file}: listed ${allowed}, found ${found}`);
            }
        }

        expect(stale).toEqual([]);
    });
});

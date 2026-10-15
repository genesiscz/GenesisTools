//
//  WidgetKeymap.swift
//  GenesisKit
//
//  Every key of the agent widget in one library (Keymap/), Martin 2026-10-15. The number row is a position
//  as well as a digit: on a Czech keyboard the key that types "+" still answers choice 1. The coordinator
//  asks this library and keeps its own gates (the agents module, a text field, an open preview).
//

import AppKit

@MainActor
public enum WidgetKeymap {
    /// The keys in force: the library plus the user's own keys (`<keymap folder>/widget.json`).
    public static let shared = Keymap(library: library)

    /// The in-place media preview. Its keys work only while it is open, ahead of the panel's.
    public static let previewScope: KeymapScope = "widget.preview"

    public static let settings = "widget.app.settings"
    public static let hub = "widget.app.hub"
    public static let quit = "widget.app.quit"
    public static let paste = "widget.media.paste"
    public static let collapse = "widget.panel.collapse"
    public static let previous = "widget.message.previous"
    public static let next = "widget.message.next"
    public static let previewClose = "widget.preview.close"
    public static let previewPrevious = "widget.preview.previous"
    public static let previewNext = "widget.preview.next"

    /// The US number row, in order 1 to 9. Key codes 23 and 22 are 5 and 6: the codes are not in numeric order.
    private static let numberRow: [(Int, UInt16)] = [
        (1, 18), (2, 19), (3, 20), (4, 21), (5, 23), (6, 22), (7, 26), (8, 28), (9, 25),
    ]

    public static func choiceID(_ number: Int) -> String { "widget.choice.\(number)" }

    public static let library = KeymapLibrary(id: "widget", title: "Agent Widget", commands: [
        KeymapCommand(settings, "Widget Sessions", group: "App", keys: [.character(",", .command)], scope: .app),
        KeymapCommand(hub, "Open Hub", group: "App", keys: [.character("h", .command)], scope: .app),
        KeymapCommand(quit, "Quit", group: "App", keys: [.character("q", .command)], scope: .app, configurable: false),
        KeymapCommand(paste, "Paste Media", group: "Composer", keys: [
            .character("v", .command),
            .character("v", [.shift, .command]),
            .character("v", [.option, .command]),
            .character("v", [.option, .shift, .command]),
        ]),
        KeymapCommand(collapse, "Collapse", group: "Panel",
                      detail: "Also while a text field has the focus. An open preview takes Esc first.",
                      keys: [.code(53)]),
        KeymapCommand(previous, "Previous Message", group: "Messages", keys: [.character("j")]),
        KeymapCommand(next, "Next Message", group: "Messages", keys: [.character("k")]),
    ] + numberRow.map { number, code in
        KeymapCommand(choiceID(number), "Answer \(number)", group: "Answers",
                      detail: "The digit, or that place on the number row.",
                      keys: [.character("\(number)"), .code(code)])
    } + [
        KeymapCommand(previewClose, "Close Preview", group: "Preview",
                      detail: "Esc also closes it while a text field has the focus. Space does not.",
                      keys: [.code(53), .code(49)], scope: previewScope),
        KeymapCommand(previewPrevious, "Previous Item", group: "Preview", keys: [.code(123)], scope: previewScope),
        KeymapCommand(previewNext, "Next Item", group: "Preview", keys: [.code(124)], scope: previewScope),
    ])

    /// The same key with Shift removed. Command, Control and Option stay on the real stroke: they are a
    /// different shortcut. Shift J still reaches J.
    public static func plainStroke(keyCode: UInt16, characters: String?) -> KeyStroke {
        KeyStroke(keyCode: keyCode, character: characters?.lowercased() ?? "", modifiers: [])
    }

    /// The press that matches in `scopes`, or nil. A press that holds only Shift also tries the key with Shift
    /// removed. Command, Control and Option do not fall back, so a saved ⌘J runs and a plain J does not become it.
    public static func resolvedStroke(_ stroke: KeyStroke, in scopes: Set<KeymapScope>, keymap: Keymap) -> KeyStroke? {
        if !keymap.commands(for: stroke, in: scopes).isEmpty { return stroke }
        guard stroke.modifiers.isDisjoint(with: [.command, .control, .option]) else { return nil }
        let plain = plainStroke(keyCode: stroke.keyCode, characters: stroke.character)
        guard plain != stroke, !keymap.commands(for: plain, in: scopes).isEmpty else { return nil }
        return plain
    }

    /// The command ids `resolvedStroke` matched.
    public static func commandIDs(for stroke: KeyStroke, in scopes: Set<KeymapScope>, keymap: Keymap) -> [String] {
        guard let resolved = resolvedStroke(stroke, in: scopes, keymap: keymap) else { return [] }
        return keymap.commands(for: resolved, in: scopes).map(\.id)
    }

    /// The answer number this press is, 1 to 9, if the panel's keys say so.
    public static func choiceNumber(in ids: [String]) -> Int? {
        for id in ids {
            guard id.hasPrefix("widget.choice."), let suffix = id.split(separator: ".").last,
                  let number = Int(suffix), (1...9).contains(number) else { continue }
            return number
        }
        return nil
    }

    public static func hint(_ title: String, _ id: String) -> String { shared.hint(title, id) }

    public static func label(_ id: String) -> String { shared.label(for: id) ?? "" }

    /// "1–3 answer · J/K switch · ⎋ close", with the keys in force.
    public static var agentFooter: String {
        "\(label(choiceID(1)))–\(label(choiceID(3))) answer · \(label(previous))/\(label(next)) switch · \(label(collapse)) close"
    }

    /// "⌘V media · ⎋ close".
    public static var mediaFooter: String {
        "\(label(paste)) media · \(label(collapse)) close"
    }
}

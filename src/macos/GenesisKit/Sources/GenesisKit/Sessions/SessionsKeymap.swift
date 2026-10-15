//
//  SessionsKeymap.swift
//  GenesisKit
//
//  Keys of the session screen. Previous and Next Prompt are Command on the keys right of P, by position,
//  so they work on a Czech keyboard. A host that uses those keys itself (the hub's Back and Forward,
//  and its Reload) sets `sessionHostOwnsCommandKeys`. The prompts then use Option-Command on the same
//  keys, and Reload stays with the host.
//

import AppKit
import SwiftUI

@MainActor
public enum SessionsKeymap {
    public static let shared = Keymap(library: library)

    public static let find = "sessions.find"
    public static let previousPrompt = "sessions.prompt.previous"
    public static let nextPrompt = "sessions.prompt.next"
    public static let previousPromptAlt = "sessions.prompt.previous.alt"
    public static let nextPromptAlt = "sessions.prompt.next.alt"
    public static let reload = "sessions.reload"

    private static let hostPromptDetail = "Where Command belongs to the host, as in the GenesisTools hub."

    public static let library = KeymapLibrary(id: "sessions", title: "Session", commands: [
        KeymapCommand(find, "Find in Transcript", group: "Transcript",
                      detail: "Focuses the transcript search. Another panel's own find takes Command F first.",
                      keys: [.character("f", .command)]),
        KeymapCommand(previousPrompt, "Previous Prompt", group: "Transcript",
                      keys: [.code(33, .command)]),
        KeymapCommand(previousPromptAlt, "Previous Prompt", group: "Transcript",
                      detail: hostPromptDetail,
                      keys: [.code(33, [.option, .command])]),
        KeymapCommand(nextPrompt, "Next Prompt", group: "Transcript",
                      keys: [.code(30, .command)]),
        KeymapCommand(nextPromptAlt, "Next Prompt", group: "Transcript",
                      detail: hostPromptDetail,
                      keys: [.code(30, [.option, .command])]),
        KeymapCommand(reload, "Reload Session", group: "Transcript",
                      detail: "In the hub, Command R reloads the list instead.",
                      keys: [.character("r", .command)]),
    ])

    public static func hint(_ title: String, _ id: String) -> String { shared.hint(title, id) }
}

private struct SessionHostOwnsCommandKeys: EnvironmentKey {
    static let defaultValue = false
}

public extension EnvironmentValues {
    /// The host takes Command-R and Command on the two keys right of P. The transcript registers
    /// Option-Command there for the prompts, and leaves Reload to the host.
    var sessionHostOwnsCommandKeys: Bool {
        get { self[SessionHostOwnsCommandKeys.self] }
        set { self[SessionHostOwnsCommandKeys.self] = newValue }
    }
}

extension View {
    /// Registers `id`, or Option-Command for a prompt when the host owns Command. Reload stays
    /// unregistered then. The button's own action still runs on a click.
    @ViewBuilder
    func sessionCommand(_ id: String, enabled: Bool = true, hostOwns: Bool, perform: @escaping () -> Void) -> some View {
        if let command = SessionsKeymap.registeredCommand(id, hostOwns: hostOwns) {
            keymapAction(command, in: SessionsKeymap.shared, enabled: enabled, perform: perform)
        } else {
            self
        }
    }
}

extension SessionsKeymap {
    /// Option-Command on the same key. Nil for Reload, which the host keeps.
    static func alt(for id: String) -> String? {
        switch id {
        case previousPrompt: return previousPromptAlt
        case nextPrompt: return nextPromptAlt
        default: return nil
        }
    }

    /// The command the button registers: the Option-Command prompt when the host owns Command, else `id`.
    static func registeredCommand(_ id: String, hostOwns: Bool) -> String? {
        if hostOwns {
            return alt(for: id)
        }
        return id
    }

    /// The tooltip, with the key that is registered. Reload has none when the host owns Command.
    static func tooltip(_ title: String, _ id: String, hostOwns: Bool) -> String {
        guard let command = registeredCommand(id, hostOwns: hostOwns) else { return title }
        return hint(title, command)
    }
}

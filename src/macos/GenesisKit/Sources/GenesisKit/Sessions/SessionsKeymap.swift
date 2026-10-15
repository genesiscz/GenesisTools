//
//  SessionsKeymap.swift
//  GenesisKit
//
//  Keys of the session screen. Previous and Next Prompt are Command on the keys right of P, by position,
//  so they work on a Czech keyboard. A host that uses those keys itself (the hub's Back and Forward,
//  and its Reload) sets `sessionHostOwnsCommandKeys`, and the transcript does not register them.
//

import AppKit
import SwiftUI

@MainActor
public enum SessionsKeymap {
    public static let shared = Keymap(library: library)

    public static let find = "sessions.find"
    public static let previousPrompt = "sessions.prompt.previous"
    public static let nextPrompt = "sessions.prompt.next"
    public static let reload = "sessions.reload"

    public static let library = KeymapLibrary(id: "sessions", title: "Session", commands: [
        KeymapCommand(find, "Find in Transcript", group: "Transcript",
                      detail: "Focuses the transcript search. Another panel's own find takes Command F first.",
                      keys: [.character("f", .command)]),
        KeymapCommand(previousPrompt, "Previous Prompt", group: "Transcript",
                      keys: [.code(33, .command)]),
        KeymapCommand(nextPrompt, "Next Prompt", group: "Transcript",
                      keys: [.code(30, .command)]),
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
    /// The host takes Command-R and Command on the two keys right of P. The transcript does not
    /// register reload or the prompt keys, so those presses stay with the host.
    var sessionHostOwnsCommandKeys: Bool {
        get { self[SessionHostOwnsCommandKeys.self] }
        set { self[SessionHostOwnsCommandKeys.self] = newValue }
    }
}

extension View {
    /// Registers `id` unless the host already owns that key. The button's own action still runs on a click.
    @ViewBuilder
    func sessionCommand(_ id: String, enabled: Bool = true, hostOwns: Bool, perform: @escaping () -> Void) -> some View {
        if hostOwns {
            self
        } else {
            keymapAction(id, in: SessionsKeymap.shared, enabled: enabled, perform: perform)
        }
    }
}

extension SessionsKeymap {
    /// The tooltip. With the host flag set, the button has no key, so the title stands alone.
    static func tooltip(_ title: String, _ id: String, hostOwns: Bool) -> String {
        hostOwns ? title : hint(title, id)
    }
}

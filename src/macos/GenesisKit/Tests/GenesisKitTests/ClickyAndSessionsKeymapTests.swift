import AppKit
@testable import GenesisKit
import SwiftUI
import XCTest

/// Clicky and the session screen (Martin, 2026-10-15).
@MainActor
final class ClickyAndSessionsKeymapTests: XCTestCase {
    private let czech = TableKeyLayout(
        [30: ")", 33: "ú", 18: "+", 19: "ě", 27: "=", 44: "-", 29: "é"],
        shifted: [30: "(", 33: "/", 18: "1", 29: "0"])

    func testClickyAndTheSessionScreenHaveNoConflictOnACzechOrAUSKeyboard() {
        for library in [ClickyKeymap.library, SessionsKeymap.library] {
            XCTAssertEqual(Keymap(library: library, store: nil, layout: czech).conflicts(), [], library.id)
            XCTAssertEqual(Keymap(library: library, store: nil, layout: TableKeyLayout.us).conflicts(), [], library.id)
        }
    }

    /// Command on key 33 is Previous Prompt. The position matches whatever that key types.
    func testCommandOnKey33IsPreviousPrompt() {
        let keys = Keymap(library: SessionsKeymap.library, store: nil, layout: czech)
        let previous = KeyStroke(keyCode: 33, character: "ú", modifiers: .command)
        XCTAssertEqual(keys.commands(for: previous, in: [.window]).map(\.id), [SessionsKeymap.previousPrompt])
        let next = KeyStroke(keyCode: 30, character: ")", modifiers: .command)
        XCTAssertEqual(keys.commands(for: next, in: [.window]).map(\.id), [SessionsKeymap.nextPrompt])
    }

    /// Option-Command on key 33 types "ú" on Czech and matches the alt Previous Prompt.
    func testOptionCommandOnKey33IsTheAltPreviousPrompt() {
        let keys = Keymap(library: SessionsKeymap.library, store: nil, layout: czech)
        let previous = KeyStroke(keyCode: 33, character: "ú", modifiers: [.option, .command])
        XCTAssertEqual(keys.commands(for: previous, in: [.window]).map(\.id), [SessionsKeymap.previousPromptAlt])
    }

    /// Without the host flag the transcript registers Command for the prompts, and Reload.
    /// With the flag it registers Option-Command for the prompts, and not the Command pair or Reload.
    func testTheHostFlagRegistersTheAltPromptKeys() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 200, height: 80), styleMask: [.titled],
                              backing: .buffered, defer: true)
        window.alphaValue = 0
        window.orderBack(nil)
        defer { window.orderOut(nil) }

        func registered(hostOwns: Bool) -> Set<String> {
            window.contentView = NSHostingView(rootView: SessionCommandProbe().environment(\.sessionHostOwnsCommandKeys, hostOwns))
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
            let ids = Set(KeymapDispatcher.shared.registrations.compactMap { entry -> String? in
                guard entry.window === window else { return nil }
                return entry.command
            })
            window.contentView = nil
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
            return ids
        }

        let free = registered(hostOwns: false)
        XCTAssertTrue(free.contains(SessionsKeymap.previousPrompt), "without the flag, Command on key 33 is registered")
        XCTAssertTrue(free.contains(SessionsKeymap.nextPrompt))
        XCTAssertFalse(free.contains(SessionsKeymap.previousPromptAlt))
        XCTAssertFalse(free.contains(SessionsKeymap.nextPromptAlt))
        XCTAssertTrue(free.contains(SessionsKeymap.reload))

        let owned = registered(hostOwns: true)
        XCTAssertTrue(owned.contains(SessionsKeymap.previousPromptAlt), "with the flag, Option-Command on key 33 is registered")
        XCTAssertTrue(owned.contains(SessionsKeymap.nextPromptAlt))
        XCTAssertFalse(owned.contains(SessionsKeymap.previousPrompt))
        XCTAssertFalse(owned.contains(SessionsKeymap.nextPrompt))
        XCTAssertFalse(owned.contains(SessionsKeymap.reload))
    }

    func testTheHostFlagTooltipUsesTheAltKey() {
        XCTAssertEqual(
            SessionsKeymap.tooltip("Previous prompt", SessionsKeymap.previousPrompt, hostOwns: true),
            SessionsKeymap.hint("Previous prompt", SessionsKeymap.previousPromptAlt))
        XCTAssertEqual(
            SessionsKeymap.tooltip("Next prompt", SessionsKeymap.nextPrompt, hostOwns: true),
            SessionsKeymap.hint("Next prompt", SessionsKeymap.nextPromptAlt))
        XCTAssertEqual(
            SessionsKeymap.tooltip("Previous prompt", SessionsKeymap.previousPrompt, hostOwns: false),
            SessionsKeymap.hint("Previous prompt", SessionsKeymap.previousPrompt))
        XCTAssertEqual(
            SessionsKeymap.tooltip("Reload the session and its transcript", SessionsKeymap.reload, hostOwns: true),
            "Reload the session and its transcript")
    }
}

/// Reads the host flag and registers the same way the prompt buttons and Reload do.
private struct SessionCommandProbe: View {
    @Environment(\.sessionHostOwnsCommandKeys) private var hostOwns

    var body: some View {
        Color.clear
            .sessionCommand(SessionsKeymap.previousPrompt, hostOwns: hostOwns) {}
            .sessionCommand(SessionsKeymap.nextPrompt, hostOwns: hostOwns) {}
            .sessionCommand(SessionsKeymap.reload, hostOwns: hostOwns) {}
            .frame(width: 40, height: 40)
    }
}

import AppKit
import SwiftUI

// Back and forward through what the hub showed: every mode switch, session, worktree and PR picked,
// and "Open" from a PR's or a worktree's session list. ⌘[ and ⌘], the arrows above the mode switch,
// the mouse's side buttons and a trackpad swipe all walk the same history (`HubModel.goBack`).

/// One place in the hub: the mode and what it had selected.
struct HubNavEntry: Equatable {
    var mode: HubMode
    /// The session row id, worktree path or PR id the mode shows; nil while nothing is picked yet.
    var selection: String?
}

/// A browser's history: `visit` pushes, `goBack` and `goForward` walk it. Pure, so tests drive it.
struct HubNavHistory: Equatable {
    static let limit = 100

    private(set) var back: [HubNavEntry] = []
    private(set) var current: HubNavEntry?
    private(set) var forward: [HubNavEntry] = []

    var canGoBack: Bool { !back.isEmpty }
    var canGoForward: Bool { !forward.isEmpty }

    /// A new place. A new place after going back drops the forward entries, as a browser does.
    ///
    /// A place with nothing picked (the hub's first moment, a mode whose list still loads) is never
    /// kept: whatever follows replaces it. Otherwise every launch began with a dead "back" to an
    /// empty Sessions mode, and a quick look at a loading mode left a stop with nothing in it.
    mutating func visit(_ entry: HubNavEntry) {
        guard entry != current else { return }
        if let current, current.selection != nil {
            back.append(current)
            if back.count > Self.limit {
                back.removeFirst(back.count - Self.limit)
            }
            forward.removeAll()
        } else if back.last == entry {
            // Out to an empty mode and straight back: the place before it, not a copy of it.
            current = back.popLast()
            return
        }
        current = entry
    }

    mutating func goBack() -> HubNavEntry? {
        guard let previous = back.popLast() else { return nil }
        if let current, current.selection != nil {
            forward.append(current)
        }
        current = previous
        return previous
    }

    mutating func goForward() -> HubNavEntry? {
        guard let next = forward.popLast() else { return nil }
        if let current, current.selection != nil {
            back.append(current)
        }
        current = next
        return next
    }
}

// MARK: - Mouse buttons and swipes

/// The mouse's back and forward buttons (buttons 3 and 4) and a trackpad swipe, in the hub window only.
enum HubNavInput {
    @MainActor private static var monitor: Any?

    @MainActor
    static func install(window: NSWindow, model: HubModel) {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.otherMouseDown, .swipe]) { [weak window, weak model] event in
            guard let model, event.window === window else { return event }
            switch event.type {
            case .otherMouseDown where event.buttonNumber == 3:
                MainActor.assumeIsolated { model.goBack() }
                return nil
            case .otherMouseDown where event.buttonNumber == 4:
                MainActor.assumeIsolated { model.goForward() }
                return nil
            // A swipe event is the trackpad's "swipe between pages" (three fingers, or two or three,
            // in System Settings); a positive deltaX is a swipe to the right, which goes back.
            case .swipe where abs(event.deltaX) > abs(event.deltaY):
                MainActor.assumeIsolated {
                    if event.deltaX > 0 { model.goBack() } else { model.goForward() }
                }
                return nil
            default:
                return event
            }
        }
    }
}

// MARK: - Buttons

/// The back and forward arrows above the mode switch. The tooltip names where each one goes.
struct HubNavButtons: View {
    @ObservedObject var model: HubModel

    var body: some View {
        let history = model.history
        HStack(spacing: 4) {
            arrow("chevron.left", enabled: history.canGoBack,
                  tooltip: history.back.last.map { "Back to \(model.navTitle($0)) (⌘[)" } ?? "Back (⌘[): nothing earlier") {
                model.goBack()
            }
            arrow("chevron.right", enabled: history.canGoForward,
                  tooltip: history.forward.last.map { "Forward to \(model.navTitle($0)) (⌘])" } ?? "Forward (⌘]): nothing later") {
                model.goForward()
            }
        }
    }

    private func arrow(_ symbol: String, enabled: Bool, tooltip: String, action: @escaping () -> Void) -> some View {
        IconButton(systemName: symbol, tooltip: tooltip, size: 12.5, action: action)
            .foregroundColor(enabled ? Color.white.opacity(0.85) : ReviewPalette.dim.opacity(0.45))
            .disabled(!enabled)
    }
}

import AppKit
import SwiftUI

/// Runs commands from key presses. Each dispatcher installs one local key-down monitor when something registers, and
/// that monitor offers the press to this dispatcher's handlers (the key window's own first, then the app-wide ones,
/// each newest first), before any view, the menu or SwiftUI's own shortcuts see it. The monitor is removed when the
/// dispatcher is released. A
/// handler is live while its view is in a window (`.keymapAction`) or while its registration is held (AppKit code).
///
/// A key with no ⌘ and no ⌃ (a bare letter, ⌥ alone, an arrow) never fires while text input has the focus, so typing
/// stays typing. A press no handler takes goes on unchanged, to the menu and the views.
@MainActor
public final class KeymapDispatcher {
    public static let shared = KeymapDispatcher()

    final class Registration {
        let token = UUID()
        weak var keymap: Keymap?
        let command: String
        /// Any window of the app, not one window.
        let anyWindow: Bool
        weak var window: NSWindow?
        let isEnabled: () -> Bool
        let perform: (KeyStroke) -> Void

        init(keymap: Keymap, command: String, window: NSWindow?, isEnabled: @escaping () -> Bool,
             perform: @escaping (KeyStroke) -> Void) {
            self.keymap = keymap
            self.command = command
            anyWindow = window == nil
            self.window = window
            self.isEnabled = isEnabled
            self.perform = perform
        }
    }

    private(set) var registrations: [Registration] = []
    private var keyMonitor: KeyDownMonitor?
    private var suspensions = 0
    /// How many times a live monitor has seen a key. A test checks that releasing a dispatcher stops its monitor.
    static var monitorCallsForTests = 0

    /// A dispatcher of its own, with no key monitor until something registers. Apps use `shared`; a test in another
    /// module makes one so its registrations cannot meet the app's.
    public init() {}

    /// Runs `perform` when the command's key is pressed in `window` (nil: in any window of the app). The newest
    /// registration for a key wins; one whose `isEnabled` says false lets the press go to the next. Hold the returned
    /// registration: it ends when released or cancelled.
    public func register(
        _ command: String, in keymap: Keymap, window: NSWindow?, isEnabled: @escaping () -> Bool = { true },
        perform: @escaping () -> Void
    ) -> KeymapRegistration {
        return register(command, in: keymap, window: window, isEnabled: isEnabled, perform: { (_: KeyStroke) in perform() })
    }

    /// Same as `register`, and `perform` receives the press. A handler that shares a key with another command
    /// (Glass and Previous Match) can tell which chord was pressed.
    public func register(
        _ command: String, in keymap: Keymap, window: NSWindow?, isEnabled: @escaping () -> Bool = { true },
        perform: @escaping (KeyStroke) -> Void
    ) -> KeymapRegistration {
        let registration = Registration(
            keymap: keymap, command: command, window: window, isEnabled: isEnabled, perform: perform)
        registrations.append(registration)
        installMonitor()
        let token = registration.token
        return KeymapRegistration { [weak self] in self?.registrations.removeAll { $0.token == token } }
    }

    /// While a recorder listens, every key goes to it: nothing runs. Balanced by `resume()`.
    public func suspend() { suspensions += 1 }
    public func resume() { suspensions = max(0, suspensions - 1) }
    var suspendedForTests: Bool { suspensions > 0 }

    /// Offers the event to the live handlers. True when one ran (the event is then used up).
    @discardableResult
    public func handle(_ event: NSEvent) -> Bool {
        guard let press = KeyStroke(event) else { return false }
        let window = event.window ?? NSApp.keyWindow
        return handle(press, in: window, typing: Self.isTextInput(window?.firstResponder))
    }

    /// The decision, apart from AppKit's event: `typing` says text input has the focus in `window`.
    func handle(_ press: KeyStroke, in window: NSWindow?, typing: Bool) -> Bool {
        guard suspensions == 0, let window else { return false }
        registrations.removeAll { $0.keymap == nil || (!$0.anyWindow && $0.window == nil) }
        // This window's handlers before the app-wide ones, each newest first.
        let newest = registrations.reversed()
        let live = newest.filter { !$0.anyWindow && $0.window === window } + newest.filter(\.anyWindow)
        for pass in KeyMatchPass.allCases {
            for registration in live {
                guard let keymap = registration.keymap,
                      let chord = keymap.matchingChord(registration.command, press, pass: pass),
                      !(typing && chord.typesText), registration.isEnabled()
                else { continue }
                registration.perform(press)
                return true
            }
        }
        return false
    }

    private func installMonitor() {
        guard keyMonitor == nil else { return }
        keyMonitor = KeyDownMonitor(dispatcher: self)
    }

    /// Text input: a text view or field editor that takes typing, or a web view (whose focused element may be a field).
    static func isTextInput(_ responder: NSResponder?) -> Bool {
        guard let responder else { return false }
        if let textView = responder as? NSTextView { return textView.isEditable }
        if responder is NSText { return true }
        return String(describing: type(of: responder)).hasPrefix("WK")
    }
}

/// The local key-down monitor for one dispatcher. It calls that dispatcher, not the shared one, and removing this
/// holder removes the monitor. A `@MainActor` dispatcher cannot read the monitor token from its own `deinit`.
private final class KeyDownMonitor {
    private var token: Any?

    init(dispatcher: KeymapDispatcher) {
        token = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak dispatcher] event in
            MainActor.assumeIsolated {
                KeymapDispatcher.monitorCallsForTests += 1
                guard let dispatcher else { return event }
                return dispatcher.handle(event) ? nil : event
            }
        }
    }

    deinit {
        let token = token
        let remove: @MainActor () -> Void = {
            if let token { NSEvent.removeMonitor(token) }
        }
        if Thread.isMainThread {
            MainActor.assumeIsolated(remove)
        } else {
            DispatchQueue.main.async { MainActor.assumeIsolated(remove) }
        }
    }
}

/// A held handler of `KeymapDispatcher`. It ends when cancelled or released.
public final class KeymapRegistration {
    private var end: (() -> Void)?

    init(end: @escaping () -> Void) { self.end = end }

    public func cancel() {
        guard let end else { return }
        self.end = nil
        if Thread.isMainThread {
            MainActor.assumeIsolated { end() }
        } else {
            DispatchQueue.main.async { end() }
        }
    }

    deinit { cancel() }
}

// MARK: - SwiftUI

public extension View {
    /// Runs `action` when the command's key is pressed while this view is in the key window. It replaces a hidden
    /// `Button` with `.keyboardShortcut`: the key comes from the keymap, so the user can change it, and it is matched
    /// by position or character as the library says. Where several views on screen claim a command (`ViewThatFits`
    /// keeps every candidate alive), the newest one runs. `enabled: false` lets the key through.
    func keymapAction(
        _ command: String, in keymap: Keymap, enabled: Bool = true, perform action: @escaping () -> Void
    ) -> some View {
        background(KeymapActionAnchor(command: command, keymap: keymap, enabled: enabled, action: action))
    }
}

public extension View {
    /// The command's key in force on a SwiftUI menu item (`Commands`, `MenuBarExtra`), where only
    /// `.keyboardShortcut` shows a key; no key when the user turned it off. SwiftUI runs it by character, so for a key
    /// that must work by position or on another layout, also register the command with `KeymapDispatcher` (which
    /// takes the press first).
    func keymapShortcut(_ command: String, in keymap: Keymap) -> some View {
        keyboardShortcut(keymap.chord(for: command)?.keyboardShortcut)
    }
}

public extension KeyChord {
    /// The chord as SwiftUI names it; nil for a key SwiftUI cannot name (a dead key, keypad Enter).
    @MainActor var keyboardShortcut: KeyboardShortcut? {
        var modifiers: EventModifiers = []
        if self.modifiers.contains(.command) { modifiers.insert(.command) }
        if self.modifiers.contains(.shift) { modifiers.insert(.shift) }
        if self.modifiers.contains(.option) { modifiers.insert(.option) }
        if self.modifiers.contains(.control) { modifiers.insert(.control) }
        let equivalent: KeyEquivalent?
        switch key {
        case .code(36): equivalent = .return
        case .code(53): equivalent = .escape
        case .code(48): equivalent = .tab
        case .code(49): equivalent = .space
        case .code(51): equivalent = .delete
        case .code(117): equivalent = .deleteForward
        case .code(123): equivalent = .leftArrow
        case .code(124): equivalent = .rightArrow
        case .code(125): equivalent = .downArrow
        case .code(126): equivalent = .upArrow
        case .code(115): equivalent = .home
        case .code(119): equivalent = .end
        case .code(116): equivalent = .pageUp
        case .code(121): equivalent = .pageDown
        case .code(76): equivalent = nil
        default: equivalent = menuKeyEquivalent.first.map { (character: Character) in KeyEquivalent(character) }
        }
        return equivalent.map { KeyboardShortcut($0, modifiers: modifiers) }
    }
}

private struct KeymapActionAnchor: NSViewRepresentable {
    let command: String
    let keymap: Keymap
    let enabled: Bool
    let action: () -> Void

    func makeNSView(context: Context) -> KeymapActionAnchorView { KeymapActionAnchorView() }

    func updateNSView(_ view: KeymapActionAnchorView, context: Context) {
        view.configure(command: command, keymap: keymap, enabled: enabled, action: action)
    }

    static func dismantleNSView(_ view: KeymapActionAnchorView, coordinator: ()) { view.end() }
}

/// A zero-size view that holds one `KeymapDispatcher` registration for as long as it is in a window. It takes no
/// clicks and is no accessibility element.
final class KeymapActionAnchorView: NSView {
    private var command = ""
    private weak var keymap: Keymap?
    private var enabled = true
    private var action: () -> Void = {}
    private var registration: KeymapRegistration?

    func configure(command: String, keymap: Keymap, enabled: Bool, action: @escaping () -> Void) {
        let moved = command != self.command || keymap !== self.keymap
        self.command = command
        self.keymap = keymap
        self.enabled = enabled
        self.action = action
        if moved || registration == nil { register() }
    }

    func end() {
        registration?.cancel()
        registration = nil
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        register()
    }

    private func register() {
        end()
        guard let window, let keymap, !command.isEmpty else { return }
        registration = KeymapDispatcher.shared.register(
            command, in: keymap, window: window, isEnabled: { [weak self] in self?.enabled ?? false },
            perform: { [weak self] in self?.action() })
    }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func isAccessibilityElement() -> Bool { false }
}

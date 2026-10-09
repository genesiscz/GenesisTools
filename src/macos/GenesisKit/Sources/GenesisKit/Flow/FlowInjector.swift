// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Flow/FlowInjector.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import AppKit
import ApplicationServices
import Carbon.HIToolbox
import os.log


// MARK: - Focus target

/// The app that was frontmost when dictation started.
///
/// Captured BEFORE any Flow UI appears. This is the single non-obvious
/// requirement of a dictation tool: the moment your own window or panel shows,
/// the user's text field is no longer frontmost, so "paste into the focused
/// app" pastes into you. BridgeVoice solves it the same way
/// (`injection::macos::save_foreground_window` → `SavedFocusTarget`).
///
/// The pill is a non-activating panel, so in the common case focus never
/// actually moves — but the main Genesis window being open, or the user
/// clicking the pill, both break that assumption. Capturing costs nothing.
public struct FlowFocusTarget: Codable, Equatable {
    public let bundleIdentifier: String?
    public let localizedName: String?
    public let processIdentifier: pid_t

    /// Snapshot the current frontmost application.
    public static func capture() -> FlowFocusTarget? {
        guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
        // Never target ourselves: if Genesis is frontmost the user is looking
        // at our own window, and pasting into it is virtually never what they
        // meant. Returning nil makes the turn transcribe-only.
        guard app.processIdentifier != ProcessInfo.processInfo.processIdentifier else { return nil }
        return FlowFocusTarget(
            bundleIdentifier: app.bundleIdentifier,
            localizedName: app.localizedName,
            processIdentifier: app.processIdentifier
        )
    }

    /// Bring this app back to the front. Returns false when it has quit.
    @discardableResult
    public func reactivate() -> Bool {
        guard let app = NSRunningApplication(processIdentifier: processIdentifier) else {
            return false
        }
        guard !app.isTerminated, bundleIdentifier == nil || app.bundleIdentifier == bundleIdentifier else { return false }
        if app.isActive { return true }
        return app.activate(options: [])
    }
}

// MARK: - Outcome

public enum FlowInjectOutcome: Equatable {
    case injected
    /// Nothing to paste.
    case empty
    /// The app we captured is gone.
    case targetLost
    /// Accessibility permission is not granted, so we cannot synthesise ⌘V.
    case notPermitted
    /// Text was placed on the clipboard but the paste keystroke was not sent.
    case copiedOnly
    /// The target was not frontmost when the paste was due (slow activation, or focus moved), so the
    /// keystroke was withheld and the text stays on the clipboard.
    case focusMoved
    /// Something else was copied during the activation wait, so ⌘V would have pasted that instead of the
    /// transcript; the keystroke was withheld.
    case clipboardChanged
}

// MARK: - Injector

/// Puts transcribed text into the app the user was actually using.
///
/// Mechanism (same shape BridgeVoice ships): write the pasteboard, re-activate
/// the saved target, then post a synthetic ⌘V via `CGEvent`. Accessibility
/// permission is required for the keystroke; without it we still copy, and say
/// so, rather than silently doing nothing.
@MainActor
public enum FlowInjector {

    /// Is the app trusted for Accessibility right now? Does not prompt.
    public static var isAccessibilityTrusted: Bool {
        AXIsProcessTrusted()
    }

    /// Ask macOS to show the Accessibility prompt. Safe to call repeatedly;
    /// macOS only shows the dialog once per app version.
    public static func requestAccessibility() {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
    }

    public static func openAccessibilitySettings() {
        let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!
        NSWorkspace.shared.open(url)
    }

    /// Deliver `text` to `target`.
    ///
    /// - Parameters:
    ///   - restoreClipboard: put the previous pasteboard contents back after
    ///     pasting. **Default caller passes false.** Restoring re-exposes
    ///     whatever was there — commonly a password or a 2FA code — to any app
    ///     that polls the pasteboard on a delay, which is why BridgeVoice
    ///     removed the same behaviour in 2.5.0.
    /// Returns once the paste was sent or withheld, so the outcome says what actually happened.
    @discardableResult
    public static func inject(
        _ text: String,
        into target: FlowFocusTarget?,
        usePaste: Bool,
        restoreClipboard: Bool
    ) async -> FlowInjectOutcome {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .empty }

        let pasteboard = NSPasteboard.general
        let previous = restoreClipboard ? pasteboard.string(forType: .string) : nil

        pasteboard.clearContents()
        pasteboard.setString(trimmed, forType: .string)
        // Ask clipboard managers not to log this. Dictated text is often more
        // sensitive than what people type, and a history app quietly keeping
        // every transcript is a leak the user never opted into. Wispr Flow does
        // this on macOS and openly does NOT on Windows; there is no reason to
        // ship the weaker behaviour.
        pasteboard.setString("", forType: .init("org.nspasteboard.ConcealedType"))

        guard usePaste else { return .copiedOnly }

        guard let target else {
            FlowFocusLog.flow.info("inject: no saved target, left text on the clipboard")
            return .copiedOnly
        }

        guard target.reactivate() else {
            FlowFocusLog.flow.info("inject: target pid=\(target.processIdentifier) is gone, left text on the clipboard")
            return .targetLost
        }

        guard isAccessibilityTrusted else {
            FlowFocusLog.flow.error("inject: Accessibility not granted — copied only")
            return .notPermitted
        }

        let written = pasteboard.changeCount
        let outcome = await pasteAfterActivation(target: target.processIdentifier, written: written)
        guard outcome == .injected, let previous else { return outcome }
        // Restore only after the paste has had time to read the pasteboard.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
            let pasteboard = NSPasteboard.general
            // Something the user copied after the transcript is newer than both; keep it.
            guard pasteboard.changeCount == written else { return }
            pasteboard.clearContents()
            pasteboard.setString(previous, forType: .string)
        }
        return outcome
    }

    // MARK: - Keystroke

    /// Activation is asynchronous: ⌘V posted in the same run-loop turn races the app becoming frontmost and the
    /// keystroke lands nowhere, so this waits a short hop first. Frontmost is checked at the last moment before the
    /// keystroke: if activation was slow or focus moved, ⌘V would paste the transcript into another app, so the
    /// text stays on the clipboard and the outcome says so. The pasteboard must still be the one this turn wrote
    /// (`written`, its change count): a copy made during the wait would otherwise be pasted in its place.
    static func pasteAfterActivation(
        target: pid_t,
        written: Int,
        changeCount: (() -> Int)? = nil,
        frontmost: (() -> pid_t?)? = nil,
        paste: (() -> Void)? = nil
    ) async -> FlowInjectOutcome {
        try? await Task.sleep(nanoseconds: 80_000_000)
        guard !Task.isCancelled else { return .copiedOnly }
        let current = frontmost.map { $0() } ?? NSWorkspace.shared.frontmostApplication?.processIdentifier
        guard current == target else {
            FlowFocusLog.flow.info("inject: pid=\(target) is not frontmost at paste time (frontmost \(current ?? -1)); left text on the clipboard")
            return .focusMoved
        }
        let count = changeCount.map { $0() } ?? NSPasteboard.general.changeCount
        guard count == written else {
            FlowFocusLog.flow.info("inject: the clipboard changed during the activation wait; paste withheld")
            return .clipboardChanged
        }
        if let paste { paste() } else { postCommandV() }
        return .injected
    }

    /// Synthesise ⌘V on the HID tap.
    ///
    /// `.cghidEventTap` and not a session tap: the same lesson the companion
    /// hotkey learned in reverse — HID-level posting is what other apps
    /// reliably observe, and Carbon-registered hotkeys only ever see HID.
    private static func postCommandV() {
        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            FlowFocusLog.flow.error("inject: could not create a CGEventSource")
            return
        }
        // Suppress our own synthetic keys from re-entering local monitors.
        source.setLocalEventsFilterDuringSuppressionState(
            [.permitLocalMouseEvents, .permitSystemDefinedEvents],
            state: .eventSuppressionStateSuppressionInterval
        )

        let v = CGKeyCode(kVK_ANSI_V)
        guard
            let down = CGEvent(keyboardEventSource: source, virtualKey: v, keyDown: true),
            let up = CGEvent(keyboardEventSource: source, virtualKey: v, keyDown: false)
        else {
            FlowFocusLog.flow.error("inject: could not create the paste key events")
            return
        }
        down.flags = .maskCommand
        up.flags = .maskCommand
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }
}

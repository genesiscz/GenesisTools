import AppKit
import CoreGraphics

/// macOS "Move focus to next window" (Keyboard Shortcuts, symbolic hotkey 27: ⌘` by default, ⌥⇥ on
/// Martin's Mac) across every GenesisTools window. AppKit maps the key event to that hotkey in the
/// frontmost process and calls `-[NSWindow _cycleWindows:]` on its key window (AppKit's
/// `_NSKeyboardUIHandleSymbolicHotKey`, read from its disassembly on macOS 26.3, 2026-10-19), so it
/// only ever reaches the windows of that one process. The faces are separate processes (the hub,
/// the review windows, the settings and permissions windows, the markdown viewer), and only the hub
/// owns the Dock tile (App/DockTile.swift), so the shortcut never left the window it started in.
///
/// Each window face installs this. Its local key monitor catches the user's own binding of hotkey 27
/// (Shift reverses it, as in AppKit) before AppKit does, picks the next GenesisTools window in a fixed
/// order (WindowServer window numbers, ascending, so repeated presses visit every window rather than
/// toggling two), and raises it: itself when the window is its own, else by handing activation to
/// the face that owns it and asking it, through a distributed notification, to raise that window.
/// The processes and the single Dock tile stay as they are. With the shortcut turned off in System
/// Settings, nothing is caught.
@MainActor
package enum WindowCycle {
    package struct Shortcut: Equatable {
        package let keyCode: UInt16
        package let modifiers: NSEvent.ModifierFlags

        /// macOS's default when the user never changed it: ⌘` (kVK_ANSI_Grave).
        package static let standard = Shortcut(keyCode: 50, modifiers: .command)
    }

    package struct Candidate: Equatable {
        package let pid: pid_t
        package let number: Int
    }

    private static let raiseName = Notification.Name("com.genesiscz.genesistools.windowCycle.raise")
    private static let relevant: NSEvent.ModifierFlags = [.command, .option, .control, .shift]
    private static var monitor: Any?
    private static var observer: NSObjectProtocol?

    /// Once per window face, after `NSApplication.shared` exists. A snapshot or bench run may skip it.
    package static func install() {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            nonisolated(unsafe) let key = event
            return MainActor.assumeIsolated { handle(key) } ? nil : event
        }
        observer = DistributedNotificationCenter.default().addObserver(forName: raiseName, object: nil, queue: .main) { note in
            guard let pid = note.userInfo?["pid"] as? Int, pid == Int(getpid()),
                  let number = note.userInfo?["window"] as? Int else { return }
            MainActor.assumeIsolated { raise(number, reason: "asked by another face") }
        }
    }

    /// Hotkey 27 as the user set it (`com.apple.symbolichotkeys`); nil when it is turned off.
    package static func shortcut(from hotkeys: [String: Any]?) -> Shortcut? {
        guard let entry = hotkeys?["27"] as? [String: Any] else { return .standard }
        if let enabled = entry["enabled"] as? Bool, !enabled { return nil }
        guard let value = entry["value"] as? [String: Any], let parameters = value["parameters"] as? [Int],
              parameters.count >= 3, let keyCode = UInt16(exactly: parameters[1]), parameters[2] >= 0 else { return .standard }
        return Shortcut(keyCode: keyCode, modifiers: NSEvent.ModifierFlags(rawValue: UInt(parameters[2])).intersection(relevant))
    }

    /// Forward, backward (the binding plus Shift), or nil when the event is not the shortcut.
    package static func direction(keyCode: UInt16, modifiers: NSEvent.ModifierFlags, shortcut: Shortcut) -> Bool? {
        guard keyCode == shortcut.keyCode else { return nil }
        let pressed = modifiers.intersection(relevant)
        if pressed == shortcut.modifiers { return false }
        if !shortcut.modifiers.contains(.shift), pressed == shortcut.modifiers.union(.shift) { return true }
        return nil
    }

    /// The windows a press may move to: normal-level, visible, of a real size, owned by `pids`. A
    /// snapshot window (alpha 0), a panel above the normal level and a tooltip-sized helper are left out.
    package static func candidates(_ windows: [[String: Any]], pids: Set<pid_t>) -> [Candidate] {
        windows.compactMap { info in
            guard let owner = info[kCGWindowOwnerPID as String] as? Int, pids.contains(pid_t(owner)),
                  (info[kCGWindowLayer as String] as? Int) == 0,
                  let number = info[kCGWindowNumber as String] as? Int else { return nil }
            if let alpha = info[kCGWindowAlpha as String] as? Double, alpha < 0.05 { return nil }
            if let bounds = info[kCGWindowBounds as String] as? NSDictionary,
               let rect = CGRect(dictionaryRepresentation: bounds), rect.width < 160 || rect.height < 100 {
                return nil
            }
            return Candidate(pid: pid_t(owner), number: number)
        }
    }

    /// The window after `current` in ascending window-number order (before it when `backwards`),
    /// wrapping around; nil when no other window is there.
    package static func next(after current: Int, in candidates: [Candidate], backwards: Bool) -> Candidate? {
        let others = candidates.filter { $0.number != current }.sorted { $0.number < $1.number }
        guard !others.isEmpty else { return nil }
        if backwards {
            return others.last { $0.number < current } ?? others.last
        }
        return others.first { $0.number > current } ?? others.first
    }

    private static func handle(_ event: NSEvent) -> Bool {
        // Plain typing never reads the preferences; a binding without ⌘, ⌥ or ⌃ is left to AppKit.
        guard !event.modifierFlags.intersection([.command, .option, .control]).isEmpty else { return false }
        let hotkeys = UserDefaults(suiteName: "com.apple.symbolichotkeys")?.dictionary(forKey: "AppleSymbolicHotKeys")
        guard let shortcut = shortcut(from: hotkeys),
              let backwards = direction(keyCode: event.keyCode, modifiers: event.modifierFlags, shortcut: shortcut),
              let key = NSApp.keyWindow else { return false }
        let pids = Set(NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "")
            .map(\.processIdentifier)).union([getpid()])
        let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        guard let target = next(after: key.windowNumber, in: candidates(list, pids: pids), backwards: backwards) else {
            // One window only: AppKit's own cycle has nothing to do either.
            return false
        }
        HubPerf.log("windowCycle: \(backwards ? "back" : "next") from window \(key.windowNumber) to window \(target.number) of pid \(target.pid)")
        if target.pid == getpid() {
            raise(target.number, reason: "own window")
            return true
        }
        guard let app = NSRunningApplication(processIdentifier: target.pid) else { return false }
        // The owner orders its window front; this face, active now, hands it the activation. A yield alone
        // left the other face behind on about half the presses (five presses on one pair, 2026-10-19 18:46).
        DistributedNotificationCenter.default().postNotificationName(
            raiseName, object: nil, userInfo: ["pid": Int(target.pid), "window": target.number], deliverImmediately: true)
        NSApp.yieldActivation(to: app)
        if !app.activate(from: NSRunningApplication.current, options: []) {
            HubPerf.log("windowCycle: macOS refused to activate pid \(target.pid)")
        }
        return true
    }

    private static func raise(_ number: Int, reason: String) {
        guard let window = NSApp.window(withWindowNumber: number) else {
            HubPerf.log("windowCycle: window \(number) is gone (\(reason))")
            return
        }
        let shown = window.sheetParent ?? window
        if shown.isMiniaturized {
            shown.deminiaturize(nil)
        }
        shown.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }
}

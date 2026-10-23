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
/// (Shift reverses it, as in AppKit) before AppKit does and raises the next GenesisTools window:
/// itself when the window is its own, else by handing activation to the face that owns it and asking
/// it, through a distributed notification, to raise that window.
///
/// The order is the one Cmd+Tab uses (Martin, 2026-10-19: "the order it was last switched to"). Every
/// face broadcasts each window that becomes key, so every face keeps the same most-recently-used
/// list. The first press freezes that list, each press while the modifier stays held steps through
/// it, and the release puts the landed window first. So one press and a release goes back to the
/// previous window, and a held modifier reaches every window, where a live list would toggle two.
/// The frozen list travels with the raise request, because the next press arrives in the face that
/// owns the landed window.
///
/// Cmd+Tab knows only the Dock-tile owner (the review and settings faces are `.accessory`), so
/// Cmd+Tab back to GenesisTools activates the hub. When the tile owner becomes active by Cmd+Tab
/// (the last input was a modifier release, not a click or a typed key), it hands activation on to
/// the window that was key when GenesisTools lost the front.
///
/// The processes and the single Dock tile stay as they are. With the shortcut turned off in System
/// Settings, no key is caught.
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

    /// One run of presses while the modifier stays held: the list frozen at the first press and the
    /// window the last press landed on.
    package struct Session: Equatable {
        package let order: [Candidate]
        package let index: Int
        /// The modifiers whose release ends the run.
        package let modifiers: NSEvent.ModifierFlags

        package var landed: Candidate { order[index] }

        /// The first press: `order` starts with the key window. Nil when no other window is there.
        package static func start(_ order: [Candidate], backwards: Bool, modifiers: NSEvent.ModifierFlags) -> Session? {
            guard order.count > 1 else { return nil }
            return Session(order: order, index: backwards ? order.count - 1 : 1, modifiers: modifiers)
        }

        package func step(backwards: Bool) -> Session {
            Session(order: order, index: (index + (backwards ? order.count - 1 : 1)) % order.count, modifiers: modifiers)
        }
    }

    private static let raiseName = Notification.Name("com.genesiscz.genesistools.windowCycle.raise")
    private static let focusName = Notification.Name("com.genesiscz.genesistools.windowCycle.focused")
    private static let relevant: NSEvent.ModifierFlags = [.command, .option, .control, .shift]
    private static let recentLimit = 64
    private static var installed = false
    private static var tokens: [Any] = []
    /// Most recently focused first, over every face.
    private static var recent: [Candidate] = []
    private static var session: Session?
    /// The window this face raised for a run of presses: its focus is not a choice, so it does not move the list.
    private static var cycleRaise: Int?
    private static var lastCycleRaise = Date.distantPast
    /// `recent` as it was when another app took the front; the tile owner reads it on Cmd+Tab back.
    private static var leftFrom: [Candidate]?

    /// Once per window face, after `NSApplication.shared` exists. A snapshot or bench run may skip it.
    package static func install() {
        guard !installed else { return }
        installed = true
        recent = currentCandidates()
        let keys = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            nonisolated(unsafe) let key = event
            return MainActor.assumeIsolated { handle(key) } ? nil : event
        }
        let flags = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { event in
            let modifiers = event.modifierFlags
            MainActor.assumeIsolated { released(modifiers) }
            return event
        }
        tokens += [keys, flags].compactMap { $0 }
        let distributed = DistributedNotificationCenter.default()
        tokens.append(distributed.addObserver(forName: raiseName, object: nil, queue: .main) { note in
            nonisolated(unsafe) let info = note.userInfo
            MainActor.assumeIsolated { raiseRequested(info) }
        })
        tokens.append(distributed.addObserver(forName: focusName, object: nil, queue: .main) { note in
            guard let window = focusedWindow(note.userInfo, own: getpid()) else { return }
            MainActor.assumeIsolated {
                recent = promote(window, in: recent)
                // A window of another face took focus: GenesisTools is in use, so a Cmd+Tab back is not pending.
                leftFrom = nil
            }
        })
        tokens.append(NotificationCenter.default.addObserver(forName: NSWindow.didBecomeKeyNotification, object: nil, queue: .main) { note in
            guard let window = note.object as? NSWindow else { return }
            let number = window.windowNumber
            MainActor.assumeIsolated { becameKey(number) }
        })
        tokens.append(NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
            let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            let ours = app?.bundleIdentifier == Bundle.main.bundleIdentifier
            MainActor.assumeIsolated {
                if !ours { leftFrom = recent }
            }
        })
        tokens.append(NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { becameActive() }
        })
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

    /// The windows a press may move to, front to back: normal-level, visible, of a real size, owned by
    /// `pids`. A snapshot window (alpha 0), a panel above the normal level and a tooltip-sized helper are left out.
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

    /// `window` first, then the rest of `recent` without it.
    package static func promote(_ window: Candidate, in recent: [Candidate]) -> [Candidate] {
        Array(([window] + recent.filter { $0.number != window.number }).prefix(recentLimit))
    }

    /// The list a first press freezes: the key window, then the windows on screen in the order they were
    /// last focused, then any window never seen focused, front to back.
    package static func order(_ candidates: [Candidate], recent: [Candidate], key: Candidate) -> [Candidate] {
        let known = recent.filter { item in candidates.contains { $0.number == item.number } }
        let unseen = candidates.filter { item in !known.contains { $0.number == item.number } }
        return [key] + (known + unseen).filter { $0.number != key.number }
    }

    /// The window to show on Cmd+Tab back: the first window of `leftFrom` still on screen, when it is not
    /// the tile owner's own (AppKit already brought those forward).
    package static func restoreTarget(_ leftFrom: [Candidate], candidates: [Candidate], own: pid_t) -> Candidate? {
        guard let window = leftFrom.first(where: { item in candidates.contains { $0.number == item.number } }),
              window.pid != own else { return nil }
        return window
    }

    /// Cmd+Tab activates on the release of ⌘, so a modifier change is the newest input. A click (the Dock,
    /// a window, a notification, a link in a browser) or a typed key (a launcher, a terminal) is newer otherwise.
    package static func cameByCommandTab(sinceFlags: Double, sinceMouse: Double, sinceKey: Double) -> Bool {
        sinceFlags < 1 && sinceFlags < sinceMouse && sinceFlags < sinceKey
    }

    private static func handle(_ event: NSEvent) -> Bool {
        // Plain typing never reads the preferences; a binding without ⌘, ⌥ or ⌃ is left to AppKit.
        guard !event.modifierFlags.intersection([.command, .option, .control]).isEmpty else { return false }
        let hotkeys = UserDefaults(suiteName: "com.apple.symbolichotkeys")?.dictionary(forKey: "AppleSymbolicHotKeys")
        guard let shortcut = shortcut(from: hotkeys),
              let backwards = direction(keyCode: event.keyCode, modifiers: event.modifierFlags, shortcut: shortcut),
              let key = NSApp.keyWindow else { return false }
        let list = currentCandidates()
        var next: Session
        if let current = session, current.landed.number == key.windowNumber {
            next = current.step(backwards: backwards)
        } else {
            let frozen = order(list, recent: recent, key: Candidate(pid: getpid(), number: key.windowNumber))
            // One window only: AppKit's own cycle has nothing to do either.
            guard let first = Session.start(frozen, backwards: backwards, modifiers: shortcut.modifiers) else { return false }
            next = first
        }
        // A window closed during the run: step over it.
        var skipped = 0
        while skipped < next.order.count, !list.contains(where: { $0.number == next.landed.number }) {
            next = next.step(backwards: backwards)
            skipped += 1
        }
        HubPerf.log("windowCycle: \(backwards ? "back" : "next") from window \(key.windowNumber) to window \(next.landed.number) of pid \(next.landed.pid) (\(next.index + 1) of \(next.order.count))")
        go(to: next)
        return true
    }

    private static func go(to next: Session) {
        lastCycleRaise = Date()
        if next.landed.pid == getpid() {
            session = next
            raise(next.landed.number, reason: "own window", cycling: true)
            return
        }
        session = nil
        handOff(to: next.landed, session: next)
    }

    /// Asks the face that owns `window` to raise it, then gives it the activation. The owner orders its
    /// window front; this face, active now, hands it the activation. A yield alone left the other face
    /// behind on about half the presses (five presses on one pair, 2026-10-19 18:46).
    private static func handOff(to window: Candidate, session: Session?) {
        guard let app = NSRunningApplication(processIdentifier: window.pid) else { return }
        var info: [String: Any] = ["pid": Int(window.pid), "window": window.number]
        if let session {
            info["order"] = session.order.flatMap { [Int($0.pid), $0.number] }
            info["index"] = session.index
            info["modifiers"] = Int(session.modifiers.rawValue)
        }
        DistributedNotificationCenter.default().postNotificationName(raiseName, object: nil, userInfo: info, deliverImmediately: true)
        NSApp.yieldActivation(to: app)
        if !app.activate(from: NSRunningApplication.current, options: []) {
            HubPerf.log("windowCycle: macOS refused to activate pid \(window.pid)")
        }
    }

    private static func raiseRequested(_ info: [AnyHashable: Any]?) {
        guard let pid = info?["pid"] as? Int, pid == Int(getpid()), let number = info?["window"] as? Int else { return }
        lastCycleRaise = Date()
        leftFrom = nil
        guard let requested = requestedSession(info, pid: getpid(), window: number) else {
            raise(number, reason: "asked by another face", cycling: false)
            return
        }
        // The modifier went up while the activation was on its way: this face never sees that release.
        let held = NSEvent.ModifierFlags(rawValue: UInt(CGEventSource.flagsState(.combinedSessionState).rawValue))
        guard held.contains(requested.modifiers) else {
            session = nil
            raise(number, reason: "asked by another face, run ended", cycling: false)
            return
        }
        session = requested
        raise(number, reason: "asked by another face", cycling: true)
    }

    /// The run a raise request carries: pairs of pid and window number, the index of the landed window, which must
    /// be `window` of `pid`, and the modifiers whose release ends the run. Any process may post the notification, so
    /// a payload that does not fit (a negative index, a pid outside `pid_t`, no modifier) is nil, a plain raise.
    package static func requestedSession(_ info: [AnyHashable: Any]?, pid: pid_t, window: Int) -> Session? {
        guard let flat = info?["order"] as? [Int], !flat.isEmpty, flat.count.isMultiple(of: 2),
              let index = info?["index"] as? Int, (0..<(flat.count / 2)).contains(index),
              let raw = info?["modifiers"] as? Int, let bits = UInt(exactly: raw) else { return nil }
        var order: [Candidate] = []
        for at in stride(from: 0, to: flat.count, by: 2) {
            guard let owner = pid_t(exactly: flat[at]) else { return nil }
            order.append(Candidate(pid: owner, number: flat[at + 1]))
        }
        let modifiers = NSEvent.ModifierFlags(rawValue: bits).intersection(relevant)
        guard !modifiers.isEmpty, order[index] == Candidate(pid: pid, number: window) else { return nil }
        return Session(order: order, index: index, modifiers: modifiers)
    }

    /// The window a focus broadcast names, when it is another face's and its pid fits `pid_t`.
    nonisolated package static func focusedWindow(_ info: [AnyHashable: Any]?, own: pid_t) -> Candidate? {
        guard let raw = info?["pid"] as? Int, let pid = pid_t(exactly: raw), pid != own,
              let number = info?["window"] as? Int else { return nil }
        return Candidate(pid: pid, number: number)
    }

    /// The modifier of a run went up: the landed window becomes the most recent one everywhere.
    private static func released(_ modifiers: NSEvent.ModifierFlags) {
        guard let current = session, !modifiers.intersection(relevant).contains(current.modifiers) else { return }
        session = nil
        noteFocus(current.landed)
    }

    private static func becameKey(_ number: Int) {
        if cycleRaise == number {
            cycleRaise = nil
            return
        }
        noteFocus(Candidate(pid: getpid(), number: number))
    }

    private static func noteFocus(_ window: Candidate) {
        recent = promote(window, in: recent)
        DistributedNotificationCenter.default().postNotificationName(
            focusName, object: nil, userInfo: ["pid": Int(window.pid), "window": window.number], deliverImmediately: true)
    }

    /// The tile owner came to the front. On Cmd+Tab back, show the window that was key when GenesisTools left.
    private static func becameActive() {
        guard let left = leftFrom else { return }
        leftFrom = nil
        guard NSApp.activationPolicy() == .regular, Date().timeIntervalSince(lastCycleRaise) > 1.5 else { return }
        let since = { (type: CGEventType) in CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: type) }
        let mouse = min(since(.leftMouseDown), since(.rightMouseDown), since(.otherMouseDown))
        guard cameByCommandTab(sinceFlags: since(.flagsChanged), sinceMouse: mouse, sinceKey: since(.keyDown)),
              let target = restoreTarget(left, candidates: currentCandidates(), own: getpid()) else { return }
        HubPerf.log("windowCycle: Cmd+Tab back, showing window \(target.number) of pid \(target.pid)")
        handOff(to: target, session: nil)
    }

    private static func currentCandidates() -> [Candidate] {
        let pids = Set(NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "")
            .map(\.processIdentifier)).union([getpid()])
        let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        return candidates(list, pids: pids)
    }

    private static func raise(_ number: Int, reason: String, cycling: Bool) {
        guard let window = NSApp.window(withWindowNumber: number) else {
            HubPerf.log("windowCycle: window \(number) is gone (\(reason))")
            return
        }
        let shown = window.sheetParent ?? window
        cycleRaise = cycling ? shown.windowNumber : nil
        if shown.isMiniaturized {
            shown.deminiaturize(nil)
        }
        shown.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }
}

import AppKit

/// The Meetings face's menu bar. Without one the window had no Close (⌘W), Minimize (⌘M) or Quit (⌘Q), and its text
/// fields (the filter, a rename, a label, a typed answer) took no ⌘C, ⌘V, ⌘A or ⌘Z: AppKit sends those keys to the
/// field only through an Edit menu.
@MainActor
enum MeetingsMenu {
    /// Every item of the bar with its key, so a test can check the bar without installing it.
    static func build(appName: String = "GenesisTools") -> NSMenu {
        let bar = NSMenu()
        let target = MeetingsMenuTarget.shared

        let app = NSMenu(title: appName)
        app.addItem(withTitle: "About \(appName)", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        let settings = app.addItem(withTitle: "Meetings Settings…", action: #selector(MeetingsMenuTarget.openSettings(_:)), keyEquivalent: ",")
        settings.target = target
        app.addItem(.separator())
        app.addItem(withTitle: "Hide \(appName)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(withTitle: "Quit Meetings", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        bar.addItem(withTitle: appName, action: nil, keyEquivalent: "").submenu = app

        let file = NSMenu(title: "File")
        let newWindow = file.addItem(withTitle: "Open Meeting in New Window", action: #selector(MeetingsMenuTarget.openInNewWindow(_:)), keyEquivalent: "N")
        newWindow.target = target
        let duplicate = file.addItem(withTitle: "Duplicate Meeting", action: #selector(MeetingsMenuTarget.duplicateMeeting(_:)), keyEquivalent: "d")
        duplicate.target = target
        let rename = file.addItem(withTitle: "Rename Meeting…", action: #selector(MeetingsMenuTarget.renameMeeting(_:)), keyEquivalent: "")
        rename.target = target
        file.addItem(.separator())
        file.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        bar.addItem(withTitle: "File", action: nil, keyEquivalent: "").submenu = file

        bar.addItem(StandardEditing.menuItem())

        let view = NSMenu(title: "View")
        let needs = view.addItem(withTitle: "Needs You", action: #selector(MeetingsMenuTarget.showNeeds(_:)), keyEquivalent: "1")
        needs.target = target
        let all = view.addItem(withTitle: "All Meetings", action: #selector(MeetingsMenuTarget.showAll(_:)), keyEquivalent: "2")
        all.target = target
        let contacts = view.addItem(withTitle: "People", action: #selector(MeetingsMenuTarget.showContacts(_:)), keyEquivalent: "3")
        contacts.target = target
        view.addItem(.separator())
        // The toolbar's toggle answers ⌥⌘I too; the item names what a press does (validateMenuItem).
        let panel = view.addItem(withTitle: "Show Settings Panel", action: #selector(MeetingsMenuTarget.toggleSidePanel(_:)), keyEquivalent: "i")
        panel.keyEquivalentModifierMask = [.command, .option]
        panel.target = target
        view.addItem(.separator())
        let reload = view.addItem(withTitle: "Reload", action: #selector(MeetingsMenuTarget.reload(_:)), keyEquivalent: "r")
        reload.target = target
        // The dock's timeline (G-KEY-1): a view change only, the sound goes on (R4).
        view.addItem(.separator())
        let zoomIn = view.addItem(withTitle: "Zoom In on the Timeline", action: #selector(MeetingsMenuTarget.zoomIn(_:)), keyEquivalent: "+")
        zoomIn.target = target
        let zoomOut = view.addItem(withTitle: "Zoom Out on the Timeline", action: #selector(MeetingsMenuTarget.zoomOut(_:)), keyEquivalent: "-")
        zoomOut.target = target
        let fit = view.addItem(withTitle: "Fit the Clip", action: #selector(MeetingsMenuTarget.fitClip(_:)), keyEquivalent: "0")
        fit.target = target
        bar.addItem(withTitle: "View", action: nil, keyEquivalent: "").submenu = view

        let window = NSMenu(title: "Window")
        window.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        window.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        bar.addItem(withTitle: "Window", action: nil, keyEquivalent: "").submenu = window
        return bar
    }

    static func install() {
        let bar = build()
        NSApp.mainMenu = bar
        NSApp.windowsMenu = bar.item(withTitle: "Window")?.submenu
        MeetingsPlaybackKeys.install()
    }
}

/// The player's plain keys in the Meetings window (G-KEY-1, G-STACK-2): Space plays or pauses, Left and Right go 5 s,
/// `[` and `]` step to the previous and next pin, Esc pops the context stack (announced) before the views get it. A text
/// field, a sheet, the "This also affects" card or a popover keeps every key; a key the player has no use for goes on to the views (Up and Down,
/// Return, the number keys, Esc that closes an editor or clears the selection).
@MainActor
enum MeetingsPlaybackKeys {
    enum Key: Equatable { case space, left, right, previousPin, nextPin, escape }

    /// The window the keys belong to (MeetingsWindow saves its frame under this name).
    static let windowName = "GenesisToolsMeetings"
    /// Left and Right: the dock's skip length.
    static let skipSec: Double = 5
    private static var monitor: Any?

    static func install() {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            MainActor.assumeIsolated { handle(event) ? nil : event }
        }
    }

    /// The key a plain key press names; none with ⌘, ⌃ or ⌥ held.
    static func key(keyCode: UInt16, characters: String?, modifiers: NSEvent.ModifierFlags, controlFocused: Bool = false) -> Key? {
        guard modifiers.intersection([.command, .control, .option]).isEmpty else { return nil }
        // Space activates a focused button; arrows change a focused picker or slider. Escape keeps its stack order.
        guard !controlFocused || ![49, 123, 124].contains(keyCode) else { return nil }
        switch keyCode {
        case 49: return .space
        case 123: return .left
        case 124: return .right
        case 53: return .escape
        default: break
        }
        switch characters {
        case "[": return .previousPin
        case "]": return .nextPin
        default: return nil
        }
    }

    private static func handle(_ event: NSEvent) -> Bool {
        guard let window = event.window, window.frameAutosaveName == windowName, window.attachedSheet == nil,
              !(window.firstResponder is NSText),
              let key = key(keyCode: event.keyCode, characters: event.charactersIgnoringModifiers, modifiers: event.modifierFlags,
                            controlFocused: StandardEditing.controlHasFocus(firstResponder: window.firstResponder,
                                                                           focusedElement: NSApp.accessibilityFocusedUIElement)),
              let model = MeetingsMenuTarget.shared.model,
              // The "This also affects" card is drawn in the window (no attached sheet) and keeps every key, as a sheet did.
              model.detail?.pendingReach == nil else { return false }
        return perform(key, model: model)
    }

    /// Runs `key` on the window's player; false lets the views have it. With `meetings.playback.keys` off every key goes
    /// on to the views (ux checklist: single-key shortcuts can be turned off).
    @discardableResult
    static func perform(_ key: Key, model: MeetingsWindowModel) -> Bool {
        guard MeetingsPreferences.Playback.keys.value(model.defaults) else { return false }
        let player = model.player
        switch key {
        case .space:
            if player.isActive {
                player.togglePause()
                return true
            }
            guard let detail = model.detail, detail.tab == .items, let id = detail.selectedRow,
                  let row = detail.rows.value?.rows.first(where: { $0.id == id }) else { return false }
            player.play(row.target, in: detail.id, from: .row)
            return true
        case .left, .right:
            guard player.top != nil else { return false }
            player.skip(by: key == .left ? -skipSec : skipSec)
            return true
        case .previousPin, .nextPin:
            return stepPin(forward: key == .nextPin, model: model)
        case .escape:
            if player.timeline.hoveredPin != nil {
                player.timeline.hoveredPin = nil
                return true
            }
            guard player.stack.count > 1 else { return false }
            player.pop()
            return true
        }
    }

    /// `[` and `]`: the pin before or after the selected row (or the playhead) in the playing meeting, else in the open
    /// one; it is selected as a pin click selects it.
    private static func stepPin(forward: Bool, model: MeetingsWindowModel) -> Bool {
        guard let meeting = model.player.meeting ?? model.detail?.id else { return false }
        let rows = model.detail?.id == meeting ? (model.detail?.rows.value?.rows ?? []) : (model.player.timeline.otherRows[meeting] ?? [])
        let pins = rows.compactMap { row in row.startSec.map { (id: row.id, sec: $0) } }.sorted { $0.sec < $1.sec }
        let from = model.detail?.id == meeting ? model.detail?.selectedRow.flatMap { id in pins.first { $0.id == id }?.sec } : nil
        guard let next = nextPin(pins.map(\.sec), from: from ?? model.player.position, forward: forward) else { return false }
        model.revealRow(pins[next].id, in: meeting)
        return true
    }

    /// The index of the next pin after `from` (or the first), or the one before it (or the last).
    static func nextPin(_ seconds: [Double], from: Double?, forward: Bool) -> Int? {
        guard !seconds.isEmpty else { return nil }
        guard let from else { return forward ? 0 : seconds.count - 1 }
        if forward { return seconds.firstIndex { $0 > from + 0.001 } }
        return seconds.lastIndex { $0 < from - 0.001 }
    }
}

/// The menu's actions on the one Meetings window.
@MainActor
final class MeetingsMenuTarget: NSObject, NSMenuItemValidation {
    static let shared = MeetingsMenuTarget()
    /// The window's model; the face sets it before the menu is used, a test sets its own.
    var model: MeetingsWindowModel?

    @objc func showNeeds(_ sender: Any?) { model?.go(.needs) }
    @objc func showAll(_ sender: Any?) { model?.go(.all) }
    @objc func showContacts(_ sender: Any?) { model?.go(.contacts) }
    @objc func toggleSidePanel(_ sender: Any?) { model?.sidePanelOpen.toggle() }

    /// The selected meeting in a window of its own (⇧⌘N), a copy of it (⌘D), and its title in edit (`renamingMeetingID`).
    @objc func openInNewWindow(_ sender: Any?) {
        guard let id = model?.selectedMeetingID else { return }
        MeetingsWindow.openExtra(meeting: id)
    }
    @objc func duplicateMeeting(_ sender: Any?) {
        guard let id = model?.selectedMeetingID else { return }
        model?.duplicate(id)
    }
    @objc func renameMeeting(_ sender: Any?) { model?.renamingMeetingID = model?.selectedMeetingID }

    static let meetingActions: Set<Selector> = [#selector(openInNewWindow(_:)), #selector(duplicateMeeting(_:)), #selector(renameMeeting(_:))]

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        if menuItem.action == #selector(toggleSidePanel(_:)) {
            menuItem.title = model?.sidePanelOpen == true ? "Hide Settings Panel" : "Show Settings Panel"
        }
        if let action = menuItem.action, Self.meetingActions.contains(action) {
            guard let id = model?.selectedMeetingID else { return false }
            return action != #selector(duplicateMeeting(_:)) || model?.duplicating.contains(id) != true
        }
        return true
    }
    @objc func reload(_ sender: Any?) {
        model?.load()
        model?.detail?.refreshLoaded(force: true)
    }
    @objc func openSettings(_ sender: Any?) { FeatureSettingsLaunch.open(pageID: MeetingsSettingsPages.windowPage) }
    @objc func zoomIn(_ sender: Any?) { model?.player.timeline.stepZoom(out: false) }
    @objc func zoomOut(_ sender: Any?) { model?.player.timeline.stepZoom(out: true) }
    @objc func fitClip(_ sender: Any?) { model?.player.timeline.setZoom(.clip) }
}

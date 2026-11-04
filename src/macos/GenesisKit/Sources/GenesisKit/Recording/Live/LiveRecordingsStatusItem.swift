import AppKit
import SwiftUI

/// The menu bar item of the live recordings (`LiveRecordingStore`): present only while one runs. A red record icon
/// while any entry records, the pause icon while all are paused. Its menu has a section per recording (title, kind,
/// time since it started, frames, displays, a warning) with Pause or Resume, Stop, Open folder and "Show floating
/// controls", and a Displays submenu. Each recording has one subscribed socket connection (`LiveRecordingSession`):
/// frames, state and displays come live from it, every action is an RPC call, and a failed call shows its error.
@MainActor
public final class LiveRecordingsStatusItem: NSObject, NSMenuDelegate {
    public static let shared = LiveRecordingsStatusItem()

    private let watcher: LiveRecordingsWatcher
    private var item: NSStatusItem?
    private var lastIcon: String?
    private var menuIsOpen = false
    /// The "meeting · 12:03 · 340 frames" row of each recording in the open menu, updated in place each second.
    private var detailRows: [String: NSMenuItem] = [:]
    private var panels: [String: LiveRecordingPanel] = [:]
    private var sessions: [String: LiveRecordingSession] = [:]
    /// Recordings whose asked-for floating controls this host opened already (closing them must not reopen them).
    private var panelsOpened: Set<String> = []
    /// The live files' entries as last read.
    private var entries: [LiveRecording] = []
    /// What the menu shows: the entries whose socket answers, with what it said.
    private var recordings: [LiveRecording] = []

    /// The lock that makes one process the item's host. The hub and the recorder part both start the item; whichever
    /// takes `<live folder>/.status-item.lock` first shows it, the other tries again at its next refresh (1 s). The
    /// kernel drops the lock when the host exits, and the host lets it go once no recording is left.
    private let ownerLock: URL
    private var ownerDescriptor: Int32 = -1

    public init(store: LiveRecordingStore = .live) {
        watcher = LiveRecordingsWatcher(store: store)
        ownerLock = store.folder.appendingPathComponent(".status-item.lock")
    }

    public func start() {
        watcher.onRefresh = { [weak self] list in self?.sync(list) }
        watcher.start()
    }

    public func stop() {
        watcher.stop()
        watcher.onRefresh = nil
        sync([])
    }

    // MARK: - State

    /// One session per entry; a rewritten file with another pid or socket gets a new one.
    private func sync(_ list: [LiveRecording]) {
        entries = list
        let ids = Set(list.map(\.id))
        for (id, session) in sessions where !ids.contains(id) {
            session.close()
            sessions[id] = nil
        }

        for entry in list {
            if let session = sessions[entry.id], session.key == LiveRecordingSession.key(entry) {
                session.connectIfNeeded()
                continue
            }

            sessions[entry.id]?.close()
            let session = LiveRecordingSession(entry: entry)
            session.onChange = { [weak self] in self?.render() }
            sessions[entry.id] = session
            session.connectIfNeeded()
        }

        render()
    }

    private func render() {
        let list = entries.compactMap { entry in sessions[entry.id]?.visible(entry) }
        let structureChanged = list.map(\.id) != recordings.map(\.id)
            || list.map(\.connectedDisplays) != recordings.map(\.connectedDisplays)
        recordings = list
        update(list)
        // An open menu keeps its rows; a new recording or display list shows at the next open.
        if structureChanged, !menuIsOpen, item?.isVisible == true, let menu = item?.menu { build(menu, list: list) }
    }

    private func update(_ list: [LiveRecording]) {
        for (id, panel) in panels {
            if let recording = list.first(where: { $0.id == id }) {
                panel.update(recording)
            } else {
                panel.close()
                panels[id] = nil
            }
        }

        guard !list.isEmpty else {
            removeItem()
            releaseOwnership()
            return
        }

        guard takeOwnership() else {
            removeItem()
            return
        }

        installItem()
        renderIcon(list)
        for recording in list where recording.panel && !panelsOpened.contains(recording.id) {
            panelsOpened.insert(recording.id)
            showControls(for: recording)
        }
        panelsOpened.formIntersection(list.map(\.id))
        if menuIsOpen { refreshDetails(list) }
    }

    /// One item for the process's life, shown and hidden. A removed and re-created item came back seconds later
    /// (the menu bar hosts each item in a system scene), and once not at all.
    private func installItem() {
        if let item {
            item.isVisible = true
            return
        }

        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        // Its own name: macOS saves each item's visibility under it ("NSStatusItem VisibleCC <name>"), and an item
        // without one is "Item-0", shared with the first item of every other GenesisTools face. This one hides
        // itself between recordings, which then hid the recorder's and Clicky's items too.
        item.autosaveName = "genesistools.live-recordings"
        item.isVisible = true
        item.button?.setAccessibilityIdentifier("live-recordings-status-item")
        let menu = NSMenu()
        menu.delegate = self
        menu.autoenablesItems = false
        item.menu = menu
        self.item = item
    }

    /// True while this process is the item's host; takes the lock when it is free.
    private func takeOwnership() -> Bool {
        guard ownerDescriptor < 0 else { return true }
        try? FileManager.default.createDirectory(at: ownerLock.deletingLastPathComponent(), withIntermediateDirectories: true)
        let descriptor = open(ownerLock.path, O_RDWR | O_CREAT | O_CLOEXEC, 0o644)
        // Without a lock file the one-host guarantee cannot hold; showing the item beats losing it.
        guard descriptor >= 0 else { return true }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            close(descriptor)
            return false
        }
        ownerDescriptor = descriptor
        KitHost.log("live recordings: this process (pid \(getpid())) hosts the status item")
        return true
    }

    private func releaseOwnership() {
        guard ownerDescriptor >= 0 else { return }
        flock(ownerDescriptor, LOCK_UN)
        close(ownerDescriptor)
        ownerDescriptor = -1
    }

    private func removeItem() {
        guard let item, item.isVisible else { return }
        item.menu?.cancelTracking()
        item.isVisible = false
        detailRows = [:]
    }

    private func renderIcon(_ list: [LiveRecording]) {
        guard let button = item?.button else { return }
        let recording = list.contains(where: \.isRecording)
        let paused = list.allSatisfy(\.isPaused)
        let symbol = recording ? "record.circle.fill" : paused ? "pause.circle.fill" : "record.circle"
        let label = recording
            ? "Recording: \(Plural.count(list.count, "live recording"))"
            : paused ? "Recording paused" : "Recording stops"
        button.toolTip = list.count == 1 ? "\(list[0].title) · \(label)" : label
        button.setAccessibilityLabel(label)
        guard symbol != lastIcon else { return }
        lastIcon = symbol

        let size = NSImage.SymbolConfiguration(pointSize: 14, weight: .regular)
        let configuration = recording ? size.applying(NSImage.SymbolConfiguration(hierarchicalColor: .systemRed)) : size
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)?
            .withSymbolConfiguration(configuration)
        // A template image takes the menu bar's own colour; the red icon keeps its red.
        image?.isTemplate = !recording
        button.image = image
    }

    // MARK: - Menu

    public func menuNeedsUpdate(_ menu: NSMenu) {
        build(menu, list: recordings)
    }

    public func menuWillOpen(_ menu: NSMenu) { menuIsOpen = true }

    public func menuDidClose(_ menu: NSMenu) { menuIsOpen = false }

    private func build(_ menu: NSMenu, list: [LiveRecording]) {
        menu.removeAllItems()
        detailRows = [:]
        let now = Date()
        for (index, recording) in list.enumerated() {
            if index > 0 { menu.addItem(.separator()) }
            menu.addItem(infoRow(recording.title, font: .menuFont(ofSize: 0).bold, color: .labelColor))
            let detail = infoRow(Self.detail(recording, now: now), font: .menuFont(ofSize: 12), color: .secondaryLabelColor)
            detailRows[recording.id] = detail
            menu.addItem(detail)
            if !recording.displayNames.isEmpty {
                menu.addItem(infoRow(recording.displayNames, font: .menuFont(ofSize: 12), color: .secondaryLabelColor,
                                     symbol: "display"))
            }

            if let warning = recording.warning {
                menu.addItem(infoRow(warning, font: .menuFont(ofSize: 12), color: .systemOrange,
                                     symbol: "exclamationmark.triangle.fill"))
            }

            if let error = recording.lastError {
                menu.addItem(infoRow(error, font: .menuFont(ofSize: 12), color: .systemRed, symbol: "xmark.octagon.fill"))
            }

            if !recording.canControl {
                menu.addItem(infoRow("No control socket: this recorder cannot be controlled from here",
                                     font: .menuFont(ofSize: 12), color: .secondaryLabelColor))
            }

            let toggle = recording.isPaused ? LiveRecordingCommand.resume : .pause
            menu.addItem(action(toggle == .pause ? "Pause" : "Resume", symbol: toggle == .pause ? "pause.fill" : "play.fill",
                                selector: #selector(sendToggle(_:)), recording: recording,
                                enabled: recording.toggleCommand != nil, id: "live-recording.\(toggle.rawValue)"))
            menu.addItem(action("Stop", symbol: "stop.fill", selector: #selector(sendStop(_:)), recording: recording,
                                enabled: recording.allows(.stop), id: "live-recording.stop"))
            if recording.folder != nil {
                menu.addItem(action("Open folder", symbol: "folder", selector: #selector(openFolder(_:)),
                                    recording: recording, enabled: true, id: "live-recording.folder"))
            }

            if recording.canControl && recording.controls.contains("displays.list") {
                let displays = action("Displays", symbol: "display.2", selector: nil, recording: recording,
                                      enabled: !recording.isStopping, id: "live-recording.displays")
                displays.submenu = displaysMenu(recording)
                menu.addItem(displays)
            }

            menu.addItem(action("Show floating controls", symbol: "macwindow", selector: #selector(showControls(_:)),
                                recording: recording, enabled: true, id: "live-recording.controls"))
        }
    }

    /// Each connected display, checked while recorded (a click adds or removes it), "Record only …" per display, and
    /// the two modes.
    func displaysMenu(_ recording: LiveRecording) -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        if recording.connectedDisplays.isEmpty {
            menu.addItem(infoRow("No display list from the recorder yet", font: .menuFont(ofSize: 12),
                                 color: .secondaryLabelColor))
        }

        for display in recording.connectedDisplays where recording.controls.contains(display.recorded ? "displays.remove" : "displays.add") {
            let row = displayRow(display.name, selector: #selector(toggleDisplay(_:)), recording: recording,
                                 display: display.id, id: "live-recording.display.\(display.id)")
            row.state = display.recorded ? .on : .off
            // The last recorded display cannot be removed: Stop ends the recording.
            row.isEnabled = !(display.recorded && recording.connectedDisplays.filter(\.recorded).count == 1)
            menu.addItem(row)
        }

        if !recording.connectedDisplays.isEmpty && recording.controls.contains("displays.switch") {
            menu.addItem(.separator())
            for display in recording.connectedDisplays {
                menu.addItem(displayRow("Record only \(display.name)", selector: #selector(switchDisplay(_:)),
                                        recording: recording, display: display.id,
                                        id: "live-recording.only.\(display.id)"))
            }
        }

        menu.addItem(.separator())
        for (mode, title) in Self.modes where recording.controls.contains("displays.mode") {
            let row = NSMenuItem(title: title, action: #selector(setMode(_:)), keyEquivalent: "")
            row.target = self
            row.representedObject = LiveRecordingTarget(id: recording.id, value: mode)
            row.state = recording.mode == mode ? .on : .off
            row.identifier = NSUserInterfaceItemIdentifier("live-recording.mode.\(mode)")
            menu.addItem(row)
        }

        return menu
    }

    static let modes: [(String, String)] = [("all", "All displays"), ("follow-focus", "Follow focus")]

    private func displayRow(_ title: String, selector: Selector, recording: LiveRecording, display: Int64,
                            id: String) -> NSMenuItem {
        let row = NSMenuItem(title: title, action: selector, keyEquivalent: "")
        row.target = self
        row.representedObject = LiveRecordingTarget(id: recording.id, value: String(display))
        row.identifier = NSUserInterfaceItemIdentifier(id)
        return row
    }

    /// "Meeting · 12:03 · 340 frames".
    nonisolated static func detail(_ recording: LiveRecording, now: Date) -> String {
        let kind = recording.kind.replacingOccurrences(of: "-", with: " ").capitalizedFirst
        var parts = [kind, RecordingClock.format(recording.elapsedMs(now: now)), Plural.count(recording.frames, "frame")]
        if recording.isPaused { parts.append("paused") }
        if recording.isStopping { parts.append("stopping") }

        return parts.joined(separator: " · ")
    }

    private func refreshDetails(_ list: [LiveRecording]) {
        let now = Date()
        for recording in list {
            detailRows[recording.id]?.attributedTitle = Self.attributed(
                Self.detail(recording, now: now), font: .menuFont(ofSize: 12), color: .secondaryLabelColor)
        }
    }

    private func infoRow(_ text: String, font: NSFont, color: NSColor, symbol: String? = nil) -> NSMenuItem {
        let row = NSMenuItem(title: text, action: nil, keyEquivalent: "")
        row.attributedTitle = Self.attributed(text, font: font, color: color)
        row.isEnabled = false
        if let symbol { row.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil) }

        return row
    }

    private static func attributed(_ text: String, font: NSFont, color: NSColor) -> NSAttributedString {
        NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: color])
    }

    private func action(_ title: String, symbol: String, selector: Selector?, recording: LiveRecording, enabled: Bool,
                        id: String) -> NSMenuItem {
        let row = NSMenuItem(title: title, action: selector, keyEquivalent: "")
        row.target = self
        row.representedObject = recording.id
        row.isEnabled = enabled
        row.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
        row.identifier = NSUserInterfaceItemIdentifier(id)
        row.indentationLevel = 1

        return row
    }

    // MARK: - Actions

    private func recording(of sender: NSMenuItem) -> LiveRecording? {
        guard let id = sender.representedObject as? String else { return nil }

        return recordings.first { $0.id == id }
    }

    @objc private func toggleDisplay(_ sender: NSMenuItem) {
        guard let target = sender.representedObject as? LiveRecordingTarget, let display = Int64(target.value) else { return }
        let recorded = recordings.first { $0.id == target.id }?.connectedDisplays.first { $0.id == display }?.recorded
        let method = recorded == true ? "displays.remove" : "displays.add"
        sessions[target.id]?.call(method, params: ["displayId": display],
                                  label: recorded == true ? "Removing \(sender.title)" : "Adding \(sender.title)")
    }

    @objc private func switchDisplay(_ sender: NSMenuItem) {
        guard let target = sender.representedObject as? LiveRecordingTarget, let display = Int64(target.value) else { return }
        sessions[target.id]?.call("displays.switch", params: ["displayId": display], label: sender.title)
    }

    @objc private func setMode(_ sender: NSMenuItem) {
        guard let target = sender.representedObject as? LiveRecordingTarget else { return }
        sessions[target.id]?.call("displays.mode", params: ["mode": target.value], label: sender.title)
    }

    @objc private func sendToggle(_ sender: NSMenuItem) {
        guard let recording = recording(of: sender), let command = recording.toggleCommand else { return }
        send(command, to: recording.id)
    }

    @objc private func sendStop(_ sender: NSMenuItem) {
        guard let recording = recording(of: sender) else { return }
        send(.stop, to: recording.id)
    }

    @objc private func openFolder(_ sender: NSMenuItem) {
        guard let folder = recording(of: sender)?.folder else { return }
        PathOpener.finder(folder)
    }

    @objc private func showControls(_ sender: NSMenuItem) {
        guard let recording = recording(of: sender) else { return }
        showControls(for: recording)
    }

    /// The floating controls of one recording; a second ask brings the open one forward.
    public func showControls(for recording: LiveRecording) {
        if let panel = panels[recording.id] {
            panel.show()
            return
        }

        let id = recording.id
        let panel = LiveRecordingPanel(
            recording: recording, stack: (0...panels.count).first { slot in !panels.values.contains { $0.slot == slot } } ?? 0,
            send: { [weak self] command in self?.send(command, to: id) },
            hide: { [weak self] in
                self?.panels[id]?.close()
                self?.panels[id] = nil
            })
        panels[id] = panel
        panel.show()
    }

    private func send(_ command: LiveRecordingCommand, to id: String) {
        sessions[id]?.call(command.rawValue, label: command.rawValue.capitalizedFirst)
    }
}

/// A menu row's recording and the display id or mode it acts on.
private final class LiveRecordingTarget: NSObject {
    let id: String
    let value: String

    init(id: String, value: String) {
        self.id = id
        self.value = value
    }
}

private extension String {
    var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}

private extension NSFont {
    var bold: NSFont { NSFontManager.shared.convert(self, toHaveTrait: .boldFontMask) }
}

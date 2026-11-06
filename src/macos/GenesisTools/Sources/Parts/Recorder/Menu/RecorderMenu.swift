import AVFoundation
import AppKit

/// The recorder's menu bar item, always there while the face runs: record the screen, open a recording or a movie
/// in the editor, the latest recordings with a thumbnail each, the recordings folder, and quit. The list is read
/// when the menu opens, on a background queue; the menu shows the previous read until the new one lands.
@MainActor
final class RecorderMenu: NSObject, NSMenuDelegate {
    static let shared = RecorderMenu()

    struct Recent: Equatable {
        let folder: URL
        let title: String
        let started: Date
        let thumbnail: URL?
        let hasMovie: Bool
        /// `edit.json` exists beside the recording.
        var edited = false
        /// The movie's length from `recording.json` (video recordings write it when they end).
        var durationMs: Double?
        /// The screen recording of a meeting (`~/.genesis-tools/meetings/<id>/`): the folder is the meeting's, so the
        /// library never moves it to the Trash.
        var isMeeting = false
        /// Review comments not yet resolved (comments.jsonl beside it), and where the first one is, in source µs.
        var openComments = 0
        var firstOpenCommentUs: Int64?
        /// Why the recording made no movie (`recording.json` says `outcome: failed` and no movie is there): its first
        /// warning, so the card says "Failed" with the reason instead of passing for a frames recording.
        var failure: String?
    }

    private var item: NSStatusItem?
    private var recents: [Recent] = []
    private var thumbnails: [URL: NSImage] = [:]
    private var reading = false

    static var libraryFolder: URL {
        URL(fileURLWithPath: genesisHome()).appendingPathComponent(".genesis-tools/recordings/library", isDirectory: true)
    }

    /// The meetings, each a folder; one with a screen recording holds the `recording.json` its recorder writes.
    nonisolated static var meetingsFolder: URL {
        URL(fileURLWithPath: genesisHome()).appendingPathComponent(".genesis-tools/meetings", isDirectory: true)
    }

    /// Every folder whose recordings the menu and the library list.
    static var recordingFolders: [URL] { [libraryFolder, meetingsFolder] }

    /// Opens a recording in the editor. A frames-only one (a meeting's screen, say) goes through
    /// `tools recorder open`, which makes its proxy movie first and then opens the editor.
    static func open(_ recent: Recent, atSourceSeconds: Double? = nil) {
        if let failure = recent.failure {
            RecorderNotice.failure("“\(recent.title)” did not record, so there is nothing to open.", more: failure)
            return
        }
        if recent.hasMovie {
            EditorWindows.shared.open(path: recent.folder.path, atSourceSeconds: atSourceSeconds)
            return
        }
        HubPerf.log("recorder: open frames-only \(recent.folder.path) through tools recorder edit")
        do {
            // `edit` makes proxy.mp4 for a frames-only recording, then opens the editor (there never was an `open`).
            try ToolsRunner.detached(["recorder", "edit", recent.folder.path]) { status, output in
                RecorderNotice.failure("“\(recent.title)” did not open: making its movie failed (exit \(status))",
                                       output: output, fallback: "tools recorder edit \(recent.folder.path)")
            }
        } catch {
            RecorderNotice.failure("“\(recent.title)” did not open.", more: error.localizedDescription)
        }
    }

    func install() {
        guard item == nil else { return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        // Its own visibility key (see LiveRecordingsStatusItem.installItem); the user can still hide it in System
        // Settings → Menu Bar, which sets that key.
        item.autosaveName = "genesistools.recorder"
        item.button?.image = NSImage(systemSymbolName: "record.circle", accessibilityDescription: "GenesisTools recorder")
        item.button?.setAccessibilityIdentifier("recorder-status-item")
        let menu = NSMenu()
        menu.delegate = self
        menu.autoenablesItems = false
        item.menu = menu
        self.item = item
        build(menu)
        refresh()
        // A new item of this bundle can start hidden (macOS carries the bundle's earlier choice over); only a
        // choice saved under this item's own name is the user's, and that one stays.
        let saved = UserDefaults.standard.object(forKey: "NSStatusItem VisibleCC genesistools.recorder") != nil
        if !saved, !item.isVisible {
            item.isVisible = true
        }
        HubPerf.log("recorder: menu bar item installed (saved choice \(saved), visible \(item.isVisible))")
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        build(menu)
        refresh()
    }

    private func build(_ menu: NSMenu) {
        menu.removeAllItems()
        let picker = row("Capture Picker…", symbol: "rectangle.dashed.badge.record", action: #selector(openPicker), key: "")
        let chord = RecorderShortcutBinding.load(.picker)
        picker.toolTip = chord.enabled ? "Also \(chord.chord.label) from any app" : "Its shortcut is off (Recorder Settings → Shortcuts, or the picker's Shortcuts)"
        menu.addItem(picker)
        menu.addItem(row("Record Screen", symbol: "record.circle", action: #selector(recordScreen), key: ""))
        menu.addItem(row("Record Screen with Audio", symbol: "mic.circle", action: #selector(recordScreenWithAudio), key: ""))
        let drawn = row("Draw the Cursor in the Editor", symbol: nil, action: #selector(toggleDrawnCursor), key: "")
        drawn.state = Self.drawsCursor ? .on : .off
        drawn.toolTip = "Records without the system cursor; the editor draws it from the cursor track, smoothed and at any size. Off keeps the system cursor in the movie."
        menu.addItem(drawn)
        let keys = row("Record ⌘/⌃ Shortcuts", symbol: nil, action: #selector(toggleShortcuts), key: "")
        keys.state = Self.recordsShortcuts ? .on : .off
        keys.toolTip = "Keeps the shortcuts pressed with ⌘ or ⌃ for the editor's shortcut overlay. Plain typing is never kept."
        menu.addItem(keys)
        menu.addItem(.separator())
        menu.addItem(row("Open Recording…", symbol: "film", action: #selector(openRecording), key: "o"))
        menu.addItem(row("Recordings Library…", symbol: "square.grid.2x2", action: #selector(openLibrary), key: "l"))
        menu.addItem(row("Open Recordings Folder", symbol: "folder", action: #selector(openFolder), key: ""))
        let settings = row("Recorder Settings…", symbol: "gearshape", action: #selector(openSettings), key: ",")
        settings.toolTip = "Every recorder option in one place: recording, camera, shortcuts, the menu bar and the editor"
        menu.addItem(settings)
        if !recents.isEmpty {
            menu.addItem(.separator())
            let header = NSMenuItem(title: "Recent", action: nil, keyEquivalent: "")
            header.isEnabled = false
            menu.addItem(header)
            for recent in recents.prefix(6) {
                let row = NSMenuItem(title: recent.title, action: #selector(openRecent(_:)), keyEquivalent: "")
                row.target = self
                row.representedObject = recent.folder.path
                if recent.isMeeting { row.title = "\(recent.title) (meeting)" }
                row.image = recent.thumbnail.flatMap { thumbnails[$0] } ?? NSImage(systemSymbolName: "video", accessibilityDescription: nil)
                row.toolTip = "\(recent.folder.lastPathComponent)\(recent.hasMovie ? "" : " (frames only)")"
                row.isEnabled = true
                if Self.recentActions {
                    // A row with a submenu opens it on hover; Open in Editor is its first entry.
                    row.submenu = MenuButtonPresenter.menu(RecordingActions.menuItems(for: recent) { [weak self] in self?.report($0) })
                }
                menu.addItem(row)
            }
            let actions = row("Quick Actions in Recent", symbol: nil, action: #selector(toggleRecentActions), key: "")
            actions.state = Self.recentActions ? .on : .off
            actions.toolTip = "Each recent recording opens a menu: open, copy the movie or a GIF, show in Finder, rename, its meeting, Trash. Off, a click opens the editor."
            menu.addItem(actions)
        }
        menu.addItem(.separator())
        menu.addItem(row("Quit Recorder", symbol: nil, action: #selector(quit), key: "q"))
    }

    private func row(_ title: String, symbol: String?, action: Selector, key: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        item.isEnabled = true
        if let symbol { item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil) }
        return item
    }

    /// Reads the library on a background queue: the newest folders first, each with its first frame or movie poster.
    private func refresh() {
        guard !reading else { return }
        reading = true
        let folders = Self.recordingFolders
        DispatchQueue.global(qos: .userInitiated).async {
            let list = Self.readRecents(folders)
            var images: [URL: NSImage] = [:]
            for recent in list.prefix(6) {
                if let url = recent.thumbnail, let image = Self.thumbnail(url) { images[url] = image }
            }
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    self.reading = false
                    self.thumbnails.merge(images) { $1 }
                    guard list != self.recents else { return }
                    self.recents = list
                    if let menu = self.item?.menu { self.build(menu) }
                }
            }
        }
    }

    nonisolated static func readRecents(_ folders: [URL]) -> [Recent] {
        folders.flatMap { readRecents($0, isMeeting: $0.standardizedFileURL == meetingsFolder.standardizedFileURL) }
            .sorted { $0.started > $1.started }
    }

    nonisolated static func readRecents(_ folder: URL, isMeeting: Bool = false) -> [Recent] {
        let manager = FileManager.default
        let names = (try? manager.contentsOfDirectory(atPath: folder.path)) ?? []
        var list: [Recent] = []
        for name in names {
            let dir = folder.appendingPathComponent(name, isDirectory: true)
            let manifest = dir.appendingPathComponent("recording.json")
            guard let data = try? Data(contentsOf: manifest),
                  let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            let started = (root["startedAt"] as? String).flatMap { ISO8601DateFormatter.withFraction.date(from: $0) }
                ?? ((try? manager.attributesOfItem(atPath: manifest.path)[.modificationDate]) as? Date) ?? .distantPast
            let movie = RecordingMovie.own(in: dir)
            let hasMovie = movie != nil
            let firstFrame = ((root["frames"] as? [[String: Any]])?.first?["file"] as? String).map { dir.appendingPathComponent($0) }
            let settings = root["settings"] as? [String: Any]
            let video = settings?["video"] as? [String: Any]
            let failure = !hasMovie && settings?["outcome"] as? String == "failed"
                ? (root["warnings"] as? [String])?.first ?? "The recording failed before it recorded anything"
                : nil
            let open = ReviewComments.read(dir.appendingPathComponent("comments.jsonl")).filter { !$0.isResolved }
            list.append(Recent(folder: dir, title: (root["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? name,
                               started: started, thumbnail: movie ?? firstFrame, hasMovie: hasMovie,
                               edited: manager.fileExists(atPath: dir.appendingPathComponent("edit.json").path),
                               durationMs: (video?["durationMs"] as? NSNumber)?.doubleValue, isMeeting: isMeeting,
                               openComments: open.count, firstOpenCommentUs: open.first?.atUs, failure: failure))
        }
        return list.sorted { $0.started > $1.started }
    }

    /// Frames of a movie at the given seconds, each drawn like `thumbnail` (one generator for all of them).
    nonisolated static func frames(_ url: URL, size: NSSize, radius: CGFloat, at seconds: [Double]) -> [NSImage] {
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
        let pixels = max(size.width, size.height) * 2
        generator.maximumSize = CGSize(width: pixels, height: pixels)
        generator.appliesPreferredTrackTransform = true
        generator.requestedTimeToleranceBefore = CMTime(seconds: 0.5, preferredTimescale: 600)
        generator.requestedTimeToleranceAfter = CMTime(seconds: 0.5, preferredTimescale: 600)
        return seconds.compactMap { second in
            guard let cg = try? generator.copyCGImage(at: CMTime(seconds: second, preferredTimescale: 600), actualTime: nil) else { return nil }
            let image = NSImage(size: size)
            image.lockFocus()
            NSBezierPath(roundedRect: NSRect(origin: .zero, size: size), xRadius: radius, yRadius: radius).addClip()
            NSImage(cgImage: cg, size: size).draw(in: NSRect(origin: .zero, size: size))
            image.unlockFocus()
            return image
        }
    }

    /// A frame of a movie (`atSeconds`, the first by default), or a frame image, drawn into `size` points with rounded
    /// corners (3× pixels).
    nonisolated static func thumbnail(_ url: URL, size: NSSize = NSSize(width: 44, height: 28), radius: CGFloat = 4,
                                      atSeconds: Double = 0) -> NSImage? {
        var cg: CGImage?
        let pixels = max(size.width, size.height) * 3
        if url.pathExtension == "mp4" || url.pathExtension == "mov" {
            let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
            generator.maximumSize = CGSize(width: pixels, height: pixels)
            generator.appliesPreferredTrackTransform = true
            generator.requestedTimeToleranceBefore = CMTime(seconds: 1, preferredTimescale: 600)
            generator.requestedTimeToleranceAfter = CMTime(seconds: 1, preferredTimescale: 600)
            cg = try? generator.copyCGImage(at: CMTime(seconds: atSeconds, preferredTimescale: 600), actualTime: nil)
                ?? generator.copyCGImage(at: .zero, actualTime: nil)
        } else if let source = CGImageSourceCreateWithURL(url as CFURL, nil) {
            cg = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: pixels,
            ] as CFDictionary)
        }
        guard let cg else { return nil }
        let image = NSImage(size: size)
        image.lockFocus()
        NSBezierPath(roundedRect: NSRect(origin: .zero, size: size), xRadius: radius, yRadius: radius).addClip()
        NSImage(cgImage: cg, size: size).draw(in: NSRect(origin: .zero, size: size))
        image.unlockFocus()
        return image
    }

    // MARK: - Actions

    /// On (the default): a recording leaves the system cursor out and the editor draws it (`tools recorder start`
    /// without `--system-cursor`).
    static let drawCursorKey = "recorder.record.drawCursor"
    static var drawsCursor: Bool { UserDefaults.standard.object(forKey: drawCursorKey) as? Bool ?? true }

    @objc private func toggleDrawnCursor() {
        UserDefaults.standard.set(!Self.drawsCursor, forKey: Self.drawCursorKey)
    }

    /// On (the default): a recording keeps the ⌘/⌃ shortcuts (`--no-shortcuts` when off).
    static let recordShortcutsKey = "recorder.record.shortcuts"
    static var recordsShortcuts: Bool { UserDefaults.standard.object(forKey: recordShortcutsKey) as? Bool ?? true }

    @objc private func toggleShortcuts() {
        UserDefaults.standard.set(!Self.recordsShortcuts, forKey: Self.recordShortcutsKey)
    }

    /// On (the default): each Recent row opens a submenu of quick actions; off, a click on the row opens the editor.
    static let recentActionsKey = "recorder.menu.recentActions"
    static var recentActions: Bool { UserDefaults.standard.object(forKey: recentActionsKey) as? Bool ?? true }

    @objc private func toggleRecentActions() {
        UserDefaults.standard.set(!Self.recentActions, forKey: Self.recentActionsKey)
    }

    /// A quick action's outcome from the menu: a failure is a note under the item (or an alert, Settings → Recorder),
    /// a GIF in the making shows an hourglass on the item until it is copied, and a change reads the list again.
    private func report(_ outcome: RecordingActions.Outcome) {
        switch outcome {
        case let .working(text):
            item?.button?.image = NSImage(systemSymbolName: "hourglass", accessibilityDescription: text)
            item?.button?.toolTip = text
        case .notice:
            item?.button?.image = NSImage(systemSymbolName: "record.circle", accessibilityDescription: "GenesisTools recorder")
            item?.button?.toolTip = nil
        case let .failed(text):
            item?.button?.image = NSImage(systemSymbolName: "record.circle", accessibilityDescription: "GenesisTools recorder")
            item?.button?.toolTip = nil
            RecorderNotice.failure(text)
        case .trashed, .renamed:
            refresh()
        }
    }

    @objc private func recordScreen() { startRecording(audio: false) }
    @objc private func recordScreenWithAudio() { startRecording(audio: true) }
    @objc private func openPicker() { CapturePicker.shared.show() }

    /// The display in use, with the capture picker's saved options; the menu's two rows set the audio themselves.
    func startRecording(audio: Bool) {
        var options = CaptureOptions.load()
        options.systemAudio = audio
        options.microphone = audio
        options.camera = false
        startRecording(arguments: options.startArguments(.followPointer))
    }

    /// The one start path: `tools recorder start` in its own process (it owns the recording and its socket); the live
    /// recordings' item and the floating controls (on by default) appear when its live entry does.
    func startRecording(arguments args: [String]) {
        HubPerf.log("recorder: start \(args.joined(separator: " "))")
        do {
            try ToolsRunner.detached(args) { status, output in
                RecorderNotice.failure("The recording stopped at once (exit \(status))", output: output,
                                       fallback: "See ~/.genesis-tools/logs/recorder-start.log")
            }
        } catch {
            RecorderNotice.failure("The recording did not start.", more: error.localizedDescription)
        }
    }

    @objc private func openRecording() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = true
        panel.allowedContentTypes = [.movie, .mpeg4Movie, .quickTimeMovie, .json, .folder]
        panel.directoryURL = Self.libraryFolder
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK, let url = panel.url else { return }
        EditorWindows.shared.open(path: url.path)
    }

    @objc private func openRecent(_ sender: NSMenuItem) {
        guard let path = sender.representedObject as? String, let recent = recents.first(where: { $0.folder.path == path }) else { return }
        Self.open(recent)
    }

    @objc private func openLibrary() {
        LibraryWindow.shared.show(focus: true)
    }

    @objc private func openSettings() {
        FeatureSettingsLaunch.open(pageID: RecorderSettingsPlugin.recordingPageID)
    }

    /// The item's button on screen, for the failure note under it; nil while the item is hidden.
    var statusItemFrame: CGRect? {
        guard let item, item.isVisible, let window = item.button?.window, window.isVisible else { return nil }
        return window.frame
    }

    @objc private func openFolder() {
        try? FileManager.default.createDirectory(at: Self.libraryFolder, withIntermediateDirectories: true)
        PathOpener.finder(Self.libraryFolder.path)
    }

    @objc private func quit() {
        exit(0)
    }
}

extension ISO8601DateFormatter {
    nonisolated(unsafe) static let withFraction: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}

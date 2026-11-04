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
    }

    private var item: NSStatusItem?
    private var recents: [Recent] = []
    private var thumbnails: [URL: NSImage] = [:]
    private var reading = false

    static var libraryFolder: URL {
        URL(fileURLWithPath: genesisHome()).appendingPathComponent(".genesis-tools/recordings/library", isDirectory: true)
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
        menu.addItem(row("Record Screen", symbol: "record.circle", action: #selector(recordScreen), key: ""))
        menu.addItem(row("Record Screen with Audio", symbol: "mic.circle", action: #selector(recordScreenWithAudio), key: ""))
        menu.addItem(.separator())
        menu.addItem(row("Open Recording…", symbol: "film", action: #selector(openRecording), key: "o"))
        menu.addItem(row("Open Recordings Folder", symbol: "folder", action: #selector(openFolder), key: ""))
        if !recents.isEmpty {
            menu.addItem(.separator())
            let header = NSMenuItem(title: "Recent", action: nil, keyEquivalent: "")
            header.isEnabled = false
            menu.addItem(header)
            for recent in recents.prefix(6) {
                let row = NSMenuItem(title: recent.title, action: #selector(openRecent(_:)), keyEquivalent: "")
                row.target = self
                row.representedObject = recent.folder.path
                row.image = recent.thumbnail.flatMap { thumbnails[$0] } ?? NSImage(systemSymbolName: "video", accessibilityDescription: nil)
                row.toolTip = "\(recent.folder.lastPathComponent)\(recent.hasMovie ? "" : " (frames only)")"
                row.isEnabled = true
                menu.addItem(row)
            }
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
        let folder = Self.libraryFolder
        DispatchQueue.global(qos: .userInitiated).async {
            let list = Self.readRecents(folder)
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

    nonisolated static func readRecents(_ folder: URL) -> [Recent] {
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
            let movie = dir.appendingPathComponent("screen.mp4")
            let hasMovie = manager.fileExists(atPath: movie.path)
            let firstFrame = ((root["frames"] as? [[String: Any]])?.first?["file"] as? String).map { dir.appendingPathComponent($0) }
            list.append(Recent(folder: dir, title: (root["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? name,
                               started: started, thumbnail: hasMovie ? movie : firstFrame, hasMovie: hasMovie))
        }
        return list.sorted { $0.started > $1.started }
    }

    nonisolated static func thumbnail(_ url: URL) -> NSImage? {
        let size = NSSize(width: 44, height: 28)
        var cg: CGImage?
        if url.pathExtension == "mp4" || url.pathExtension == "mov" {
            let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
            generator.maximumSize = CGSize(width: 132, height: 84)
            cg = try? generator.copyCGImage(at: .zero, actualTime: nil)
        } else if let source = CGImageSourceCreateWithURL(url as CFURL, nil) {
            cg = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 132,
            ] as CFDictionary)
        }
        guard let cg else { return nil }
        let image = NSImage(size: size)
        image.lockFocus()
        NSBezierPath(roundedRect: NSRect(origin: .zero, size: size), xRadius: 4, yRadius: 4).addClip()
        NSImage(cgImage: cg, size: size).draw(in: NSRect(origin: .zero, size: size))
        image.unlockFocus()
        return image
    }

    // MARK: - Actions

    @objc private func recordScreen() { startRecording(audio: false) }
    @objc private func recordScreenWithAudio() { startRecording(audio: true) }

    /// Starts `tools recorder start --video` in its own process (it owns the recording and its socket); the live
    /// recordings' item and floating controls appear when its live entry does.
    private func startRecording(audio: Bool) {
        var args = ["recorder", "start", "--video", "--show-controls"]
        if audio { args += ["--audio", "system,mic"] }
        HubPerf.log("recorder: start \(args.joined(separator: " "))")
        do {
            try ToolsRunner.detached(args)
        } catch {
            let alert = NSAlert()
            alert.messageText = "The recording did not start"
            alert.informativeText = error.localizedDescription
            alert.runModal()
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
        guard let path = sender.representedObject as? String else { return }
        EditorWindows.shared.open(path: path)
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

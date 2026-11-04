import AppKit
import SwiftUI

/// Every recording in the library, newest first, as a grid of cards: a click opens the editor, the context menu
/// reveals, exports or moves the recording to the Trash. The list is read on a background queue and again when the
/// library folder changes, so a new recording appears without a refresh.
@MainActor
@Observable
final class LibraryModel {
    private(set) var items: [RecorderMenu.Recent] = []
    private(set) var thumbnails: [URL: NSImage] = [:]
    private(set) var loaded = false
    var filter = ""
    @ObservationIgnored private var watch: DispatchSourceFileSystemObject?
    @ObservationIgnored private var reading = false

    static let thumbnailSize = NSSize(width: 248, height: 155)

    var visible: [RecorderMenu.Recent] {
        let query = filter.trimmingCharacters(in: .whitespaces).lowercased()
        return query.isEmpty ? items : items.filter { $0.title.lowercased().contains(query) || $0.folder.lastPathComponent.contains(query) }
    }

    func load() {
        guard !reading else { return }
        reading = true
        let folder = RecorderMenu.libraryFolder
        let known = Set(thumbnails.keys)
        DispatchQueue.global(qos: .userInitiated).async {
            let span = HubPerf.begin("recorder.library.read", folder.path)
            let list = RecorderMenu.readRecents(folder)
            var images: [URL: NSImage] = [:]
            for item in list {
                guard let url = item.thumbnail, !known.contains(url) else { continue }
                if let image = RecorderMenu.thumbnail(url, size: Self.thumbnailSize, radius: 8) { images[url] = image }
            }
            span.end()
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    self.reading = false
                    self.loaded = true
                    self.thumbnails.merge(images) { $1 }
                    self.items = list
                }
            }
        }
    }

    /// Reads the list again when a recording folder appears or goes.
    func startWatching() {
        guard watch == nil else { return }
        try? FileManager.default.createDirectory(at: RecorderMenu.libraryFolder, withIntermediateDirectories: true)
        let descriptor = open(RecorderMenu.libraryFolder.path, O_EVTONLY)
        guard descriptor >= 0 else { return }
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: descriptor, eventMask: [.write, .delete, .rename], queue: .main)
        source.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.load() } }
        source.setCancelHandler { close(descriptor) }
        source.resume()
        watch = source
    }

    func stopWatching() {
        watch?.cancel()
        watch = nil
    }

    func moveToTrash(_ item: RecorderMenu.Recent) {
        let alert = NSAlert()
        alert.messageText = "Move “\(item.title)” to the Trash?"
        alert.informativeText = "The whole recording folder goes: the movie, its edit and its frames. You can put it back from the Trash."
        alert.addButton(withTitle: "Move to Trash")
        alert.addButton(withTitle: "Cancel")
        alert.buttons.first?.hasDestructiveAction = true
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        NSWorkspace.shared.recycle([item.folder]) { [weak self] _, error in
            MainActor.assumeIsolated {
                if let error { HubPerf.log("recorder.library: trash \(item.folder.path) failed: \(error.localizedDescription)") }
                self?.load()
            }
        }
    }
}

struct LibraryView: View {
    @Bindable var model: LibraryModel
    private let columns = [GridItem(.adaptive(minimum: 248, maximum: 320), spacing: 18)]

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Text("Recordings").font(.system(size: 17, weight: .semibold))
                Text(verbatim: Plural.count(model.items.count, "recording")).font(.system(size: 12.5)).foregroundStyle(RecorderPalette.dim)
                Spacer()
                TextField("Filter by title", text: $model.filter)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 220)
                    .accessibilityIdentifier("recorder.library.filter")
                IconButton(systemName: "folder", tooltip: "Open the recordings folder in Finder", size: 13) {
                    PathOpener.finder(RecorderMenu.libraryFolder.path)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 14)
            .padding(.bottom, 12)
            Divider().overlay(RecorderPalette.hairline)
            if model.loaded && model.visible.isEmpty {
                EmptyState(symbol: "film.stack", text: model.items.isEmpty ? "No recordings yet" : "No recording matches “\(model.filter)”",
                           detail: model.items.isEmpty ? "Record the screen from the menu bar item, or run tools recorder start." : nil)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVGrid(columns: columns, alignment: .leading, spacing: 18) {
                        ForEach(model.visible, id: \.folder) { item in
                            LibraryCard(item: item, thumbnail: item.thumbnail.flatMap { model.thumbnails[$0] }) {
                                EditorWindows.shared.open(path: item.folder.path)
                            } trash: {
                                model.moveToTrash(item)
                            }
                        }
                    }
                    .padding(20)
                }
            }
        }
        .background(RecorderPalette.window)
        .preferredColorScheme(.dark)
    }
}

private struct LibraryCard: View {
    let item: RecorderMenu.Recent
    let thumbnail: NSImage?
    let open: () -> Void
    let trash: () -> Void

    var body: some View {
        // Live only under the pointer: a library of 100 cards keeps no 100 responders at rest.
        LiveButton(tooltip: item.folder.lastPathComponent, pressable: true, action: open) {
            VStack(alignment: .leading, spacing: 8) {
                ZStack(alignment: .bottomTrailing) {
                    Group {
                        if let thumbnail {
                            Image(nsImage: thumbnail).resizable().aspectRatio(contentMode: .fill)
                        } else {
                            RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.white.opacity(0.06))
                                .overlay(Image(systemName: "video").font(.system(size: 22)).foregroundStyle(RecorderPalette.dim))
                        }
                    }
                    .frame(height: 155)
                    .frame(maxWidth: .infinity)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    if let ms = item.durationMs {
                        Text(verbatim: formatClock(Int64(ms * 1000), tenths: false))
                            .font(.system(size: 11, weight: .semibold).monospacedDigit())
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Capsule().fill(Color.black.opacity(0.7)))
                            .padding(6)
                    }
                }
                Text(item.title).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                HStack(spacing: 6) {
                    LiveAgo(date: item.started, style: .brief)
                        .font(.system(size: 11.5)).foregroundStyle(RecorderPalette.dim)
                    if item.edited { Badge("Edited", tooltip: "This recording has an edit (edit.json)") }
                    if !item.hasMovie { Badge("Frames", tooltip: "Frames only: the editor makes a movie of them first") }
                }
            }
            .contentShape(Rectangle())
        }
        .accessibilityLabel("\(item.title), \(item.edited ? "edited" : "not edited")")
        .contextMenu {
            Button("Open in Editor", action: open)
            Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([item.folder]) }
            Divider()
            Button("Move to Trash…", role: .destructive, action: trash)
        }
        .contentShape(Rectangle())
        .liveRow()
    }
}


@MainActor
final class LibraryWindow: NSObject, NSWindowDelegate {
    static let shared = LibraryWindow()
    private var window: NSWindow?
    let model = LibraryModel()

    func show(focus: Bool) {
        let window = window ?? Self.makeWindow(model: model, size: NSSize(width: 1100, height: 720))
        window.delegate = self
        self.window = window
        model.load()
        model.startWatching()
        if focus {
            NSApp.setActivationPolicy(.regular)
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
        } else {
            window.orderBack(nil)
        }
    }

    static func makeWindow(model: LibraryModel, size: NSSize) -> NSWindow {
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Recordings"
        window.minSize = NSSize(width: 620, height: 420)
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = NSColor(white: 0.105, alpha: 1)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: LibraryView(model: model))
        window.setFrameAutosaveName("GenesisToolsRecorderLibrary")
        window.center()
        return window
    }

    func windowWillClose(_ notification: Notification) {
        model.stopWatching()
        // Back to a menu bar app when no other titled window of the recorder stays open.
        let closing = notification.object as? NSWindow
        if !NSApp.windows.contains(where: { $0 !== closing && $0.isVisible && $0.styleMask.contains(.titled) }) {
            NSApp.setActivationPolicy(.accessory)
        }
    }
}

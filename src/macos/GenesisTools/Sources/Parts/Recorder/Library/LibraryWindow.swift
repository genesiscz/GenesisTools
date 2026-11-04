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
    /// Frames across each movie for the hover scrub, read the first time the pointer rests on its card.
    private(set) var scrubFrames: [URL: [NSImage]] = [:]
    @ObservationIgnored private var scrubbing: Set<URL> = []
    /// Opinionated, so a setting: moving the pointer over a card plays through its movie (on by default).
    static let hoverScrubKey = "recorder.library.hoverScrub"
    static let scrubFrameCount = 12
    private(set) var loaded = false
    var filter = ""
    /// The card the keyboard is on (arrows move it, Return opens it, ⌘⌫ moves it to the Trash).
    var selected: URL?
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
                // The middle of the movie: its first frame is often the same desktop for every recording.
                let middle = (item.durationMs ?? 0) / 2000
                if let image = RecorderMenu.thumbnail(url, size: Self.thumbnailSize, radius: 8, atSeconds: middle) { images[url] = image }
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

    /// Reads `scrubFrameCount` frames spread over the movie, once, on a background queue.
    func loadScrub(_ item: RecorderMenu.Recent) {
        guard item.hasMovie, let movie = item.thumbnail, scrubFrames[movie] == nil, !scrubbing.contains(movie) else { return }
        scrubbing.insert(movie)
        let seconds = max(0.1, (item.durationMs ?? 0) / 1000)
        DispatchQueue.global(qos: .userInitiated).async {
            let span = HubPerf.begin("recorder.library.scrub", movie.lastPathComponent)
            let frames = RecorderMenu.frames(movie, size: Self.thumbnailSize, radius: 8,
                                             at: (0..<Self.scrubFrameCount).map { seconds * (Double($0) + 0.5) / Double(Self.scrubFrameCount) })
            span.end()
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    self.scrubbing.remove(movie)
                    self.scrubFrames[movie] = frames
                }
            }
        }
    }

    /// Asks for a new title and writes it through `tools recorder rename`, the same command the CLI and REPL use.
    func rename(_ item: RecorderMenu.Recent) {
        let alert = NSAlert()
        alert.messageText = "Rename “\(item.title)”"
        alert.informativeText = "The library, the editor window and movies.list() show this title."
        let field = NSTextField(string: item.title)
        field.frame = NSRect(x: 0, y: 0, width: 280, height: 24)
        alert.accessoryView = field
        alert.addButton(withTitle: "Rename")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let title = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, title != item.title else { return }
        ToolsRunner.run(["recorder", "rename", item.folder.path, title]) { [weak self] status, _, stderr in
            if status != 0 { HubPerf.log("recorder.library: rename \(item.folder.path) failed: \(stderr)") }
            self?.load()
        }
    }

    /// Moves the keyboard selection by `delta` cards through the visible list, in the order the sections show it.
    func moveSelection(_ delta: Int) {
        let list = sections.flatMap(\.items)
        guard !list.isEmpty else { return }
        let index = selected.flatMap { folder in list.firstIndex { $0.folder == folder } }
        let next = index.map { min(max(0, $0 + delta), list.count - 1) } ?? 0
        selected = list[next].folder
    }

    var selectedItem: RecorderMenu.Recent? { selected.flatMap { folder in visible.first { $0.folder == folder } } }

    /// The visible recordings by day: Today, Yesterday, then Earlier, each newest first.
    var sections: [(title: String, items: [RecorderMenu.Recent])] {
        let calendar = Calendar.current
        var today: [RecorderMenu.Recent] = [], yesterday: [RecorderMenu.Recent] = [], earlier: [RecorderMenu.Recent] = []
        for item in visible {
            if calendar.isDateInToday(item.started) {
                today.append(item)
            } else if calendar.isDateInYesterday(item.started) {
                yesterday.append(item)
            } else {
                earlier.append(item)
            }
        }
        return [("Today", today), ("Yesterday", yesterday), ("Earlier", earlier)].filter { !$0.1.isEmpty }
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
    @AppStorage(LibraryModel.hoverScrubKey) private var hoverScrub = true
    private let columns = [GridItem(.adaptive(minimum: 248, maximum: 320), spacing: 18)]

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                // The window's title already says "Recordings"; the row carries the count and the filter.
                Text(verbatim: Plural.count(model.items.count, "recording")).font(.system(size: 12.5)).foregroundStyle(RecorderPalette.dim)
                Spacer()
                GhostButton("Record", symbol: "record.circle", tooltip: "Record the screen (the recorder's menu has more ways)",
                            identifier: "recorder.library.record") { RecorderMenu.shared.startRecording(audio: false) }
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
                GeometryReader { geometry in
                // Cards per row, for ↑ and ↓: the grid's adaptive columns at 248 pt with 18 pt gaps inside 20 pt padding.
                let perRow = max(1, Int((geometry.size.width - 40 + 18) / (248 + 18)))
                ScrollViewReader { reader in
                ScrollView {
                    LazyVGrid(columns: columns, alignment: .leading, spacing: 18) {
                        ForEach(model.sections, id: \.title) { section in
                            Section {
                                ForEach(section.items, id: \.folder) { item in
                                    LibraryCard(item: item, thumbnail: item.thumbnail.flatMap { model.thumbnails[$0] },
                                                frames: hoverScrub ? item.thumbnail.flatMap { model.scrubFrames[$0] } : nil,
                                                wantFrames: hoverScrub ? { model.loadScrub(item) } : nil,
                                                selected: model.selected == item.folder) {
                                        EditorWindows.shared.open(path: item.folder.path)
                                    } rename: {
                                        model.rename(item)
                                    } trash: {
                                        model.moveToTrash(item)
                                    }
                                    .id(item.folder)
                                }
                            } header: {
                                HStack(spacing: 6) {
                                    Text(section.title).font(.system(size: 13, weight: .semibold))
                                    Text(verbatim: "\(section.items.count)").font(.system(size: 12).monospacedDigit()).foregroundStyle(RecorderPalette.dim)
                                }
                                .padding(.top, 4)
                                .accessibilityAddTraits(.isHeader)
                            }
                        }
                    }
                    .padding(20)
                }
                .focusable()
                .focusEffectDisabled()
                .onKeyPress(.leftArrow) { model.moveSelection(-1); return .handled }
                .onKeyPress(.rightArrow) { model.moveSelection(1); return .handled }
                .onKeyPress(.upArrow) { model.moveSelection(-perRow); return .handled }
                .onKeyPress(.downArrow) { model.moveSelection(perRow); return .handled }
                .onKeyPress(.return) {
                    guard let item = model.selectedItem else { return .ignored }
                    EditorWindows.shared.open(path: item.folder.path)
                    return .handled
                }
                .onKeyPress(.delete, phases: .down) { press in
                    guard press.modifiers.contains(.command), let item = model.selectedItem else { return .ignored }
                    model.moveToTrash(item)
                    return .handled
                }
                .onChange(of: model.selected) { _, folder in
                    if let folder { withAnimation(.easeOut(duration: 0.15)) { reader.scrollTo(folder) } }
                }
                }
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
    /// The hover scrub's frames (nil until read, or with the setting off) and the call that reads them.
    let frames: [NSImage]?
    let wantFrames: (() -> Void)?
    /// The keyboard's card: a ring in the accent colour.
    let selected: Bool
    let open: () -> Void
    let rename: () -> Void
    let trash: () -> Void
    @State private var scrubAt: Double?
    @State private var cardWidth: CGFloat = 248

    var body: some View {
        // Live only under the pointer: a library of 100 cards keeps no 100 responders at rest.
        LiveButton(tooltip: "Open in the editor", pressable: true, action: open) {
            VStack(alignment: .leading, spacing: 8) {
                ZStack(alignment: .bottomTrailing) {
                    Group {
                        if let frames, !frames.isEmpty, let at = scrubAt {
                            Image(nsImage: frames[min(frames.count - 1, Int(at * Double(frames.count)))])
                                .resizable().aspectRatio(contentMode: .fill)
                        } else if let thumbnail {
                            Image(nsImage: thumbnail).resizable().aspectRatio(contentMode: .fill)
                        } else {
                            RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.white.opacity(0.06))
                                .overlay(Image(systemName: "video").font(.system(size: 22)).foregroundStyle(RecorderPalette.dim))
                        }
                    }
                    .frame(height: 155)
                    .frame(maxWidth: .infinity)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay {
                        if selected {
                            RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(Color.accentColor, lineWidth: 3)
                        }
                    }
                    .overlay(alignment: .bottom) {
                        if frames != nil, let at = scrubAt {
                            GeometryReader { geometry in
                                Capsule().fill(Color.white.opacity(0.85))
                                    .frame(width: max(4, geometry.size.width * at), height: 3)
                            }
                            .frame(height: 3)
                            .padding(.horizontal, 6).padding(.bottom, 4)
                            .allowsHitTesting(false)
                        }
                    }
                    .onContinuousHover { phase in
                        guard let wantFrames else { return }
                        switch phase {
                        case .active(let point):
                            wantFrames()
                            scrubAt = min(max(0, point.x / max(1, cardWidth)), 0.999)
                        case .ended:
                            scrubAt = nil
                        }
                    }
                    .background(GeometryReader { geometry in
                        Color.clear.onAppear { cardWidth = geometry.size.width }
                            .onChange(of: geometry.size.width) { _, width in cardWidth = width }
                    })
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
        .accessibilityLabel("\(item.title), \(item.durationMs.map { formatClock(Int64($0 * 1000)) } ?? "no length"), \(item.edited ? "edited" : "not edited")")
        .accessibilityAddTraits(selected ? .isSelected : [])
        .contextMenu {
            Button("Open in Editor", action: open)
            Button("Rename…", action: rename)
            Divider()
            Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([item.folder]) }
            Button("Copy Folder Path") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(item.folder.path, forType: .string) }
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
        EditorMenu.install()
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

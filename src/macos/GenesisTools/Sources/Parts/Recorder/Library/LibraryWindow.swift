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
    var filter = "" {
        didSet { searchSpoken() }
    }
    /// What was said or marked that matches the filter, the first hit per recording, from `tools recorder search`
    /// (cached transcripts with their fixes, and marker labels).
    private(set) var spoken: [URL: SpokenHit] = [:]
    /// The spoken search is running (the empty state waits for it); `searchFailed` is its last error.
    private(set) var searching = false
    private(set) var searchFailed: String?
    /// The last recording moved to the Trash (where it was, where it went), for Put Back; and the last failure.
    private(set) var trashed: (title: String, from: URL, to: URL)?
    private(set) var failure: String?
    /// The last quick action's short notice ("Copied a GIF…"), shown in a pill that fades.
    private(set) var notice: String?
    @ObservationIgnored private var spokenSearch: DispatchWorkItem?

    struct SpokenHit: Equatable {
        var at: Double
        var text: String
        var marker: Bool
        /// The other moments of the same recording that match, after this first one; and when they are.
        var more: [Double] = []
    }
    /// The card the keyboard is on (arrows move it, Return opens it, ⌘⌫ moves it to the Trash).
    var selected: URL?
    @ObservationIgnored private var watch: DispatchSourceFileSystemObject?
    @ObservationIgnored private var reading = false

    static let thumbnailSize = NSSize(width: 248, height: 155)

    var visible: [RecorderMenu.Recent] {
        let query = filter.trimmingCharacters(in: .whitespaces).lowercased()
        return query.isEmpty ? items : items.filter {
            $0.title.lowercased().contains(query) || $0.folder.lastPathComponent.contains(query) || spoken[$0.folder] != nil
        }
    }

    /// From three letters on, 300 ms after the last key: one `tools recorder search` for the whole library.
    private func searchSpoken() {
        spokenSearch?.cancel()
        let query = filter.trimmingCharacters(in: .whitespaces)
        guard query.count >= 3 else {
            if !spoken.isEmpty { spoken = [:] }
            searching = false
            searchFailed = nil
            return
        }
        searching = true
        let work = DispatchWorkItem { [weak self] in
            let span = HubPerf.begin("recorder.library.search", query)
            ToolsRunner.run(["recorder", "search", query, "--json"]) { status, stdout, stderr in
                span.end()
                guard let self, self.filter.trimmingCharacters(in: .whitespaces) == query else { return }
                self.searching = false
                guard status == 0, let data = stdout.data(using: .utf8),
                      let rows = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
                    let reason = stderr.split(separator: "\n").last.map(String.init) ?? "exit \(status)"
                    HubPerf.log("recorder.library.search failed: \(reason)")
                    self.searchFailed = reason
                    return
                }
                self.searchFailed = nil
                var hits: [URL: SpokenHit] = [:]
                for row in rows {
                    guard let kind = row["kind"] as? String, kind != "title", let folder = row["folder"] as? String,
                          let text = row["text"] as? String else { continue }
                    let url = URL(fileURLWithPath: folder)
                    let at = (row["at"] as? NSNumber)?.doubleValue ?? 0
                    if hits[url] == nil {
                        hits[url] = SpokenHit(at: at, text: text, marker: kind == "marker")
                    } else {
                        hits[url]?.more.append(at)
                    }
                }
                HubPerf.log("recorder.library.search \"\(query)\": \(hits.count) recordings by what was said or marked")
                self.spoken = hits
            }
        }
        spokenSearch = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: work)
    }

    func load() {
        guard !reading else { return }
        reading = true
        let folders = RecorderMenu.recordingFolders
        let known = Set(thumbnails.keys)
        DispatchQueue.global(qos: .userInitiated).async {
            let span = HubPerf.begin("recorder.library.read", folders.map(\.path).joined(separator: ", "))
            let list = RecorderMenu.readRecents(folders)
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

    func rename(_ item: RecorderMenu.Recent) {
        RecordingActions.run(.rename, item) { [weak self] in self?.handle($0) }
    }

    /// What a quick action did: a notice that fades, a failure strip, or the Put Back strip after a move to the Trash.
    func handle(_ outcome: RecordingActions.Outcome) {
        switch outcome {
        case let .working(text), let .notice(text):
            notice = text
        case let .failed(text):
            failure = text
        case let .trashed(from, to):
            let title = items.first { $0.folder == from }?.title ?? from.lastPathComponent
            trashed = (title, from, to)
            if selected == from { selected = nil }
            load()
        case .renamed:
            load()
        }
    }

    func dismissFailure() { failure = nil }
    func dismissNotice() { notice = nil }
    func dismissTrashed() { trashed = nil }

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

    /// As Finder does: no question, the Trash is the undo; the strip under the header puts it back (⌘Z too).
    func moveToTrash(_ item: RecorderMenu.Recent) {
        RecordingActions.run(.trash, item) { [weak self] in self?.handle($0) }
    }

    /// Moves the last trashed recording back to its folder.
    func putBack() {
        guard let trashed else { return }
        do {
            try FileManager.default.moveItem(at: trashed.to, to: trashed.from)
            self.trashed = nil
            selected = trashed.from
        } catch {
            HubPerf.log("recorder.library: put back \(trashed.from.path) failed: \(error.localizedDescription)")
            failure = "“\(trashed.title)” could not be put back: \(error.localizedDescription). It is still in the Trash."
        }
        load()
    }
}

struct LibraryView: View {
    @Bindable var model: LibraryModel
    @AppStorage(LibraryModel.hoverScrubKey) private var hoverScrub = true
    @FocusState private var searchFocused: Bool
    // Top-aligned, so a card with a search hit under its title keeps its picture in line with the others.
    private let columns = [GridItem(.adaptive(minimum: 248, maximum: 320), spacing: 18, alignment: .top)]

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                // The window's title already says "Recordings"; the row carries the count and the filter.
                Text(verbatim: model.filter.trimmingCharacters(in: .whitespaces).isEmpty
                     ? Plural.count(model.items.count, "recording")
                     : "\(model.visible.count) of \(Plural.count(model.items.count, "recording"))")
                    .font(.system(size: 12.5).monospacedDigit()).foregroundStyle(RecorderPalette.dim)
                Spacer()
                GhostButton("Record", symbol: "record.circle", tooltip: "Record the screen (the recorder's menu has more ways)",
                            identifier: "recorder.library.record") { RecorderMenu.shared.startRecording(audio: false) }
                HStack(spacing: 4) {
                    Image(systemName: "magnifyingglass").foregroundStyle(RecorderPalette.dim).font(.system(size: 12))
                    TextField("Search titles, speech and markers", text: $model.filter)
                        .textFieldStyle(.plain)
                        .focused($searchFocused)
                        .onExitCommand { model.filter = "" }
                        .accessibilityIdentifier("recorder.library.filter")
                        .background {
                            // ⌘F puts the keyboard in the search field, as in Finder and Photos.
                            Button("Find") { searchFocused = true }
                                .keyboardShortcut("f", modifiers: .command)
                                .opacity(0).frame(width: 0, height: 0)
                                .accessibilityHidden(true)
                        }
                    if model.searching {
                        ProgressView().controlSize(.small).accessibilityLabel("Searching what was said")
                    } else if !model.filter.isEmpty {
                        IconButton(systemName: "xmark.circle.fill", tooltip: "Clear the search (Esc)", size: 12) { model.filter = "" }
                    }
                }
                // A fixed height, so the clear button or the spinner never grows the header and moves the grid.
                .frame(height: 18)
                .padding(.horizontal, 8).padding(.vertical, 5)
                .background(RoundedRectangle(cornerRadius: 7).fill(Color.white.opacity(0.06)))
                .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(Color.white.opacity(0.12)))
                .frame(width: 260)

                IconButton(systemName: "folder", tooltip: "Open the recordings folder in Finder", size: 13) {
                    PathOpener.finder(RecorderMenu.libraryFolder.path)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 14)
            .padding(.bottom, 12)
            Divider().overlay(RecorderPalette.hairline)
            if let failed = model.searchFailed {
                InfoStrip("The search of what was said failed: \(failed). Titles still match.", tone: .warning)
                    .padding(.horizontal, 20).padding(.top, 8)
            }
            if let failure = model.failure {
                InfoStrip(failure, tone: .warning, dismiss: { model.dismissFailure() })
                    .padding(.horizontal, 20).padding(.top, 8)
            }
            if let notice = model.notice {
                NoticePill(text: notice, isError: false, dismiss: { model.dismissNotice() })
                    .padding(.top, 8)
                    .id(notice)
            }
            if let trashed = model.trashed {
                InfoStrip("Moved “\(trashed.title)” to the Trash. Click here or press ⌘Z to put it back.", tone: .info,
                          symbol: "arrow.uturn.backward", action: { model.putBack() }, actionTooltip: "Put it back where it was",
                          dismiss: { model.dismissTrashed() })
                    .padding(.horizontal, 20).padding(.top, 8)
                    .background {
                        Button("Put Back") { model.putBack() }
                            .keyboardShortcut("z", modifiers: .command)
                            .opacity(0).frame(width: 0, height: 0)
                            .accessibilityHidden(true)
                    }
            }
            if model.loaded && model.visible.isEmpty {
                VStack(spacing: 10) {
                    EmptyState(symbol: model.searching ? "magnifyingglass" : "film.stack",
                               text: model.items.isEmpty ? "No recordings yet"
                                   : (model.searching ? "Searching what was said…" : "No recording matches “\(model.filter)”"),
                               detail: model.items.isEmpty ? "A recording shows here as soon as it stops." : nil)
                        .fixedSize(horizontal: false, vertical: true)
                    if model.items.isEmpty {
                        GhostButton("Record the Screen", symbol: "record.circle", tooltip: "Start a recording of the screen",
                                    identifier: "recorder.library.recordEmpty") { RecorderMenu.shared.startRecording(audio: false) }
                    }
                    if !model.items.isEmpty && !model.searching {
                        GhostButton("Clear Search", symbol: "xmark.circle", tooltip: "Show every recording again",
                                    identifier: "recorder.library.clearSearch") { model.filter = "" }
                    }
                }
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
                                    LibraryCard(item: item, spoken: model.spoken[item.folder], thumbnail: item.thumbnail.flatMap { model.thumbnails[$0] },
                                                frames: hoverScrub ? item.thumbnail.flatMap { model.scrubFrames[$0] } : nil,
                                                wantFrames: hoverScrub ? { model.loadScrub(item) } : nil,
                                                selected: model.selected == item.folder) {
                                        // A search hit opens at the moment it found.
                                        RecorderMenu.open(item, atSourceSeconds: model.spoken[item.folder]?.at)
                                    } select: {
                                        model.selected = item.folder
                                    } report: { model.handle($0) }
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
                    RecorderMenu.open(item, atSourceSeconds: model.spoken[item.folder]?.at)
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

struct LibraryCard: View {
    let item: RecorderMenu.Recent
    /// What matched the search in what was said or marked, shown under the title.
    let spoken: LibraryModel.SpokenHit?
    let thumbnail: NSImage?
    /// The hover scrub's frames (nil until read, or with the setting off) and the call that reads them.
    let frames: [NSImage]?
    let wantFrames: (() -> Void)?
    /// The keyboard's card: a ring in the accent colour.
    let selected: Bool
    let open: () -> Void
    /// A click selects (⌘⌫ then trashes it, Return opens it); a double-click opens, as in Finder and Photos.
    let select: () -> Void
    /// A quick action's outcome (RecordingActions.swift), for the library's notice and strips.
    let report: (RecordingActions.Outcome) -> Void
    @State private var scrubAt: Double?
    @State private var cardWidth: CGFloat = 248

    var body: some View {
        // Live only under the pointer: a library of 100 cards keeps no 100 responders at rest.
        LiveButton(tooltip: "Click to select, double-click to open in the editor", pressable: true, action: select) {
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
                if let spoken {
                    HStack(spacing: 4) {
                        Image(systemName: spoken.marker ? "flag.fill" : "quote.bubble")
                        Text(verbatim: "\(formatClock(Int64(spoken.at * 1_000_000))) \(spoken.text)").lineLimit(2)
                        if !spoken.more.isEmpty {
                            Text(verbatim: "+\(spoken.more.count)")
                                .font(.system(size: 10.5, weight: .semibold).monospacedDigit())
                                .padding(.horizontal, 5).padding(.vertical, 1)
                                .background(Capsule().fill(Color.white.opacity(0.1)))
                                .instantTooltip("Also at " + spoken.more.prefix(8).map { formatClock(Int64($0 * 1_000_000)) }.joined(separator: ", ")
                                                + (spoken.more.count > 8 ? " and \(spoken.more.count - 8) more" : ""))
                        }
                    }
                    .font(.system(size: 11.5)).foregroundStyle(RecorderPalette.dim)
                    .accessibilityLabel("\(spoken.marker ? "Marker" : "Said") at \(formatClock(Int64(spoken.at * 1_000_000))): \(spoken.text)")
                    .instantTooltip("Opens at \(formatClock(Int64(spoken.at * 1_000_000)))")
                }
                HStack(spacing: 6) {
                    LiveAgo(date: item.started, style: .brief)
                        .font(.system(size: 11.5)).foregroundStyle(RecorderPalette.dim)
                    if item.edited { Badge("Edited", tooltip: "This recording has an edit (edit.json)") }
                    if item.openComments > 0 {
                        Badge(Plural.count(item.openComments, "comment"),
                              tooltip: "Review comments not resolved yet; right-click → Open at First Comment")
                    }
                    if !item.hasMovie { Badge("Frames", tooltip: "Frames only: the editor makes a movie of them first") }
                }
            }
            .contentShape(Rectangle())
        }
        .accessibilityLabel("\(item.title), \(item.durationMs.map { formatClock(Int64($0 * 1000)) } ?? "no length"), \(item.edited ? "edited" : "not edited")")
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityAction(named: "Open in Editor", open)
        .simultaneousGesture(TapGesture(count: 2).onEnded { open() })
        // Drag the movie into a chat, a mail or an issue: the newest export, else the recording itself.
        .onDrag {
            guard let movie = RecordingMovie.shareable(in: item.folder) else { return NSItemProvider() }
            return NSItemProvider(contentsOf: movie) ?? NSItemProvider()
        }
        .contextMenu { RecordingActionsMenu(item: item, report: report) }
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

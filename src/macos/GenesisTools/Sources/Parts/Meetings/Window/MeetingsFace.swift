import AppKit
import SwiftUI

// GenesisTools --meetings [--place needs|all|project:<name>] [--meeting <id>] [--tab transcript|screen|items|speakers|context] [--no-focus] [--muted]
//   The Meetings window: meetings by day with what each needs, one meeting with its transcript, screen, items,
//   speakers and context, the meetings that need you, and each project. One per login session: a later launch hands
//   its request to the running one and exits. `--muted` starts a window whose Moments play without sound (a check
//   of the running window on a Mac that must stay quiet).
// GenesisTools --meetings … --snapshot <png> [--width <pt>] [--height <pt>] [--play <target json>] [--place contacts]
//                         [--side-panel] [--select <row id>] [--edit <row id>] [--notice <text>]
//   Draws the window off screen into a PNG once its data has loaded, then exits (verification without a screen).
//   `--select` selects a review row of the Items tab (its number keys show) and `--edit` opens its editor, so a
//   picture can show the states that a click or a key makes. `--notice <text>` floats a notice with an Undo over the
//   meeting, as an answer or a Skip leaves one.
//   `--card <row id>` draws that row's pin card alone, and `--sheet history` (or `history:<row id>`) the history
//   sheet alone: a popover and a sheet are windows of their own, which the window's picture does not hold.
//   `--play '{"kind":"item","id":"i2"}'` (a Moment target as the engine writes it) starts that Moment of the meeting
//   without sound first, so the picture shows the dock, the timeline and the playing row.

private let meetingsInstance = SingleInstance(
    name: "meetings",
    lockFile: NativePreview.hubFile("meetings.lock"),
    notificationPrefix: meetingsNotificationPrefix(),
    retryHint: "close the Meetings window, then try again.",
    log: { HubPerf.log($0) }
)

/// The names of the forwarded request and its answer. They are distributed notifications, which every process of the
/// login session sees, while the lock is per home: a window started on a sandbox (`GENESIS_TOOLS_HOME`) followed every
/// `tools meetings window` request meant for the real window. A sandbox home carries its path in the name; the real
/// home keeps the old name, so a window from an older build still takes the request.
func meetingsNotificationPrefix(home: String = GenesisToolsHome.home(), realHome: String = NSHomeDirectory()) -> String {
    let base = NativePreview.namespace + ".meetings"
    let canonical = canonicalHome(home)
    return canonical == canonicalHome(realHome) ? base : base + ".home:" + canonical
}

/// A home as one spelling: a trailing slash, `.` and `..` parts and symlinks (`/tmp` is `/private/tmp`) name the same
/// folder, so they give the same notification name and a later launch reaches the window that holds the lock.
func canonicalHome(_ path: String) -> String {
    URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath().path
}

struct MeetingsRequest {
    var place: MeetingsWindowModel.Place?
    var meeting: String?
    var tab: MeetingDetailModel.Tab?
    var focus = true
    var newWindow = false
    /// `--muted`: the window's Moments play without sound.
    var muted = false
    /// `--side-panel`: the settings side panel opens beside the meeting.
    var sidePanel = false
    var snapshot: String?
    /// `--play <target json>`: the Moment a snapshot starts, silently, before the picture.
    var play: MomentTarget?
    /// A routed Moment with all per-call playback options preserved.
    var playRequest: MeetingsAPI.MomentParams?
    /// `--show <from>,<to>`: a snapshot of what a "Show" chip does: the whole meeting plays from `from`, silently, and
    /// the timeline shows the range.
    var show: ClosedRange<Double>?
    /// `--zoom-to <from>,<to>` (repeatable): a snapshot's zoom levels, as clicks on merged pins add them.
    var zoomTo: [ClosedRange<Double>] = []
    /// `--select <row id>` and `--edit <row id>`: a snapshot's selected review row, and the row whose editor is open.
    var select: String?
    var edit: String?
    /// `--notice <text>`: a notice with an Undo, as an answer leaves one.
    var notice: String?
    /// `--card <row id>` and `--sheet history[:<row id>]`: a snapshot of that part alone.
    var card: String?
    var sheet: String?
    var width: CGFloat = 1280
    var height: CGFloat = 820

    static func parse(_ args: [String]) -> MeetingsRequest {
        var request = MeetingsRequest()
        var index = 0
        func value() -> String? {
            guard index + 1 < args.count else { return nil }
            index += 1
            return args[index]
        }
        while index < args.count {
            switch args[index] {
            case "--place":
                switch value() ?? "" {
                case "needs": request.place = .needs
                case "all": request.place = .all
                case "contacts": request.place = .contacts
                case let other where other.hasPrefix("project:"): request.place = .project(String(other.dropFirst(8)))
                default: break
                }
            case "--meeting": request.meeting = value()
            case "--new-window": request.newWindow = true
            case "--tab": request.tab = value().flatMap(MeetingDetailModel.Tab.init(rawValue:))
            case "--no-focus", "--no-activate": request.focus = false
            case "--muted": request.muted = true
            case "--side-panel": request.sidePanel = true
            case "--select": request.select = value()
            case "--edit": request.edit = value()
            case "--notice": request.notice = value()
            case "--card": request.card = value()
            case "--sheet": request.sheet = value()
            case "--snapshot": request.snapshot = value().map { URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath).path }
            case "--play": request.play = value().flatMap { try? JSONDecoder().decode(MomentTarget.self, from: Data($0.utf8)) }
            case "--play-request": request.playRequest = value().flatMap { try? JSONDecoder().decode(MeetingsAPI.MomentParams.self, from: Data($0.utf8)) }
            case "--show": request.show = value().flatMap(MeetingsRequest.range)
            case "--zoom-to": if let range = value().flatMap(MeetingsRequest.range) { request.zoomTo.append(range) }
            case "--width": request.width = value().flatMap(Double.init).map { CGFloat($0) } ?? request.width
            case "--height": request.height = value().flatMap(Double.init).map { CGFloat($0) } ?? request.height
            default: break
            }
            index += 1
        }
        return request
    }

    /// "2926,5220" as seconds; nil for anything else.
    static func range(_ text: String) -> ClosedRange<Double>? {
        let parts = text.split(separator: ",").compactMap { Double($0) }
        guard parts.count == 2, parts[1] > parts[0] else { return nil }
        return parts[0]...parts[1]
    }
}

package func runMeetings(_ args: [String]) -> Never {
    let request = MeetingsRequest.parse(args)
    if let snapshot = request.snapshot {
        runMeetingsSnapshot(request, to: snapshot)
    }
    if !meetingsInstance.claim() {
        exit(meetingsInstance.forward(args) ? 0 : 1)
    }
    MainActor.assumeIsolated {
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        MeetingsMenuTarget.shared.model = MeetingsWindow.shared.model
        MeetingsMenu.install()
        HangWatch.start()
        meetingsInstance.serve { forwarded in
            let next = MeetingsRequest.parse(forwarded)
            MainActor.assumeIsolated {
                if next.newWindow { MeetingsWindow.openExtra(request: next) }
                else { MeetingsWindow.shared.show(next) }
            }
        }
        MeetingsWindow.shared.show(request)
        app.run()
    }
    exit(0)
}

@MainActor
final class MeetingsWindow: NSObject, NSWindowDelegate {
    static let shared = MeetingsWindow(primary: true)
    /// The windows "Open in New Window" made: each has its own model, so two meetings show side by side.
    private static var extras: [MeetingsWindow] = []
    /// The first window keeps the saved frame and answers forwarded requests; an extra one cascades from the key window.
    let primary: Bool
    private var window: NSWindow?
    let model = MeetingsWindowModel()

    init(primary: Bool) {
        self.primary = primary
    }

    /// Opens `meeting` in a new window of its own, offset from the key window, so the reader can put the two side by side.
    static func openExtra(meeting: String) {
        var request = MeetingsRequest()
        request.meeting = meeting
        openExtra(request: request)
    }

    static func openExtra(request: MeetingsRequest) {
        let face = MeetingsWindow(primary: false)
        extras.append(face)
        let source = NSApp.keyWindow
        face.show(request)
        if let source, let window = face.window {
            window.setFrame(source.frame, display: false)
            window.setFrameTopLeftPoint(window.cascadeTopLeft(from: NSPoint(x: source.frame.minX, y: source.frame.maxY)))
        }
    }

    func show(_ request: MeetingsRequest) {
        let window = window ?? Self.makeWindow(model: model, size: NSSize(width: request.width, height: request.height))
        if self.window == nil {
            window.delegate = self
            if primary { window.setFrameAutosaveName("GenesisToolsMeetings") }
            self.window = window
            model.load()
        }
        apply(request, to: model)
        if request.focus {
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
        } else {
            window.orderBack(nil)
        }
    }

    func apply(_ request: MeetingsRequest, to model: MeetingsWindowModel) {
        if request.muted {
            model.player.stop()
            model.player = MomentPlayer(load: { try AVMomentSound(url: $0, muted: true) }, defaults: model.defaults)
        }
        if let place = request.place { model.go(place) }
        if request.sidePanel { model.sidePanelOpen = true }
        if let meeting = request.meeting {
            model.select(meeting, tab: request.tab)
        } else if let tab = request.tab {
            model.detail?.show(tab)
        }
        if let play = request.playRequest {
            model.player.play(play, from: .link)
        }
    }

    /// The smallest window the layout is made for (the detail column narrows its header and tabs to fit it).
    static let minimumSize = NSSize(width: 900, height: 560)

    /// The hosting view sets the window's minimum back to zero as it lays out, so `minSize` alone let the window
    /// shrink until the detail column was cut off. The delegate holds the floor on every live resize.
    static func floored(_ size: NSSize) -> NSSize {
        NSSize(width: max(size.width, minimumSize.width), height: max(size.height, minimumSize.height))
    }

    func windowWillResize(_ sender: NSWindow, to frameSize: NSSize) -> NSSize { Self.floored(frameSize) }

    /// A window that holds one part at its own size, for a snapshot of a popover or a sheet.
    static func partWindow(_ part: AnyView) -> NSWindow {
        let hosting = NSHostingView(rootView: part.background(Color(nsColor: .windowBackgroundColor)).environment(\.colorScheme, .dark))
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: hosting.fittingSize), styleMask: [.borderless],
                              backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: .darkAqua)
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        return window
    }

    static func makeWindow(model: MeetingsWindowModel, size: NSSize) -> NSWindow {
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Meetings"
        window.appearance = NSAppearance(named: .darkAqua)
        window.isReleasedWhenClosed = false
        let hosting = NSHostingView(rootView: MeetingsRootView(model: model))
        // The window keeps the size the reader gives it, and `minimumSize` is its only floor: with the default options,
        // and still with `.minSize`, each notice grew the window to the content's height (900 to 1982 pt in one session).
        hosting.sizingOptions = []
        window.contentView = hosting
        window.minSize = minimumSize
        window.center()
        return window
    }

    func windowDidBecomeKey(_ notification: Notification) {
        // The menu bar and the playback keys act on the window in front.
        MeetingsMenuTarget.shared.model = model
        // A meeting changed elsewhere (a confirm in a terminal, a new recording) shows when the window comes back.
        if case .loaded = model.overview { model.refreshAfterReturn() }
    }

    func windowDidChangeOcclusionState(_ notification: Notification) {
        // A live meeting refreshes only while the window can be seen (MeetingsWindowModel.windowVisible).
        model.windowVisible = (notification.object as? NSWindow)?.occlusionState.contains(.visible) ?? true
    }

    /// ⌘Z and Edit → Undo go to the window's undo manager; with no text field in focus it presses the newest notice's
    /// Undo (G39), and in a field it is the field's own undo.
    private lazy var noticeUndoManager = MeetingsUndoManager(model: model)

    func windowWillReturnUndoManager(_ window: NSWindow) -> UndoManager? {
        noticeUndoManager.window = window
        return noticeUndoManager
    }

    /// The last window closed ends the process, as the hub's window does. An extra window stops its sound and its
    /// listener; the first window stays made, so a forwarded request opens it again.
    func windowWillClose(_ notification: Notification) {
        if !primary {
            model.player.stop()
            model.detail?.cancelReads()
            model.detachLiveUpdates()
            Self.extras.removeAll { $0 === self }
            if MeetingsMenuTarget.shared.model === model { MeetingsMenuTarget.shared.model = Self.shared.model }
        }
        let others = ([Self.shared] + Self.extras).filter { $0 !== self && $0.window?.isVisible == true }
        if others.isEmpty { NSApp.terminate(nil) }
    }
}

/// A part of the window drawn alone for a snapshot (`--card`, `--sheet`), with its data read first.
@MainActor
private func meetingsSnapshotPart(_ request: MeetingsRequest, model: MeetingsWindowModel) async -> AnyView? {
    guard let detail = model.detail else { return nil }
    if let id = request.card {
        if case .idle = detail.rows { detail.loadRows() }
        _ = await waitUntil(60) { detail.rows.value != nil || detail.rows.failure != nil }
        let rows = detail.rows.value?.rows ?? []
        return rows.first { $0.id == id }.map { row in
            AnyView(PinCard(row: row, reference: { id in rows.first { $0.id == id }.map(ReviewRowView.reference) }))
        }
    }
    if let sheet = request.sheet, sheet == "history" || sheet.hasPrefix("history:") {
        if case .idle = detail.rows { detail.loadRows() }
        _ = await waitUntil(60) { detail.rows.value != nil || detail.rows.failure != nil }
        detail.openHistory(item: sheet.hasPrefix("history:") ? String(sheet.dropFirst(8)) : nil)
        _ = await waitUntil(30) { detail.history?.entries.value != nil || detail.history?.entries.failure != nil }
        return detail.history.map { AnyView(HistorySheetView(detail: detail, history: $0)) }
    }
    return nil
}

/// Waits (up to `seconds`) until `ready` holds, checking every 100 ms; a snapshot needs the data on screen.
@MainActor
func waitUntil(_ seconds: Double, _ ready: () -> Bool) async -> Bool {
    var waited = 0.0
    while !ready(), waited < seconds {
        try? await Task.sleep(for: .milliseconds(100))
        waited += 0.1
    }
    return ready()
}

private func runMeetingsSnapshot(_ request: MeetingsRequest, to path: String) -> Never {
    MainActor.assumeIsolated {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        Task {
            let model = MeetingsWindowModel()
            // A picture with the panel open must not change what the real window opens with.
            model.remembersPanel = false
            // A picture of a playing Moment (`--play`) makes no sound.
            model.player = MomentPlayer(load: { try AVMomentSound(url: $0, muted: true) }, defaults: model.defaults)
            // The requested meeting is the selection before the list lands, so the list's first meeting is never read
            // for nothing; the request applies once the list is there, so a recording-only meeting opens on Screen.
            model.selectedMeetingID = request.meeting
            model.load()
            guard await waitUntil(40, { model.overview.value != nil || model.overview.failure != nil }) else {
                FileHandle.standardError.write(Data("meetings snapshot timed out loading overview\n".utf8))
                exit(1)
            }
            MeetingsWindow.shared.apply(request, to: model)
            if let detail = model.detail {
                let ready = await waitUntil(60) {
                    let tabReady: Bool
                    switch detail.tab {
                    case .transcript: tabReady = detail.transcript.value != nil || detail.transcript.failure != nil
                    case .screen: tabReady = detail.timeline.value != nil || detail.timeline.failure != nil
                    case .speakers: tabReady = detail.speakers.value != nil || detail.speakers.failure != nil
                    case .items, .context: tabReady = true
                    }
                    return tabReady && (detail.record.value != nil || detail.record.failure != nil)
                }
                guard ready else {
                    FileHandle.standardError.write(Data("meetings snapshot timed out loading detail \(detail.tab)\n".utf8))
                    exit(1)
                }
            }
            if model.place == .contacts {
                _ = await waitUntil(30) { model.people.known.value != nil || model.people.known.failure != nil }
            }
            if let detail = model.detail, detail.tab == .items {
                // The rows are read when the tab shows; a picture taken before they land shows "Reading the items…".
                if case .idle = detail.rows { detail.loadRows() }
                _ = await waitUntil(60) { detail.rows.value != nil || detail.rows.failure != nil }
                if let id = request.edit, let row = detail.rows.value?.rows.first(where: { $0.id == id }) {
                    detail.selectedRow = id
                    detail.edit(row)
                } else if let id = request.select {
                    detail.selectedRow = id
                }
            }
            if let text = request.notice, let detail = model.detail {
                detail.notices.push(StackedNotice(text: text, actions: [.undo { _ in }]))
            }
            if let target = request.play {
                guard let meeting = model.detail?.id else {
                    FileHandle.standardError.write(Data("meetings snapshot: --play needs --meeting\n".utf8))
                    exit(1)
                }
                model.player.play(target, in: meeting, from: .row)
                guard await waitUntil(60, { model.player.phase == .playing || model.player.isFailed }) else {
                    FileHandle.standardError.write(Data("meetings snapshot timed out cutting the Moment\n".utf8))
                    exit(1)
                }
                // A failed cut is pictured too (its pill is part of what the dock shows); stderr names it.
                if case .failed(let failure) = model.player.phase {
                    FileHandle.standardError.write(Data("meetings snapshot: the Moment did not play: \(failure.sentence)\n".utf8))
                }
            }
            if let range = request.show {
                guard let meeting = model.detail?.id else {
                    FileHandle.standardError.write(Data("meetings snapshot: --show needs --meeting\n".utf8))
                    exit(1)
                }
                model.player.showMeeting(meeting, from: range.lowerBound)
                model.player.timeline.showView(range, layer: model.player.top?.id)
                guard await waitUntil(60, { model.player.phase == .playing || model.player.isFailed }) else {
                    FileHandle.standardError.write(Data("meetings snapshot timed out starting the meeting\n".utf8))
                    exit(1)
                }
            }
            for range in request.zoomTo {
                model.player.timeline.pushView(range, layer: model.player.top?.id)
            }
            if request.play != nil || request.show != nil, let detail = model.detail {
                // The dock's waveform has the speakers' colours, which it reads after it shows.
                if case .idle = detail.speakers { detail.loadSpeakers() }
                _ = await waitUntil(60) { detail.speakers.value != nil || detail.speakers.failure != nil }
            }
            if model.sidePanelOpen {
                _ = await waitUntil(30) { model.settingsRaw != nil || model.settings.failure != nil }
            }
            let window: NSWindow
            if request.card != nil || request.sheet != nil {
                guard let part = await meetingsSnapshotPart(request, model: model) else {
                    FileHandle.standardError.write(Data("meetings snapshot: no such part (--card needs a row id of --meeting, --sheet takes history or history:<row id>)\n".utf8))
                    exit(1)
                }
                window = MeetingsWindow.partWindow(part)
            } else {
                window = MeetingsWindow.makeWindow(model: model, size: NSSize(width: request.width, height: request.height))
            }
            window.orderInForSnapshot()
            try? await Task.sleep(for: .milliseconds(900))
            if request.card == nil, request.sheet == nil, let top = model.player.top {
                // The dock reads its waveform once it shows, after the reads the window sent before it (the service
                // answers in order): a picture taken before they land showed a timeline without a waveform.
                let dock = model.player.timeline
                if await waitUntil(8, { dock.whole[top.meeting] != nil }) {
                    try? await Task.sleep(for: .milliseconds(400))
                }
            }
            if request.card == nil, request.sheet == nil {
                // The flags name the entire window, not its content rect. SwiftUI installs a toolbar after the
                // first layout, adding 66 pt (80 with the dock) to the initial content size. Resize only after
                // those views are present so snapshots at the same requested size remain comparable.
                let size = MeetingsWindow.floored(NSSize(width: request.width, height: request.height))
                window.setFrame(NSRect(origin: window.frame.origin, size: size), display: true)
                window.contentView?.layoutSubtreeIfNeeded()
                try? await Task.sleep(for: .milliseconds(200))
            }
            guard let capture = await WindowSnapshot.capture(window),
                  let png = capture.image.representation(using: .png, properties: [:]) else {
                FileHandle.standardError.write(Data("meetings snapshot failed: the window could not be drawn\n".utf8))
                exit(1)
            }
            do {
                try png.write(to: URL(fileURLWithPath: path))
            } catch {
                FileHandle.standardError.write(Data("meetings snapshot failed: \(error.localizedDescription)\n".utf8))
                exit(1)
            }
            FileHandle.standardError.write(Data("meetings snapshot: \(path) by \(capture.method)\n".utf8))
            exit(0)
        }
        NSApp.run()
    }
    exit(0)
}

/// The Meetings window's undo manager (G39). A text field in focus (the field editor is the first responder) keeps its
/// own undo; otherwise ⌘Z and Edit → Undo press the newest notice's Undo, and the menu item names it.
final class MeetingsUndoManager: UndoManager {
    weak var window: NSWindow?
    private weak var model: MeetingsWindowModel?

    init(model: MeetingsWindowModel) {
        self.model = model
        super.init()
    }

    private var textHasFocus: Bool {
        MainActor.assumeIsolated { window?.firstResponder is NSText }
    }

    private var noticeUndo: String? {
        MainActor.assumeIsolated { model?.newestUndo }
    }

    override var canUndo: Bool { textHasFocus ? super.canUndo : noticeUndo != nil }

    override var undoMenuItemTitle: String {
        guard !textHasFocus else { return super.undoMenuItemTitle }
        return noticeUndo.map { "Undo \($0)" } ?? "Undo"
    }

    override func undo() {
        guard !textHasFocus else { return super.undo() }
        MainActor.assumeIsolated { _ = model?.undoNewest() }
    }
}

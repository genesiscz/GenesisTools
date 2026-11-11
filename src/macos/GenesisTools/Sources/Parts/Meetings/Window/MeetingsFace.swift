import AppKit
import SwiftUI

// GenesisTools --meetings [--place needs|all|project:<name>] [--meeting <id>] [--tab transcript|screen|items|speakers|context] [--no-focus]
//   The Meetings window: meetings by day with what each needs, one meeting with its transcript, screen, items,
//   speakers and context, the meetings that need you, and each project. One per login session: a later launch hands
//   its request to the running one and exits.
// GenesisTools --meetings … --snapshot <png> [--width <pt>] [--height <pt>] [--play <target json>]
//   Draws the window off screen into a PNG once its data has loaded, then exits (verification without a screen).
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
func meetingsNotificationPrefix(home: String = genesisHome(), realHome: String = NSHomeDirectory()) -> String {
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
    /// `--side-panel`: the settings side panel opens beside the meeting.
    var sidePanel = false
    var snapshot: String?
    /// `--play <target json>`: the Moment a snapshot starts, silently, before the picture.
    var play: MomentTarget?
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
            case "--tab": request.tab = value().flatMap(MeetingDetailModel.Tab.init(rawValue:))
            case "--no-focus", "--no-activate": request.focus = false
            case "--side-panel": request.sidePanel = true
            case "--snapshot": request.snapshot = value().map { URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath).path }
            case "--play": request.play = value().flatMap { try? JSONDecoder().decode(MomentTarget.self, from: Data($0.utf8)) }
            case "--width": request.width = value().flatMap(Double.init).map { CGFloat($0) } ?? request.width
            case "--height": request.height = value().flatMap(Double.init).map { CGFloat($0) } ?? request.height
            default: break
            }
            index += 1
        }
        return request
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
            MainActor.assumeIsolated { MeetingsWindow.shared.show(next) }
        }
        MeetingsWindow.shared.show(request)
        app.run()
    }
    exit(0)
}

@MainActor
final class MeetingsWindow: NSObject, NSWindowDelegate {
    static let shared = MeetingsWindow()
    private var window: NSWindow?
    let model = MeetingsWindowModel()

    func show(_ request: MeetingsRequest) {
        let window = window ?? Self.makeWindow(model: model, size: NSSize(width: request.width, height: request.height))
        if self.window == nil {
            window.delegate = self
            window.setFrameAutosaveName("GenesisToolsMeetings")
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
        if let place = request.place { model.go(place) }
        if request.sidePanel { model.sidePanelOpen = true }
        if let meeting = request.meeting {
            model.select(meeting, tab: request.tab)
        } else if let tab = request.tab {
            model.detail?.show(tab)
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

    /// The window is the face: closing it ends the process, as the hub's window does.
    func windowWillClose(_ notification: Notification) {
        NSApp.terminate(nil)
    }
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
            if model.sidePanelOpen {
                _ = await waitUntil(30) { model.settingsRaw != nil || model.settings.failure != nil }
            }
            let window = MeetingsWindow.makeWindow(model: model, size: NSSize(width: request.width, height: request.height))
            window.orderInForSnapshot()
            try? await Task.sleep(for: .milliseconds(900))
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

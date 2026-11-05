import AppKit
import SwiftUI

// GenesisTools --meetings [--place needs|all|project:<name>] [--meeting <id>] [--tab transcript|screen|items|speakers|context] [--no-focus]
//   The Meetings window: meetings by day with what each needs, one meeting with its transcript, screen, items,
//   speakers and context, the meetings that need you, and each project. One per login session: a later launch hands
//   its request to the running one and exits.
// GenesisTools --meetings … --snapshot <png> [--width <pt>] [--height <pt>]
//   Draws the window off screen into a PNG once its data has loaded, then exits (verification without a screen).

private let meetingsInstance = SingleInstance(
    name: "meetings",
    lockFile: NativePreview.hubFile("meetings.lock"),
    notificationPrefix: NativePreview.namespace + ".meetings",
    retryHint: "close the Meetings window, then try again.",
    log: { HubPerf.log($0) }
)

struct MeetingsRequest {
    var place: MeetingsWindowModel.Place?
    var meeting: String?
    var tab: MeetingDetailModel.Tab?
    var focus = true
    var snapshot: String?
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
                case let other where other.hasPrefix("project:"): request.place = .project(String(other.dropFirst(8)))
                default: break
                }
            case "--meeting": request.meeting = value()
            case "--tab": request.tab = value().flatMap(MeetingDetailModel.Tab.init(rawValue:))
            case "--no-focus", "--no-activate": request.focus = false
            case "--snapshot": request.snapshot = value().map { URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath).path }
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
        if let meeting = request.meeting { model.select(meeting) }
        if let tab = request.tab { model.detail?.show(tab) }
    }

    static func makeWindow(model: MeetingsWindowModel, size: NSSize) -> NSWindow {
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Meetings"
        window.minSize = NSSize(width: 900, height: 560)
        window.appearance = NSAppearance(named: .darkAqua)
        window.isReleasedWhenClosed = false
        let hosting = NSHostingView(rootView: MeetingsRootView(model: model))
        // The window keeps the size the reader gives it, and `minSize` above is its only floor: with the default options,
        // and still with `.minSize`, each notice grew the window to the content's height (900 to 1982 pt in one session).
        hosting.sizingOptions = []
        window.contentView = hosting
        window.center()
        return window
    }

    func windowDidBecomeKey(_ notification: Notification) {
        // A meeting changed elsewhere (a confirm in a terminal, a new recording) shows when the window comes back.
        if case .loaded = model.overview { model.refreshAfterReturn() }
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

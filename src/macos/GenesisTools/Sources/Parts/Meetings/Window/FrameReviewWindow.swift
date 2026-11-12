import AppKit
import SwiftUI

/// The shared frame browser opened from the Screen tab and the playback preview.
@MainActor
final class FrameReviewWindow: NSObject, NSWindowDelegate {
    private static var open: [String: FrameReviewWindow] = [:]
    private let model: FrameReviewModel
    private let window: NSWindow
    private var loadTask: Task<Void, Never>?

    static func show(meeting: String, file: String, at: Double, player: MomentPlayer?,
                     defaults: UserDefaults = .standard, timeline: ScreenTimeline? = nil, duration: Double? = nil, text: Bool = true) {
        if let existing = open[meeting] {
            existing.model.player = player
            existing.model.sourceDuration = duration ?? existing.model.sourceDuration
            existing.model.open(file: file, at: at)
            if text { existing.model.textVisible = true }
            existing.window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let controller = FrameReviewWindow(meeting: meeting, file: file, at: at, player: player,
                                           defaults: defaults, timeline: timeline, duration: duration, text: text)
        open[meeting] = controller
        controller.window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private init(meeting: String, file: String, at: Double, player: MomentPlayer?,
                 defaults: UserDefaults, timeline: ScreenTimeline?, duration: Double?, text: Bool) {
        model = FrameReviewModel(meeting: meeting, file: file, at: at, player: player, defaults: defaults, timeline: timeline)
        model.sourceDuration = duration ?? 0
        model.textVisible = text
        let visible = NSApp.keyWindow?.screen?.visibleFrame ?? NSScreen.main?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        let size = CGSize(width: min(1400, visible.width * 0.9), height: min(950, visible.height * 0.9))
        window = NSWindow(contentRect: CGRect(origin: .zero, size: size),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        super.init()
        window.title = "Screen recording · \(meeting)"
        window.minSize = NSSize(width: 800, height: 520)
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        window.delegate = self
        window.contentView = NSHostingView(rootView: FrameReviewView(model: model) { [weak self] in self?.window.performClose(nil) })
        window.setFrameOrigin(NSPoint(x: visible.midX - size.width / 2, y: visible.midY - size.height / 2))
        if !window.setFrameUsingName("GenesisToolsFrameReview") { window.setContentSize(size) }
        window.setFrameAutosaveName("GenesisToolsFrameReview")
        loadTask = Task { await model.load() }
    }

    func windowWillClose(_ notification: Notification) {
        loadTask?.cancel()
        model.cancelWork()
        Self.open.removeValue(forKey: model.meeting)
    }
}

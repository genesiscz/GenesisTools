import AppKit
import SwiftUI

/// Where a failure window appears.
public enum FailureNoticePlacement: String, CaseIterable, Identifiable, Sendable {
    /// Under the item that started the action (a menu bar item), centred on it; without one, the top right corner.
    case belowAnchor = "anchor"
    /// The top right corner of the screen, where macOS shows its notifications.
    case topRight
    /// The middle of the upper part of the screen, where macOS puts an alert.
    case center

    public var id: String { rawValue }
}

/// Where "Draft an issue" posts: the repository, how (`ToolsIssuePoster` in the app) and the labels.
public struct FailureNoticeIssueTarget {
    public var repo: String
    public var poster: IssuePosting
    public var labels: [String]

    public init(repo: String, poster: IssuePosting, labels: [String] = ["bug"]) {
        self.repo = repo
        self.poster = poster
        self.labels = labels
    }
}

/// How a failure window behaves; the host stores each choice as a setting.
public struct FailureNoticeOptions: Equatable, Sendable {
    /// The log is open when the window appears.
    public var detailsOpen: Bool
    public var placement: FailureNoticePlacement
    /// Closes by itself after this long without the pointer on it; nil keeps it until it is closed.
    public var autoClose: TimeInterval?

    public init(detailsOpen: Bool = true, placement: FailureNoticePlacement = .belowAnchor, autoClose: TimeInterval? = nil) {
        self.detailsOpen = detailsOpen
        self.placement = placement
        self.autoClose = autoClose
    }
}

/// A failure in a small window of its own (`FailureNoticeView`) that never activates its app or takes the keyboard
/// when it appears: a titled, resizable, non-activating panel over other apps' windows. A click into it makes it key
/// (still without activating the app), and then Escape closes it, ⌘C copies the context for agents unless text is
/// selected, and ⌘R tries again. It opens at its content's height up to a cap; a size the person drags is kept for
/// the next failure. A new failure replaces the shown one.
@MainActor
public final class FailureNoticePanel: NSObject, NSWindowDelegate {
    public static let defaultWidth: CGFloat = 620
    public static let minimumSize = CGSize(width: 440, height: 180)

    /// The frame on screen of the thing that started the action, nil when it is not on screen.
    public var anchor: () -> CGRect?
    private let identifier: String
    private let defaults: UserDefaults
    private var panel: FailureNoticeWindow?
    private var host: NSHostingView<AnyView>?
    private var model: FailureNoticeModel?
    private var generation = 0
    private var autoClose: Task<Void, Never>?
    private var autoCloseDelay: TimeInterval?
    private var fitting = false

    /// `identifier` names the window for automation and keys the saved size (`<identifier>.size`).
    public init(identifier: String, defaults: UserDefaults = .standard, anchor: @escaping () -> CGRect? = { nil }) {
        self.identifier = identifier
        self.defaults = defaults
        self.anchor = anchor
    }

    public var isVisible: Bool { panel?.isVisible ?? false }
    public var window: NSWindow? { panel }

    public func show(_ report: FailureReport, options: FailureNoticeOptions = FailureNoticeOptions(),
                     retry: (@MainActor () -> Void)? = nil, issue: FailureNoticeIssueTarget? = nil,
                     environment: (@Sendable () async -> FailureEnvironment?)? = nil) {
        FailureCapture.record(report)
        generation += 1
        let shown = generation
        let anchor = anchor()
        let screen = Self.screen(for: anchor)
        let visible = screen?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        let saved = savedSize
        let width = Self.clampWidth(saved?.width ?? Self.defaultWidth, visible: visible)
        let cap = Self.detailsCap(visible: visible)

        var again: (@MainActor () -> Void)?
        if let retry {
            again = { [weak self] in
                self?.close(shown)
                retry()
            }
        }
        let model = FailureNoticeModel(report: report, detailsOpen: options.detailsOpen, detailsCap: cap, retry: again,
                                       dismiss: { [weak self] in self?.close(shown) })
        model.userSized = saved != nil
        if let issue {
            // The report as it is at the click: the environment may have arrived since the notice appeared.
            model.draftIssue = { [weak self, weak model] in
                guard let model else { return }
                IssueDraftWindow.show(IssueDraft.failure(model.report, repo: issue.repo, labels: issue.labels),
                                      poster: issue.poster, near: self?.panel)
            }
        }
        if let environment {
            Task { @MainActor [weak model] in
                guard let facts = await environment() else { return }
                model?.report.environment = facts
            }
        }
        self.model = model
        let root = FailureNoticeRoot(model: model, resized: { [weak self] height in self?.fit(height, generation: shown) },
                                     hovering: { [weak self] inside in self?.hover(inside, generation: shown) })
        let host = host ?? FailureNoticeHostingView(rootView: AnyView(EmptyView()))
        host.sizingOptions = []
        host.rootView = AnyView(root)
        self.host = host

        let panel = panel ?? makePanel(host: host)
        self.panel = panel
        panel.title = report.title
        panel.onCopyContext = { [weak model] in model?.copyContext() }
        panel.onCancel = { [weak self] in self?.close(shown) }
        let height = saved?.height ?? Self.estimatedHeight(report: report, detailsOpen: model.detailsOpen, cap: cap)
        let size = CGSize(width: width, height: min(height, visible.height - 16))
        fitting = true
        panel.setFrame(CGRect(origin: Self.origin(size: size, anchor: anchor, visible: visible, placement: options.placement),
                              size: size), display: false)
        host.layoutSubtreeIfNeeded()
        fitting = false

        let fades = !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion && !panel.isVisible
        panel.alphaValue = fades ? 0 : 1
        panel.orderFrontRegardless()
        if fades {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.15
                panel.animator().alphaValue = 1
            }
        }
        NSAccessibility.post(element: panel, notification: .announcementRequested, userInfo: [
            .announcement: "\(report.title): \(report.headline)", .priority: NSAccessibilityPriorityLevel.high.rawValue,
        ])
        autoCloseDelay = options.autoClose
        scheduleAutoClose(generation: shown)
    }

    public func close() { close(generation) }

    private func close(_ shown: Int) {
        guard shown == generation else { return }
        autoClose?.cancel()
        panel?.orderOut(nil)
    }

    // MARK: - Size

    /// The size the person dragged the window to, kept across failures and restarts.
    private var savedSize: CGSize? {
        guard let text = defaults.string(forKey: identifier + ".size") else { return nil }
        let size = NSSizeFromString(text)
        return size.width >= Self.minimumSize.width && size.height >= Self.minimumSize.height ? size : nil
    }

    /// The content reported its height: the window keeps its top edge and takes it, unless the person sized it.
    private func fit(_ height: CGFloat, generation shown: Int) {
        guard shown == generation, let panel, let model, !model.userSized, height > 0 else { return }
        let content = panel.contentRect(forFrameRect: panel.frame)
        let visible = panel.screen?.visibleFrame ?? content
        let target = min(max(height.rounded(.up), Self.minimumSize.height), visible.height - 16)
        guard abs(content.height - target) > 0.5 else { return }
        let frame = panel.frameRect(forContentRect: CGRect(x: content.minX, y: content.maxY - target, width: content.width, height: target))
        fitting = true
        panel.setFrame(frame, display: true)
        fitting = false
    }

    public func windowDidEndLiveResize(_ notification: Notification) {
        guard let panel, let model, !fitting else { return }
        defaults.set(NSStringFromSize(panel.frame.size), forKey: identifier + ".size")
        if !model.userSized {
            model.userSized = true
        }
    }

    nonisolated static func clampWidth(_ width: CGFloat, visible: CGRect) -> CGFloat {
        min(max(width, minimumSize.width), max(minimumSize.width, min(980, visible.width - 32)))
    }

    /// The details scroll past this height while the window fits its content: about 60% of the screen, at most 460 pt.
    nonisolated static func detailsCap(visible: CGRect) -> CGFloat {
        max(160, min(460, (visible.height * 0.6).rounded()))
    }

    /// A first height before the content reports its own: the header and actions, plus the details' cap when open.
    nonisolated static func estimatedHeight(report: FailureReport, detailsOpen: Bool, cap: CGFloat) -> CGFloat {
        let header: CGFloat = 28 + 110
        guard report.hasLog else { return header }
        return header + 40 + (detailsOpen ? cap : 0)
    }

    // MARK: - Placement

    private static func screen(for anchor: CGRect?) -> NSScreen? {
        if let anchor, let screen = NSScreen.screens.first(where: { $0.frame.contains(CGPoint(x: anchor.midX, y: anchor.midY)) }) {
            return screen
        }
        return NSScreen.screens.first { $0.frame.contains(NSEvent.mouseLocation) } ?? NSScreen.screens.first
    }

    /// The window's origin for `placement`, always inside the visible screen.
    public nonisolated static func origin(size: CGSize, anchor: CGRect?, visible: CGRect,
                                          placement: FailureNoticePlacement) -> CGPoint {
        let margin: CGFloat = 8
        var origin: CGPoint
        switch placement {
        case .belowAnchor where anchor != nil:
            let anchor = anchor ?? .zero
            origin = CGPoint(x: anchor.midX - size.width / 2, y: anchor.minY - 6 - size.height)
        case .belowAnchor, .topRight:
            origin = CGPoint(x: visible.maxX - size.width - 12, y: visible.maxY - size.height - 12)
        case .center:
            origin = CGPoint(x: visible.midX - size.width / 2, y: visible.maxY - visible.height * 0.2 - size.height)
        }
        origin.x = min(max(origin.x, visible.minX + margin), visible.maxX - size.width - margin)
        origin.y = min(max(origin.y, visible.minY + margin), visible.maxY - size.height)
        return CGPoint(x: origin.x.rounded(), y: origin.y.rounded())
    }

    // MARK: - Closing by itself

    private func hover(_ inside: Bool, generation shown: Int) {
        guard shown == generation else { return }
        if inside {
            autoClose?.cancel()
        } else {
            scheduleAutoClose(generation: shown)
        }
    }

    private func scheduleAutoClose(generation shown: Int) {
        autoClose?.cancel()
        guard let delay = autoCloseDelay else { return }
        autoClose = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            self?.close(shown)
        }
    }

    private func makePanel(host: NSView) -> FailureNoticeWindow {
        let panel = FailureNoticeWindow(contentRect: CGRect(origin: .zero, size: CGSize(width: Self.defaultWidth, height: 200)),
                                        styleMask: [.titled, .closable, .resizable, .nonactivatingPanel, .utilityWindow],
                                        backing: .buffered, defer: false)
        panel.identifier = NSUserInterfaceItemIdentifier(identifier)
        panel.isFloatingPanel = true
        // After isFloatingPanel, whose setter resets the level: over other apps' windows, under the menus.
        panel.level = .floating
        panel.becomesKeyOnlyIfNeeded = false
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.appearance = NSAppearance(named: .darkAqua)
        panel.contentMinSize = Self.minimumSize
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
        panel.standardWindowButton(.zoomButton)?.isHidden = true
        panel.contentView = host
        panel.delegate = self
        return panel
    }

    public func windowShouldClose(_ sender: NSWindow) -> Bool {
        close()
        return false
    }
}

/// The view with its height reports and the pointer's enter and exit (the auto-close pauses under the pointer).
private struct FailureNoticeRoot: View {
    @ObservedObject var model: FailureNoticeModel
    let resized: (CGFloat) -> Void
    let hovering: (Bool) -> Void

    var body: some View {
        FailureNoticeView(model: model)
            .fixedSize(horizontal: false, vertical: !model.userSized)
            .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { resized($0) }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .onHover { hovering($0) }
            .environment(\.colorScheme, .dark)
    }
}

/// Becomes key on a click (never by itself), so Escape and ⌘C reach it without the app being activated.
final class FailureNoticeWindow: NSPanel {
    var onCopyContext: (() -> Void)?
    var onCancel: (() -> Void)?

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    override func cancelOperation(_ sender: Any?) {
        onCancel?()
    }

    /// ⌘C copies the selected text when there is a selection, else the context for agents.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if flags == .command, event.charactersIgnoringModifiers == "c" {
            if let text = firstResponder as? NSText, text.selectedRange.length > 0 {
                text.copy(nil)
                return true
            }
            onCopyContext?()
            return true
        }
        if super.performKeyEquivalent(with: event) {
            return true
        }
        return StandardEditing.perform(event, in: self)
    }
}

/// The first click acts (a button, the details) even while another app is in front.
final class FailureNoticeHostingView: NSHostingView<AnyView> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

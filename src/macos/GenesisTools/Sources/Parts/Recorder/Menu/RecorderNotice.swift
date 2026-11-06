import AppKit
import SwiftUI

/// Where the recorder's messages go when no editor window shows them: a failure from the menu bar or the library's
/// quick actions, a recording that did not open or start, a shortcut with nothing to act on, and the Rename prompt.
/// The stored choices decide the way (`RecorderFailureStyle`, `IdleShortcutFeedback`); a test swaps the outlets.
@MainActor
struct RecorderNoticeOutlets {
    var notice: @MainActor (_ text: String, _ more: String?) -> Void
    var alert: @MainActor (_ text: String, _ more: String?) -> Void
    var note: @MainActor (_ title: String, _ detail: String) -> Void
    var beep: @MainActor () -> Void
    var titlePanel: @MainActor (_ request: RecorderTitleRequest, _ done: @escaping (String?) -> Void) -> Void
    var titleAlert: @MainActor (_ request: RecorderTitleRequest) -> String?

    static let live = RecorderNoticeOutlets(
        notice: { RecorderNoticePanel.shared.show(text: $0, more: $1) },
        alert: { RecorderNotice.modalAlert($0, more: $1) },
        note: { CopyToast.post(title: $0, detail: $1, style: .problem) },
        beep: { NSSound.beep() },
        titlePanel: { RecorderTitlePrompt.show($0, done: $1) },
        titleAlert: { RecorderNotice.modalTitleAlert($0) })
}

/// What Rename asks: the heading, one line on where the title shows, and the title it starts from.
struct RecorderTitleRequest: Equatable {
    let heading: String
    let detail: String
    let current: String
}

@MainActor
enum RecorderNotice {
    static var outlets = RecorderNoticeOutlets.live

    /// A failure the person should read: `text` says what happened in one sentence, `more` holds the raw output
    /// (behind Details in the note, the informative text of the alert).
    static func failure(_ text: String, more: String? = nil, defaults: UserDefaults = .standard) {
        let style = RecorderFailureStyle.load(defaults)
        HubPerf.log("recorder: failure (\(style.rawValue)): \(text)")
        let more = more.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
        switch style {
        case .notice: outlets.notice(text, more)
        case .alert: outlets.alert(text, more)
        }
    }

    /// A failed `tools` command: `text`, then the line of its output that names the problem (`ToolsRunner.problem`),
    /// never a help dump; Details holds the whole output, or `fallback` when it printed nothing.
    static func failure(_ text: String, output: String, fallback: String? = nil, defaults: UserDefaults = .standard) {
        let problem = ToolsRunner.problem(in: output)
        let headline = problem.map { "\(text): \($0.hasSuffix(".") ? String($0.dropLast()) : $0)." } ?? "\(text)."
        failure(headline, more: output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? fallback : output,
                defaults: defaults)
    }

    /// A shortcut pressed with nothing to act on (no recording runs).
    static func nothingToActOn(_ title: String, detail: String, defaults: UserDefaults = .standard) {
        let feedback = IdleShortcutFeedback.load(defaults)
        HubPerf.log("recorder: shortcut had nothing to act on (\(feedback.rawValue)): \(title)")
        switch feedback {
        case .note: outlets.note(title, detail)
        case .beep: outlets.beep()
        case .nothing: break
        }
    }

    /// Asks for a title; `done` gets the trimmed new title, or nil when the person cancelled or kept the old one.
    static func askTitle(_ request: RecorderTitleRequest, defaults: UserDefaults = .standard,
                         done: @escaping (String?) -> Void) {
        let finish: (String?) -> Void = { answer in
            let title = answer?.trimmingCharacters(in: .whitespacesAndNewlines)
            done(title.flatMap { $0.isEmpty || $0 == request.current ? nil : $0 })
        }
        switch RecorderFailureStyle.load(defaults) {
        case .notice: outlets.titlePanel(request, finish)
        case .alert: finish(outlets.titleAlert(request))
        }
    }

    /// The "Alert" choice: the dialog the recorder showed before the setting existed.
    static func modalAlert(_ text: String, more: String?) {
        let alert = NSAlert()
        alert.messageText = text
        if let more { alert.informativeText = more }
        // It asks nothing, so it never holds up a quit or an update.
        alert.window.preventsApplicationTerminationWhenModal = false
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    static func modalTitleAlert(_ request: RecorderTitleRequest) -> String? {
        let alert = NSAlert()
        alert.messageText = request.heading
        alert.informativeText = request.detail
        let field = NSTextField(string: request.current)
        field.frame = NSRect(x: 0, y: 0, width: 280, height: 24)
        alert.accessoryView = field
        alert.addButton(withTitle: "Rename")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        NSApp.activate(ignoringOtherApps: true)
        return alert.runModal() == .alertFirstButtonReturn ? field.stringValue : nil
    }
}

// MARK: - The note under the menu bar item

/// A failure note that floats under the recorder's menu bar item: the kit's `NoticePill` (the full output behind
/// Details, a close button) in a borderless panel that never activates the app. It takes the keyboard only when the
/// person clicks into it to select its text. A new failure replaces the shown one; it stays until it is closed.
@MainActor
final class RecorderNoticePanel {
    static let shared = RecorderNoticePanel()
    static let width: CGFloat = 340

    /// The menu bar item's frame on screen, nil while it is hidden.
    var anchor: () -> CGRect? = { RecorderMenu.shared.statusItemFrame }
    private var panel: RecorderNoticeWindow?
    private var host: RecorderNoticeHostingView?
    private var generation = 0

    var isVisible: Bool { panel?.isVisible ?? false }

    func show(text: String, more: String?) {
        generation += 1
        let shown = generation
        let host = host ?? RecorderNoticeHostingView(rootView: AnyView(EmptyView()))
        // The panel's size is set here, from the content's reported size, so it keeps its top edge when Details opens.
        host.sizingOptions = []
        self.host = host
        host.rootView = AnyView(RecorderNoticeView(
            text: text, more: more,
            dismiss: { [weak self] in self?.close(shown) },
            resized: { [weak self] size in self?.fit(size, generation: shown) }))
        let panel = panel ?? makePanel(host: host)
        self.panel = panel
        let size = Self.measure(text: text, more: more)
        let anchor = anchor()
        let visible = Self.screen(for: anchor)?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        panel.setFrame(CGRect(origin: Self.origin(size: size, anchor: anchor, visible: visible), size: size), display: true)
        // A short fade in; under Reduce Motion it appears at once.
        let fades = !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        panel.alphaValue = fades ? 0 : 1
        panel.orderFrontRegardless()
        if fades {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.15
                panel.animator().alphaValue = 1
            }
        }
        NSAccessibility.post(element: panel, notification: .announcementRequested, userInfo: [
            .announcement: text, .priority: NSAccessibilityPriorityLevel.high.rawValue,
        ])
    }

    /// The note's size before it shows. The panel's own host has no sizing options (the panel sets its size), so its
    /// `fittingSize` is 0 x 0, and every note opened as a 0 x 0 window; a throwaway controller measures the same pill.
    static func measure(text: String, more: String?) -> CGSize {
        let probe = NSHostingController(rootView: RecorderNoticeContent(text: text, more: more, dismiss: {})
            .environment(\.colorScheme, .dark))
        let size = probe.sizeThatFits(in: CGSize(width: width, height: 10_000))
        return CGSize(width: width, height: max(size.height.rounded(.up), 1))
    }

    func close() { close(generation) }

    private func close(_ shown: Int) {
        guard shown == generation else { return }
        panel?.orderOut(nil)
    }

    /// Details opened or closed: the panel keeps its top edge and grows or shrinks downward.
    private func fit(_ size: CGSize, generation shown: Int) {
        // Not only while visible: the first report comes during the show, before the panel is ordered in.
        guard shown == generation, let panel, size.height > 0 else { return }
        let frame = panel.frame
        guard abs(frame.height - size.height) > 0.5 || abs(frame.width - size.width) > 0.5 else { return }
        panel.setFrame(CGRect(x: frame.minX, y: frame.maxY - size.height, width: size.width, height: size.height), display: true)
    }

    private func makePanel(host: NSView) -> RecorderNoticeWindow {
        let panel = RecorderNoticeWindow(contentRect: CGRect(x: 0, y: 0, width: Self.width, height: 60),
                                         styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.title = "Recorder notice"
        panel.identifier = NSUserInterfaceItemIdentifier("recorder.notice")
        panel.isFloatingPanel = true
        // After isFloatingPanel, whose setter resets the level: over other apps' windows, under the menus.
        panel.level = .statusBar
        panel.becomesKeyOnlyIfNeeded = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.contentView = host
        return panel
    }

    /// The display of the menu bar item, else the pointer's.
    private static func screen(for anchor: CGRect?) -> NSScreen? {
        if let anchor, let screen = NSScreen.screens.first(where: { $0.frame.contains(CGPoint(x: anchor.midX, y: anchor.midY)) }) {
            return screen
        }
        return NSScreen.screens.first { $0.frame.contains(NSEvent.mouseLocation) } ?? NSScreen.main
    }

    /// Under the menu bar item, centred on it, inside the visible screen; without the item, the top right corner.
    nonisolated static func origin(size: CGSize, anchor: CGRect?, visible: CGRect) -> CGPoint {
        let margin: CGFloat = 8
        var origin: CGPoint
        if let anchor {
            origin = CGPoint(x: anchor.midX - size.width / 2, y: anchor.minY - 6 - size.height)
        } else {
            origin = CGPoint(x: visible.maxX - size.width - 12, y: visible.maxY - size.height - 12)
        }
        origin.x = min(max(origin.x, visible.minX + margin), visible.maxX - size.width - margin)
        origin.y = min(max(origin.y, visible.minY + margin), visible.maxY - size.height)
        return CGPoint(x: origin.x.rounded(), y: origin.y.rounded())
    }
}

/// Becomes key only when a click needs the keyboard (selecting the message), never on its own.
final class RecorderNoticeWindow: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

/// The first click on the note acts (close, Details) even while another app is in front.
final class RecorderNoticeHostingView: NSHostingView<AnyView> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

private struct RecorderNoticeView: View {
    let text: String
    let more: String?
    let dismiss: () -> Void
    let resized: (CGSize) -> Void

    var body: some View {
        RecorderNoticeContent(text: text, more: more, dismiss: dismiss)
            .background(GeometryReader { proxy in
                Color.clear
                    .onAppear { resized(proxy.size) }
                    .onChange(of: proxy.size) { _, size in resized(size) }
            })
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .environment(\.colorScheme, .dark)
            .accessibilityIdentifier("recorder.notice")
    }
}

/// The note itself, at its own height: what the panel shows and what `RecorderNoticePanel.measure` measures.
struct RecorderNoticeContent: View {
    let text: String
    let more: String?
    let dismiss: () -> Void

    var body: some View {
        // The pill's own translucent fill sits on an opaque backing of the same shape, so it reads over any window.
        NoticePill(text: text, more: more, tone: .error, dismiss: dismiss)
            .frame(width: RecorderNoticePanel.width, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            .background(RoundedRectangle(cornerRadius: 11, style: .continuous).fill(Color(white: 0.11)))
    }
}

// MARK: - The Rename prompt

/// Rename's question in a small titled panel that takes the typing without activating the recorder, so its other
/// windows (the library, an editor) stay where they are. Return renames, Escape and ⌘W cancel.
@MainActor
final class RecorderTitlePrompt: NSObject, NSWindowDelegate {
    private static var current: RecorderTitlePrompt?

    private let panel: RecorderTitlePanel
    private var done: ((String?) -> Void)?

    static func show(_ request: RecorderTitleRequest, done: @escaping (String?) -> Void) {
        current?.finish(nil)
        let prompt = RecorderTitlePrompt(request, done: done)
        current = prompt
        prompt.present()
    }

    private init(_ request: RecorderTitleRequest, done: @escaping (String?) -> Void) {
        self.done = done
        panel = RecorderTitlePanel(contentRect: .zero, styleMask: [.titled, .closable, .fullSizeContentView, .nonactivatingPanel],
                                   backing: .buffered, defer: false)
        super.init()
        let host = NSHostingView(rootView: RecorderTitlePromptView(request: request) { [weak self] answer in
            self?.finish(answer)
        }.titlebarZone())
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        for button in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
            panel.standardWindowButton(button)?.isHidden = true
        }
        panel.title = request.heading
        panel.identifier = NSUserInterfaceItemIdentifier("recorder.rename")
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.isFloatingPanel = true
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)
        panel.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        panel.contentView = host
        panel.delegate = self
        panel.setContentSize(host.fittingSize)
    }

    private func present() {
        let size = panel.frame.size
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main
        let visible = screen?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        // Where macOS puts an alert: centred, in the upper part of the screen under the pointer.
        panel.setFrameOrigin(CGPoint(x: (visible.midX - size.width / 2).rounded(),
                                     y: (visible.maxY - visible.height * 0.2 - size.height).rounded()))
        // Key without activating the app: the typing goes here, the front app and the recorder's windows stay put.
        panel.makeKeyAndOrderFront(nil)
    }

    private func finish(_ answer: String?) {
        guard let done else { return }
        self.done = nil
        panel.delegate = nil
        panel.orderOut(nil)
        if Self.current === self { Self.current = nil }
        done(answer)
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        finish(nil)
        return false
    }
}

/// Takes the keyboard without activating its app; ⌘A, ⌘C, ⌘V and ⌘Z reach the field with no Edit menu.
final class RecorderTitlePanel: EditingPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

private struct RecorderTitlePromptView: View {
    let request: RecorderTitleRequest
    let finish: (String?) -> Void
    @State private var text: String
    @FocusState private var focused: Bool

    init(request: RecorderTitleRequest, finish: @escaping (String?) -> Void) {
        self.request = request
        self.finish = finish
        _text = State(initialValue: request.current)
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canRename: Bool { !trimmed.isEmpty && trimmed != request.current }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(request.heading).font(.system(size: 13, weight: .semibold))
                .lineLimit(2).truncationMode(.middle)
            Text(request.detail).font(.system(size: 11.5)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            TextField("Title", text: $text)
                .textFieldStyle(.roundedBorder)
                .focused($focused)
                .onSubmit { if canRename { finish(trimmed) } }
                .accessibilityIdentifier("recorder.rename.field")
            HStack(spacing: 8) {
                Spacer()
                Button("Cancel") { finish(nil) }
                    .keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier("recorder.rename.cancel")
                Button("Rename") { finish(trimmed) }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
                    .disabled(!canRename)
                    .instantTooltip(canRename ? "Rename the recording (Return)" : "Type a new title first")
                    .accessibilityIdentifier("recorder.rename.confirm")
            }
        }
        // The title bar is empty (no title, no buttons), so the content uses its height: one 18 pt inset all round,
        // not a 30 pt band under an invisible bar (review 2026-11-06).
        .padding(18)
        .frame(width: 360)
        .ignoresSafeArea(.container, edges: .top)
        .onAppear { DispatchQueue.main.async { focused = true } }
    }
}

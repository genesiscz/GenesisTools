import AppKit
import SwiftUI

/// Where the recorder's messages go when no editor window shows them: a failure from the menu bar or the library's
/// quick actions, a recording that did not open or start, a shortcut with nothing to act on, and the Rename prompt.
/// The stored choices decide the way (`RecorderFailureStyle`, `IdleShortcutFeedback`); a test swaps the outlets.
@MainActor
struct RecorderNoticeOutlets {
    /// The failure window: the report, and the action to run again when there is one.
    var notice: @MainActor (_ report: FailureReport, _ retry: (@MainActor () -> Void)?) -> Void
    var alert: @MainActor (_ text: String, _ more: String?) -> Void
    var note: @MainActor (_ title: String, _ detail: String) -> Void
    var beep: @MainActor () -> Void
    var titlePanel: @MainActor (_ request: RecorderTitleRequest, _ done: @escaping (String?) -> Void) -> Void
    var titleAlert: @MainActor (_ request: RecorderTitleRequest) -> String?

    static let live = RecorderNoticeOutlets(
        notice: { RecorderNoticePanel.shared.show($0, retry: $1) },
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
    /// (the notice's log, the informative text of the alert).
    static func failure(_ text: String, more: String? = nil, title: String = "Recorder", defaults: UserDefaults = .standard) {
        let more = more.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
        let report = FailureReport(title: title, headline: FailureLog.sentence(text) ?? text, dayLog: FailureReport.dayLogPath(),
                                   log: more ?? "", app: FailureAppFacts.current())
        failure(report, defaults: defaults)
    }

    /// A failed `tools` command: the headline is the error its output names (`FailureLog.headline`), never a help dump
    /// or an indented field; `text` says what was running. The log holds the whole output, or `fallback` when it
    /// printed nothing.
    static func failure(_ text: String, output: String, fallback: String? = nil, defaults: UserDefaults = .standard) {
        let printed = !output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let summary = FailureLog.sentence(text)
        let report = FailureReport(title: "Recorder", headline: FailureLog.headline(in: output) ?? summary ?? text,
                                   summary: printed ? summary : nil, dayLog: FailureReport.dayLogPath(),
                                   log: printed ? output : (fallback ?? ""), app: FailureAppFacts.current())
        failure(report, defaults: defaults)
    }

    /// Shows `report` the chosen way: the failure window (with Try again when `retry` is given), or an alert.
    static func failure(_ report: FailureReport, retry: (@MainActor () -> Void)? = nil, defaults: UserDefaults = .standard) {
        let style = RecorderFailureStyle.load(defaults)
        HubPerf.log("recorder: failure (\(style.rawValue)): \(report.headline)")
        switch style {
        case .notice: outlets.notice(report, retry)
        case .alert:
            let more = [report.summary, report.hasLog ? report.log : nil].compactMap { $0 }.joined(separator: "\n\n")
            outlets.alert(report.headline, more.isEmpty ? nil : more)
        }
    }

    /// A recording start that stopped at once (`tools recorder start` exited non-zero within seconds).
    static func startFailed(_ failure: ToolsRunner.EarlyFailure, defaults: UserDefaults = .standard,
                            retry: (@MainActor () -> Void)?) {
        self.failure(startReport(failure, time: Date(), app: FailureAppFacts.current()), retry: retry, defaults: defaults)
    }

    /// The report of a start that stopped at once: the error its output names, what was being recorded, the recording
    /// folder it named, and where this run's output sits in the log. The day log is named by the date in `timeZone`.
    nonisolated static func startReport(_ failure: ToolsRunner.EarlyFailure, time: Date, app: FailureAppFacts?,
                                        home: String = genesisHome(), timeZone: TimeZone = .current) -> FailureReport {
        let printed = !failure.output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let events = FailureLog.events(in: failure.output)
        let folder = events.flatMap(\.fields).last { $0.name == "folder" }.map { FailureReport.unquoted($0.value) }
        let nothing = failure.output.contains("nothing was recorded")
        return FailureReport(
            title: "Recording failed",
            headline: FailureLog.headline(in: failure.output) ?? "The recording stopped at once.",
            summary: "\(recordingWhat(failure.argv)) stopped at once (exit \(failure.status)).",
            nextStep: (nothing ? "Nothing was recorded. " : "") + "Try again, or copy the context for an agent to look into it.",
            action: "Start a recording",
            command: failure.command,
            exitStatus: failure.status,
            folder: folder,
            logFile: failure.logFile,
            logLine: failure.logLine,
            dayLog: FailureReport.dayLogPath(home: home, time: time, timeZone: timeZone),
            log: printed ? failure.output : "",
            time: time,
            app: app,
            expected: "The recording starts, and its controls and the red menu bar item appear.",
            area: "recorder")
    }

    /// "Recording a window", from the start's target flag.
    nonisolated static func recordingWhat(_ argv: [String]) -> String {
        if argv.contains("--window") { return "Recording a window" }
        if argv.contains("--app") { return "Recording an app" }
        if argv.contains("--region") { return "Recording an area" }
        if argv.contains("--display") { return "Recording the screen" }
        return "The recording"
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

// MARK: - The failure window under the menu bar item

/// The recorder's failure window: GenesisKit's `FailureNoticePanel` under the recorder's menu bar item, with the
/// notice settings of Settings → Recorder → Menu bar.
@MainActor
final class RecorderNoticePanel {
    static let shared = RecorderNoticePanel()

    let panel = FailureNoticePanel(identifier: "recorder.notice", anchor: { RecorderMenu.shared.statusItemFrame })

    var isVisible: Bool { panel.isVisible }

    /// Where "Draft an issue" posts. `recorder.debug.issueDryRun` (a test switch, off) makes the post a dry run.
    static let issueRepo = "genesiscz/GenesisTools"

    func show(_ report: FailureReport, retry: (@MainActor () -> Void)?, defaults: UserDefaults = .standard) {
        let poster = ToolsIssuePoster(dryRun: defaults.bool(forKey: "recorder.debug.issueDryRun"))
        var report = report
        report.area = report.area ?? "recorder"
        panel.show(report, options: RecorderFailureStyle.noticeOptions(defaults), retry: retry,
                   issue: FailureNoticeIssueTarget(repo: Self.issueRepo, poster: poster),
                   environment: { await FailureEnvironment.load() })
    }

    func close() { panel.close() }
}

// MARK: - The Rename prompt

/// Rename's question in a small titled panel that takes the typing without activating the recorder, so its other
/// windows (the library, an editor) stay where they are. Return renames, Escape and ⌘W cancel.
@MainActor
final class RecorderTitlePrompt: NSObject, NSWindowDelegate {
    private static var current: RecorderTitlePrompt?

    let panel: RecorderTitlePanel
    private var done: ((String?) -> Void)?

    static func show(_ request: RecorderTitleRequest, done: @escaping (String?) -> Void) {
        current?.finish(nil)
        let prompt = RecorderTitlePrompt(request, done: done)
        current = prompt
        prompt.present()
    }

    init(_ request: RecorderTitleRequest, done: @escaping (String?) -> Void) {
        self.done = done
        panel = RecorderTitlePanel(contentRect: .zero, styleMask: [.titled, .closable, .fullSizeContentView, .nonactivatingPanel],
                                   backing: .buffered, defer: false)
        super.init()
        let host = NSHostingView(rootView: RecorderTitlePromptView(request: request) { [weak self] answer in
            self?.finish(answer)
        }.titlebarZone())
        // The title bar is empty (no title, no buttons), so it is no safe area: the content starts at the panel's top
        // edge, and the fitting size below is the content's own, with no band above the heading or under the buttons.
        host.safeAreaRegions = []
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

struct RecorderTitlePromptView: View {
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
        // One 18 pt inset all round; the host gives the empty title bar no safe area (review 2026-11-06).
        .padding(18)
        .frame(width: 360)
        .onAppear { DispatchQueue.main.async { focused = true } }
    }
}

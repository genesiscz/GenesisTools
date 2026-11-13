import AppKit
import SwiftUI

/// What a failure notice shows and the person's choices in it: whether the details are open, which tab, whether the
/// window took a size of the person's own (then the details fill it instead of fitting their content).
@MainActor
public final class FailureNoticeModel: ObservableObject {
    public enum Tab: Hashable, Sendable {
        case summary, raw
    }

    /// The environment arrives after the window opens; the texts built from the report follow it.
    @Published public var report: FailureReport {
        didSet {
            guard report != oldValue else { return }
            detailsMarkdown = report.detailsMarkdown()
            rawMarkdown = Self.rawMarkdown(report)
            stackText = Self.stackText(report)
            // A report enriched after delivery (`addingCallLog`) brings its events, or another failure its time.
            timeText = Self.timeText(report)
            stepCount = Self.stepCount(report)
        }
    }
    @Published public var detailsOpen: Bool
    @Published public var tab: Tab = .summary
    @Published var stackOpen = false
    @Published public var userSized = false
    @Published var copied: CopyKind?
    /// The tallest the details may grow before they scroll, while the window fits its content.
    @Published public var detailsCap: CGFloat
    let retry: (@MainActor () -> Void)?
    /// Opens the "Draft an issue" window; nil hides the button.
    var draftIssue: (@MainActor () -> Void)?
    let dismiss: @MainActor () -> Void
    /// The details as markdown and the time line, built once per report rather than per body.
    private(set) var detailsMarkdown: String
    private(set) var rawMarkdown: String
    private(set) var stackText: String?
    private(set) var timeText: String
    private(set) var stepCount: Int

    enum CopyKind: Equatable {
        case context, log
    }

    public init(report: FailureReport, detailsOpen: Bool, detailsCap: CGFloat = 420, retry: (@MainActor () -> Void)?,
                dismiss: @escaping @MainActor () -> Void) {
        self.report = report
        self.detailsOpen = detailsOpen && report.hasLog
        self.detailsCap = detailsCap
        self.retry = retry
        self.dismiss = dismiss
        detailsMarkdown = report.detailsMarkdown()
        rawMarkdown = Self.rawMarkdown(report)
        stackText = Self.stackText(report)
        timeText = Self.timeText(report)
        stepCount = Self.stepCount(report)
    }

    static func timeText(_ report: FailureReport) -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .medium
        return formatter.string(from: report.time)
    }

    static func stepCount(_ report: FailureReport) -> Int {
        FailureLog.events(in: report.log).count
    }

    /// "Raw log": everything the report knows as plain text (`FailureReport.rawText`), in one code block.
    static func rawMarkdown(_ report: FailureReport) -> String {
        "```text\n" + report.rawText().trimmingCharacters(in: .newlines) + "\n```\n"
    }

    static func stackText(_ report: FailureReport) -> String? {
        var stacks: [String] = []
        for value in [report.stack].compactMap({ $0 }) + FailureLog.events(in: report.log).map({ $0.stack.joined(separator: "\n") }) {
            let stack = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if !stack.isEmpty, !stacks.contains(stack) { stacks.append(stack) }
        }
        return stacks.isEmpty ? nil : stacks.joined(separator: "\n\n")
    }

    public func copyContext() {
        Clipboard.copy(report.agentContext(), what: "the context for agents")
        flash(.context)
    }

    public func copyLog() {
        Clipboard.copy(report.rawText(), what: "the log")
        flash(.log)
    }

    public func openLog() {
        guard let file = report.logFile else { return }
        PathOpener.cursor(file, line: report.logLine)
    }

    public func revealFolder() {
        guard let folder = report.folder else { return }
        PathOpener.finder(folder)
    }

    public var folderExists: Bool {
        report.folder.map { FileManager.default.fileExists(atPath: $0) } ?? false
    }

    public var logExists: Bool {
        report.logFile.map { FileManager.default.fileExists(atPath: $0) } ?? false
    }

    private func flash(_ kind: CopyKind) {
        copied = kind
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(1400))
            if self?.copied == kind {
                self?.copied = nil
            }
        }
    }
}

/// A failure in a window of its own: the real error as the headline, what was running and what to do, the actions
/// (Try again, Copy context for agents, Copy log, Open log, Show folder), and the log rendered as markdown: the error,
/// each warning with its fields and pretty JSON, then every step. A disclosure shows the whole stack; "Raw log"
/// shows the output as it came. The window is the container: no card inside it.
public struct FailureNoticeView: View {
    @ObservedObject var model: FailureNoticeModel
    @GenReduceMotion private var reduceMotion

    public init(model: FailureNoticeModel) {
        self.model = model
    }

    private static let inset: CGFloat = 18

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
                .padding(.horizontal, Self.inset)
                .padding(.top, 14)
                .padding(.bottom, 12)
            actions
                .padding(.horizontal, Self.inset)
                .padding(.bottom, 12)
            if model.report.hasLog {
                Divider()
                detailsBar
                    .padding(.horizontal, Self.inset)
                    .padding(.vertical, 8)
                if model.detailsOpen {
                    details
                        .transition(.genReveal)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: model.userSized ? .infinity : nil, alignment: .topLeading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(model.report.title))
    }

    // MARK: - Header

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 15))
                .foregroundStyle(KitPalette.removed)
                .accessibilityLabel(Text("Error"))
            VStack(alignment: .leading, spacing: 5) {
                Text(model.report.headline)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Color.white.opacity(0.95))
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .accessibilityAddTraits(.isHeader)
                if let summary = model.report.summary {
                    Text(verbatim: "\(summary) \(model.timeText)")
                        .font(.system(size: 11.5))
                        .foregroundStyle(KitPalette.dim)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let next = model.report.nextStep {
                    Text(next)
                        .font(.system(size: 12))
                        .foregroundStyle(Color.white.opacity(0.78))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: - Actions

    private var actions: some View {
        WrapLayout(spacing: 8, lineSpacing: 8) {
            if let retry = model.retry {
                Button {
                    retry()
                } label: {
                    Label("Try again", systemImage: "arrow.clockwise")
                        .font(.system(size: 12))
                }
                .buttonStyle(.genPrimary())
                .keyboardShortcut("r", modifiers: .command)
                .instantTooltip("Run the same action again (⌘R)")
                .accessibilityIdentifier("failure-notice.retry")
            }
            GhostButton(model.copied == .context ? "Copied" : "Copy context for agents",
                        symbol: model.copied == .context ? "checkmark" : "sparkles",
                        tooltip: "Copy the error, what ran, the app's build, the log files and the whole output as markdown (⌘C)",
                        identifier: "failure-notice.copy-context") { model.copyContext() }
            if let draftIssue = model.draftIssue {
                GhostButton("Draft an issue", symbol: "exclamationmark.bubble",
                            tooltip: "Review the issue's title and body, redact what is private, then post it to GitHub",
                            identifier: "failure-notice.draft-issue") { draftIssue() }
            }
            if model.report.hasLog {
                GhostButton(model.copied == .log ? "Copied" : "Copy log", symbol: model.copied == .log ? "checkmark" : "doc.on.doc",
                            tooltip: "Copy the command's whole output", identifier: "failure-notice.copy-log") { model.copyLog() }
            }
            if model.logExists {
                GhostButton("Open log", symbol: "doc.text.magnifyingglass",
                            tooltip: "Open the log file in Cursor at this run's first line", identifier: "failure-notice.open-log") {
                    model.openLog()
                }
            }
            if model.folderExists {
                GhostButton("Show folder", symbol: "folder",
                            tooltip: "Open the folder this failure is about in Finder", identifier: "failure-notice.folder") {
                    model.revealFolder()
                }
            }
        }
    }

    // MARK: - Details

    private var detailsBar: some View {
        HStack(spacing: 10) {
            Button {
                GenMotion.perform(expanding: !model.detailsOpen, reduceMotion: reduceMotion) { model.detailsOpen.toggle() }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .rotationEffect(.degrees(model.detailsOpen ? 90 : 0))
                    Text(model.detailsOpen ? "Details" : "Show details")
                        .font(.system(size: 11.5, weight: .medium))
                    if !model.detailsOpen, model.stepCount > 0 {
                        Text(verbatim: "\(Plural.count(model.stepCount, "step")) logged")
                            .font(.system(size: 11))
                            .foregroundStyle(KitPalette.dim)
                    }
                }
                .foregroundStyle(Color.white.opacity(0.85))
                .contentShape(Rectangle())
            }
            .buttonStyle(.genHoverPlain())
            .instantTooltip(model.detailsOpen ? "Hide the log" : "Show the log")
            .accessibilityValue(Text(model.detailsOpen ? "Expanded" : "Collapsed"))
            .accessibilityIdentifier("failure-notice.details")
            Spacer(minLength: 8)
            if model.detailsOpen {
                GenSegmentedTabs("Log view", items: [.init(FailureNoticeModel.Tab.summary, "Summary"), .init(.raw, "Raw log")],
                                 selection: $model.tab, minSegmentWidth: 70, identifier: "failure-notice.tab")
            }
        }
    }

    @ViewBuilder
    private var details: some View {
        let content = VStack(alignment: .leading, spacing: 8) {
            if model.tab == .summary, let stack = model.stackText {
                GenDisclosure("Stack trace", isExpanded: $model.stackOpen, identifier: "failure-notice.stack") {
                    Text(verbatim: PathDisplay.shortenHome(in: stack))
                        .font(.system(size: 11, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            MarkdownContentView(markdown: model.tab == .summary ? model.detailsMarkdown : model.rawMarkdown,
                                style: Self.style)
        }
            .padding(.horizontal, Self.inset)
            .padding(.bottom, 14)
            .id(model.tab)
        if model.userSized {
            ScrollView {
                content.scrollOverflowContent()
            }
            .scrollOverflowHints()
            .frame(maxHeight: .infinity)
        } else {
            FittedScroll(maxHeight: model.detailsCap, initialHeight: model.detailsCap) { content }
        }
    }

    /// The hub's panel style at a 12 pt body, every block selectable, code wrapped.
    static let style = MarkdownStyle.hub.with {
        $0.bodySize = 12
        $0.blockSpacing = 8
        $0.headingSizes = [15, 14, 13, 12.5, 12, 11]
        $0.codeFontSize = 11
    }
}

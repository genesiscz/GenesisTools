import AppKit
import SwiftUI

/// The one owner of the failure window and the issue target for failures shown in place (a pane, a strip, a notice):
/// a hub pane, a widget card and a settings page reach the same window, so a second failure replaces the first
/// instead of stacking windows. The recorder keeps its own window under its menu bar item, with its own settings.
@MainActor
public final class FailureReporter {
    public static let shared = FailureReporter()

    /// The repository "Report a bug" posts to.
    public static let issueRepo = "genesiscz/GenesisTools"
    /// A test switch (off): a post only prints what it would send.
    public static let dryRunKey = "failure.debug.issueDryRun"

    /// Where "Report a bug" posts; nil hides the button.
    public var issueTarget: () -> FailureNoticeIssueTarget? = { FailureReporter.defaultIssueTarget() }
    /// The failure window's behaviour: open with the log shown, over the screen under the pointer.
    public var options: () -> FailureNoticeOptions = { FailureNoticeOptions(detailsOpen: true, placement: .center) }
    /// The environment facts an issue carries (`tools genesis-tools env --json`).
    public var environment: @Sendable () async -> FailureEnvironment? = { await FailureEnvironment.load() }
    /// Every Details and Report a bug, for a test.
    public var onOpen: ((_ what: String, _ report: FailureReport) -> Void)?

    private lazy var panel = FailureNoticePanel(identifier: "failure.notice")
    private var facts: FailureEnvironment?
    private var loading: Task<FailureEnvironment?, Never>?

    public init() {}

    /// The repository's issue target, posted through `tools github issues post`; `dryRunKey` names the test switch
    /// (the recorder keeps its own).
    public static func defaultIssueTarget(defaults: UserDefaults = .standard,
                                          dryRunKey: String = FailureReporter.dryRunKey) -> FailureNoticeIssueTarget {
        FailureNoticeIssueTarget(repo: issueRepo, poster: ToolsIssuePoster(dryRun: defaults.bool(forKey: dryRunKey)))
    }

    public var isShowingDetails: Bool { panel.isVisible }

    /// Opens the failure window on `report`: its summary, its log, Copy context for agents, Copy log, Open log, Draft
    /// an issue, and Try again when `retry` is given.
    public func showDetails(_ report: FailureReport, retry: (@MainActor () -> Void)? = nil) {
        onOpen?("details", report)
        let environment = self.environment
        panel.show(report, options: options(), retry: retry, issue: issueTarget(),
                   environment: { [weak self] in
                       if let known = await self?.cachedFacts() { return known }
                       return await environment()
                   })
    }

    /// Opens the issue draft for `report` with the environment facts, read once per run of the app.
    public func reportBug(_ report: FailureReport) {
        onOpen?("issue", report)
        guard let target = issueTarget() else { return }
        Task { @MainActor in
            var report = report
            if report.environment == nil {
                report.environment = await self.environmentFacts(within: 4)
            }
            IssueDraftWindow.show(IssueDraft.failure(report, repo: target.repo, labels: target.labels), poster: target.poster,
                                  near: NSApp.keyWindow)
        }
    }

    /// Starts reading the environment facts, so a later Report a bug does not wait for them.
    public func prefetchEnvironment() {
        guard facts == nil, loading == nil else { return }
        let environment = self.environment
        loading = Task { @MainActor [weak self] in
            let found = await environment()
            self?.facts = found
            return found
        }
    }

    private func cachedFacts() async -> FailureEnvironment? {
        if let facts { return facts }
        return await loading?.value
    }

    /// The facts, waiting at most `seconds` for a read already under way: an issue without them still says the app's
    /// build and macOS.
    private func environmentFacts(within seconds: Double) async -> FailureEnvironment? {
        prefetchEnvironment()
        if let facts { return facts }
        guard let loading else { return nil }
        return await withTaskGroup(of: FailureEnvironment?.self) { group in
            group.addTask { await loading.value }
            group.addTask {
                try? await Task.sleep(for: .seconds(seconds))
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }
}

/// A failure shown where the data should be: the headline a person reads, one quiet line of what ran and how it
/// ended, and Try again (when `retry` is given), Details (the failure window on this report) and Report a bug (the
/// issue draft). `.pane` stands in for a whole pane, centred; `.compact` is one line for a strip, a row or a card.
/// Never a raw error string in red.
public struct FailureInline: View {
    public enum Form: Sendable {
        /// Centred in a pane whose data did not load.
        case pane
        /// One line for a strip, a row or a card; it wraps under the buttons when the row is narrow.
        case compact
    }

    let report: FailureReport
    let retry: (@MainActor () -> Void)?
    let form: Form
    let identifier: String
    let reporter: FailureReporter

    public init(_ report: FailureReport, form: Form = .pane, identifier: String = "failure-inline",
                reporter: FailureReporter = .shared, retry: (@MainActor () -> Void)? = nil) {
        self.report = report
        self.retry = retry
        self.form = form
        self.identifier = identifier
        self.reporter = reporter
    }

    public var body: some View {
        Group {
            switch form {
            case .pane: pane
            case .compact: compact
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(verbatim: "Error: \(report.headline)"))
        .accessibilityIdentifier(identifier)
        .onAppear {
            reporter.prefetchEnvironment()
            AccessibilityNotification.Announcement(report.headline).post()
        }
    }

    // MARK: - Forms

    private var pane: some View {
        VStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 22))
                .foregroundStyle(KitHue.danger.ink)
                .accessibilityHidden(true)
            Text(verbatim: report.headline)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(KitPalette.text)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .accessibilityAddTraits(.isHeader)
            if let summary = report.summary {
                Self.inlineMarkdown(summary)
                    .font(.system(size: 11.5))
                    .foregroundStyle(KitPalette.dim)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            WrapLayout(spacing: 8, lineSpacing: 8) {
                buttons(size: .regular)
            }
            .padding(.top, 4)
        }
        .frame(maxWidth: 460)
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var compact: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .center, spacing: 8) {
                compactText
                    .layoutPriority(1)
                Spacer(minLength: 6)
                HStack(spacing: 6) { buttons(size: .small) }
                    .fixedSize()
            }
            VStack(alignment: .leading, spacing: 6) {
                compactText
                WrapLayout(spacing: 6, lineSpacing: 6) { buttons(size: .small) }
            }
        }
        .padding(.vertical, 4)
    }

    private var compactText: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 11))
                .foregroundStyle(KitHue.danger.ink)
                .accessibilityHidden(true)
            // One paragraph: the headline, then what ran in the quiet colour. It wraps, never truncates.
            (Text(verbatim: report.headline).foregroundColor(KitPalette.text)
                + Text(verbatim: report.summary == nil ? "" : "  ")
                + Self.inlineMarkdown(report.summary ?? "").font(.system(size: 11)).foregroundColor(KitPalette.dim))
                .font(.system(size: 12, weight: .medium))
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
    }

    @ViewBuilder
    private func buttons(size: KitControlSize) -> some View {
        if let retry {
            KitButton("Try again", symbol: "arrow.clockwise", kind: .primary, hue: .play, size: size,
                      tooltip: "Run the same load again", identifier: "\(identifier).retry") { retry() }
        }
        KitButton("Details", symbol: "doc.text.magnifyingglass", kind: .ghost, size: size,
                  tooltip: "Open the failure window: what ran, the log, Copy context for agents",
                  identifier: "\(identifier).details") {
            reporter.showDetails(report, retry: retry)
        }
        if reporter.issueTarget() != nil {
            KitButton("Report a bug", symbol: "exclamationmark.bubble", kind: .ghost, size: size,
                      tooltip: "Draft a GitHub issue from this failure; you read and redact it before it is posted",
                      identifier: "\(identifier).report") {
                reporter.reportBug(report)
            }
        }
    }

    /// `code` in a summary reads as code; anything markdown cannot parse shows as it is.
    static func inlineMarkdown(_ text: String) -> Text {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        if let parsed = try? AttributedString(markdown: text, options: options) {
            return Text(parsed)
        }
        return Text(verbatim: text)
    }
}

public extension NoticeFix {
    /// "Details": opens the failure window on `report` (class B: an action that failed and shows as a notice).
    @MainActor
    static func details(_ report: FailureReport, retry: (@MainActor () -> Void)? = nil,
                        reporter: FailureReporter = .shared) -> NoticeFix {
        .button("Details", symbol: "doc.text.magnifyingglass") { reporter.showDetails(report, retry: retry) }
    }
}

public extension StackedNotice.Action {
    /// "Details" on a stacked notice: the failure window on `report`; the notice stays.
    @MainActor
    static func details(_ report: FailureReport, retry: (@MainActor () -> Void)? = nil,
                        reporter: FailureReporter = .shared) -> StackedNotice.Action {
        StackedNotice.Action("Details", symbol: "doc.text.magnifyingglass", afterPress: .keep) { _ in
            reporter.showDetails(report, retry: retry)
        }
    }
}

public extension FailureAppFacts {
    /// The facts read once when first asked: the build of a running process does not change.
    static let launch = FailureAppFacts.current()
}

public extension FailureInline {
    /// A failure the caller holds only as words (a stored error string): the report is made from them, with the
    /// words as its log. Cheap enough for a view body.
    init(message: String, outcome: String, action: String, area: String? = nil, form: Form = .compact,
         identifier: String = "failure-inline", retry: (@MainActor () -> Void)? = nil) {
        self.init(FailureReport.unexpected(message, outcome: outcome, action: action, area: area, app: .launch),
                  form: form, identifier: identifier, retry: retry)
    }
}

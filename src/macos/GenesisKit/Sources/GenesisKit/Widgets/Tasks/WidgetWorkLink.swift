import SwiftUI

/// Work accepts a canonical item id, or the ledger id of a session TODO predating the work store.
struct WidgetWorkLink {
    let id: String
    let title: String
    var body: String?
    var acceptance: String?
    var repoRoot: String?

    init(id: String, title: String, body: String? = nil, acceptance: String? = nil, repoRoot: String? = nil) {
        self.id = id
        self.title = title
        self.body = body
        self.acceptance = acceptance
        self.repoRoot = repoRoot
    }

    init(_ task: WidgetTask) {
        self.init(id: task.workRef ?? task.id, title: task.fullTitle ?? task.title, body: task.fullText ?? task.summary,
                  acceptance: task.acceptance, repoRoot: task.sourceContext.repoRoot ?? task.sourceContext.cwd)
    }

    static func destination(_ ref: String?) -> URL {
        destination(ref.map { URLQueryItem(name: "work", value: $0) } ?? URLQueryItem(name: "mode", value: "work"))
    }

    static func project(_ project: String) -> URL {
        destination(URLQueryItem(name: "work-project", value: project))
    }

    private static func destination(_ query: URLQueryItem) -> URL {
        var link = URLComponents()
        link.scheme = "genesis-tools"
        link.host = "hub"
        link.queryItems = [query]
        return link.url!
    }

    var tooltip: String {
        [title, body == title ? nil : body, acceptance.map { "Acceptance\n\($0)" }]
            .compactMap { $0 }.joined(separator: "\n\n")
    }

    /// Plain paths in prose, including backtick-quoted paths with spaces. Markdown links go through PathLink.
    private static let planPattern = try! NSRegularExpression(
        pattern: #"(?<![\w/:.-])(?:[\x60"']((?:[~/][^\x60"'\n]*?/)?\.claude/plans/[^\x60"'\n]+)[\x60"']|((?:[~/][^\s\x60"'()<>]*?/)?\.claude/plans/[^\s\x60"'()<>,;:#]+))"#)

    var plan: URL? {
        guard title.contains(".claude/plans/") || body?.contains(".claude/plans/") == true else { return nil }
        let text = [title, body].compactMap { $0 }.joined(separator: "\n")
        func resolve(_ path: String) -> URL? {
            let url: URL
            if let absolute = PathLink.fileURL(path) { url = absolute }
            else if let repoRoot, let root = PathLink.fileURL(repoRoot) { url = root.appendingPathComponent(path).standardizedFileURL }
            else { return nil }
            return url.path.contains("/.claude/plans/") && !path.hasSuffix("/") ? url : nil
        }
        for link in PathLink.pathLinks(inMarkdown: text) {
            if let url = resolve(link.path) { return url }
        }
        let raw = text as NSString
        for match in Self.planPattern.matches(in: text, range: NSRange(location: 0, length: raw.length)) {
            let quoted = match.range(at: 1)
            let path = raw.substring(with: quoted.location == NSNotFound ? match.range(at: 2) : quoted)
            if let url = resolve(path.hasSuffix(".") ? String(path.dropLast()) : path) { return url }
        }
        return nil
    }
}

struct WidgetWorkButton<Label: View>: View {
    let item: WidgetWorkLink
    let showTooltip: Bool
    var parentPlan: (() -> URL?)? = nil
    @ViewBuilder let label: () -> Label
    @Environment(\.openURL) private var openURL

    var body: some View {
        let plan = item.plan ?? parentPlan?()
        HStack(spacing: 4) {
            Button(action: open) {
                label().frame(maxWidth: .infinity, minHeight: 26, alignment: .leading).contentShape(Rectangle())
            }
            .buttonStyle(RowButtonStyle())
            .instantTooltip(showTooltip ? item.tooltip : "")
            .accessibilityLabel(item.title)
            .accessibilityValue(item.acceptance ?? "")
            .accessibilityHint("Opens this item in Work")
            .accessibilityIdentifier("tasks.open.\(item.id)")
            .contextMenu {
                Button("Open in Work", action: open)
                Button("Copy id") { Clipboard.copy(item.id, what: "id") }
                if let plan {
                    Button("Open plan") { openPlan(plan) }
                }
            }
            if let plan {
                IconButton(systemName: "doc.text", tooltip: "Open plan: \(plan.lastPathComponent)") { openPlan(plan) }
            }
        }
    }

    private func openPlan(_ plan: URL) {
        if PathLink.isMarkdown(plan) {
            openURL(plan) { accepted in
                if !accepted { CopyToast.post(title: "Could not open the plan", detail: plan.lastPathComponent, style: .problem) }
            }
        } else { PathOpener.primary(plan.path) }
    }

    private func open() {
        openURL(WidgetWorkLink.destination(item.id)) { opened in
            if !opened { CopyToast.post(title: "Could not open Work", detail: item.title, style: .problem) }
        }
    }
}

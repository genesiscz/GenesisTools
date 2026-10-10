import SwiftUI

/// Value-only presentation shared by the Hub agent tree and compact session pickers.
public struct AgentRosterRow: View {
    public let title: String
    public let provider: String
    public let role: String
    public var model: String?
    public var account: String?
    public let status: String
    public var startedAt: Date?
    public var lastAt: Date?
    public var toolCalls: Int
    public var unread: Int
    public var selected: Bool
    public var showsRunningLabel: Bool

    public init(title: String, provider: String, role: String, model: String? = nil, account: String? = nil,
                status: String, startedAt: Date? = nil, lastAt: Date? = nil, toolCalls: Int = 0,
                unread: Int = 0, selected: Bool = false, showsRunningLabel: Bool = false) {
        self.title = title
        self.provider = provider
        self.role = role
        self.model = model
        self.account = account
        self.status = status
        self.startedAt = startedAt
        self.lastAt = lastAt
        self.toolCalls = toolCalls
        self.unread = unread
        self.selected = selected
        self.showsRunningLabel = showsRunningLabel
    }

    public var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Circle().fill(AgentRosterStyle.color(status)).frame(width: 7, height: 7).padding(.top, 5)
                .instantTooltip(status)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(title).font(.system(size: 12, weight: selected ? .semibold : .medium)).lineLimit(1)
                    Spacer(minLength: 0)
                    if unread > 0 {
                        CountBadge(unread, tooltip: "\(Plural.count(unread, "unread message"))", color: KitPalette.modified)
                    }
                    if showsRunningLabel && status == "running" {
                        Text("running").foregroundStyle(KitPalette.added).font(.system(size: 10.5)).fixedSize()
                    } else {
                        LiveAgo(date: lastAt, style: .brief).font(.system(size: 10.5))
                            .foregroundStyle(status == "running" ? KitPalette.added : KitPalette.dim).fixedSize()
                    }
                }
                HStack(spacing: 5) {
                    Badge(provider, color: AgentRosterStyle.harnessColor(provider), look: .filled)
                    Badge(role)
                    // The model's family word ("opus", never "claude-…"), then the account; both give way before the numbers.
                    if let model, !model.isEmpty {
                        Text(verbatim: SessionNativeLog.shortModel(model)).lineLimit(1).layoutPriority(-1)
                    }
                    if let account, !account.isEmpty {
                        Text(verbatim: account).truncationMode(.tail).layoutPriority(-2)
                    }
                    Spacer(minLength: 0)
                    // Words when they fit, glyphs when they do not: "247 tools · run 1h 05m" ran past a 320 pt sidebar.
                    ViewThatFits(in: .horizontal) {
                        stats(words: true)
                        stats(words: false)
                    }
                    .font(.system(size: 10.5, design: .monospaced))
                }.font(.system(size: 10.5)).foregroundStyle(KitPalette.dim).lineLimit(1)
            }
        }.contentShape(Rectangle())
    }

    /// The tool count and run time: "247 tools · run 1h 05m", or "⚒247 ▸1h 05m" where the words do not fit.
    private func stats(words: Bool) -> some View {
        HStack(spacing: words ? 0 : 5) {
            if toolCalls > 0 {
                if words {
                    Text(verbatim: Plural.count(toolCalls, "tool"))
                } else {
                    HStack(spacing: 2) {
                        Image(systemName: "hammer").font(.system(size: 9))
                        Text(verbatim: "\(toolCalls)")
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(Plural.count(toolCalls, "tool"))
                }
            }
            if status == "running", let startedAt {
                LiveTime(date: startedAt, style: .compact) { words ? (toolCalls > 0 ? " · " : "") + "run " + $0 : "▸" + $0 }
            } else if let duration = AgentRosterStyle.duration(from: startedAt, to: lastAt) {
                Text(verbatim: words ? (toolCalls > 0 ? " · " : "") + "ran " + duration : duration)
            }
        }
        .fixedSize()
    }
}

public struct AgentRosterGroupLabel: View {
    public let title: String
    public let provider: String
    public var project: String?
    public var account: String?
    public let total: Int
    public let running: Int
    public var live: Bool
    public var lastAt: Date?

    public init(title: String, provider: String, project: String? = nil, account: String? = nil,
                total: Int, running: Int, live: Bool, lastAt: Date? = nil) {
        self.title = title
        self.provider = provider
        self.project = project
        self.account = account
        self.total = total
        self.running = running
        self.live = live
        self.lastAt = lastAt
    }

    public var body: some View {
        HStack(alignment: .top, spacing: 7) {
            ZStack(alignment: .bottomTrailing) {
                ProviderBadge(provider: provider)
                if live {
                    Circle().fill(KitPalette.added).frame(width: 7, height: 7)
                        .overlay(Circle().stroke(Color(KitPalette.background), lineWidth: 1.5)).offset(x: 3, y: 3)
                }
            }.padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.system(size: 12.5, weight: .semibold)).lineLimit(2)
                HStack(spacing: 6) {
                    if let project { Text(project).layoutPriority(-2) }
                    if let account {
                        Text(account).padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Capsule().stroke(.white.opacity(0.15))).layoutPriority(-1)
                    }
                    // `total` counts sub-agents; the session's own Main row is listed under it, so "0 agents" read wrong.
                    Text(verbatim: total == 0 ? "no sub-agents" : running > 0 ? "\(Plural.count(total, "sub-agent")) · \(running) running" : Plural.count(total, "sub-agent"))
                        .foregroundStyle(running > 0 ? KitPalette.added : KitPalette.dim).fixedSize()
                    Spacer(minLength: 0)
                    LiveAgo(date: lastAt, style: .brief).fixedSize()
                }.font(.system(size: 10.5)).foregroundStyle(KitPalette.dim).lineLimit(1)
            }
        }.contentShape(Rectangle())
    }
}

public enum AgentRosterStyle {
    public static func color(_ status: String) -> Color {
        switch status {
        case "running", "working": return KitPalette.added
        case "idle": return KitPalette.renamed
        case "failed": return KitPalette.removed
        case "killed", "waiting": return KitPalette.modified
        default: return .white.opacity(0.3)
        }
    }

    public static func harnessColor(_ provider: String) -> Color {
        switch provider {
        case "codex": return Color(red: 0.45, green: 0.8, blue: 0.75)
        case "grok": return Color(red: 0.75, green: 0.6, blue: 0.95)
        default: return Color(red: 0.9, green: 0.6, blue: 0.4)
        }
    }

    public static func duration(from start: Date?, to end: Date?) -> String? {
        guard let start, let end, end >= start else { return nil }
        let seconds = Int(end.timeIntervalSince(start))
        if seconds < 60 { return "\(seconds)s" }
        if seconds < 3600 { return "\(seconds / 60)m \(String(format: "%02d", seconds % 60))s" }
        return "\(seconds / 3600)h \(String(format: "%02d", (seconds % 3600) / 60))m"
    }
}

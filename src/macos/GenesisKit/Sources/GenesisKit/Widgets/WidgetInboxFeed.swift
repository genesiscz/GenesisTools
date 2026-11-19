import SwiftUI

struct WidgetFeedRun: Equatable, Identifiable {
    let id: String
    let runKey: String
    var items: [WidgetInboxItem]

    var spansSessions: Bool {
        guard let first = items.first, first.message?.origin == nil else { return false }
        return items.dropFirst().contains { $0.key != first.key }
    }
}

/// Both feed hosts put a lone item's source in the row. A project shared by several sessions
/// names the project above the rows and leaves each row to identify its own session.
struct WidgetFeedSection<Row: View>: View {
    let run: WidgetFeedRun
    let model: WidgetModel
    var surface: WidgetSurfaceID?
    let first: Bool
    @ViewBuilder let row: (WidgetInboxItem, WidgetInboxRowContext) -> Row

    var body: some View {
        if run.items.count == 1, model.preferences.inboxFeedHeaders != "all", let item = run.items.first {
            row(item, .inlineSource)
        } else {
            let context: WidgetInboxRowContext = run.spansSessions ? .projectHeader : .sessionHeader
            Section {
                ForEach(run.items, id: \.id) { row($0, context) }
            } header: {
                WidgetFeedRunHeader(run: run, model: model, surface: surface).equatable()
                    .padding(.top, first ? 0 : 6)
            }
        }
    }
}

enum WidgetInboxFeed {
    static func newer(_ lhs: WidgetInboxItem, _ rhs: WidgetInboxItem) -> Bool {
        lhs.at == rhs.at ? lhs.id < rhs.id : lhs.at > rhs.at
    }

    static func runs(_ items: [WidgetInboxItem], by: String,
                     project: (WidgetInboxItem) -> String?) -> [WidgetFeedRun] {
        var result: [WidgetFeedRun] = []
        for item in items.sorted(by: newer) {
            let key: String
            if let sender = item.message?.origin {
                key = "sender/" + sender
            } else if by == "project", let name = project(item), !name.isEmpty {
                key = "project/" + name
            } else {
                key = item.key
            }
            if result.last?.runKey == key {
                result[result.count - 1].items.append(item)
            } else {
                result.append(.init(id: key + "|" + item.id, runKey: key, items: [item]))
            }
        }
        return result
    }
}

/// Built when the snapshot or the run preference changes. Waiting and unread each have their own consecutive runs.
struct WidgetInboxFeeds {
    let all: [WidgetFeedRun]
    let waiting: [WidgetFeedRun]
    let unread: [WidgetFeedRun]

    init(_ items: [WidgetInboxItem] = [], by: String = "session", project: (WidgetInboxItem) -> String? = { _ in nil }) {
        all = WidgetInboxFeed.runs(items, by: by, project: project)
        waiting = WidgetInboxFeed.runs(items.filter(\.needsAnswer), by: by, project: project)
        unread = WidgetInboxFeed.runs(items.filter { !$0.needsAnswer }, by: by, project: project)
    }

    subscript(filter: String) -> [WidgetFeedRun] {
        switch filter {
        case "needs": return waiting
        case "unread": return unread
        default: return all
        }
    }
}

struct WidgetFeedRunHeader: View, Equatable {
    let id: String
    let provider: String?
    let title: String
    let subtitle: String?
    let counts: String
    let waiting: Bool
    let inboxTooltip: String
    let openInbox: (() -> Void)?

    @MainActor init(run: WidgetFeedRun, model: WidgetModel, surface: WidgetSurfaceID? = nil) {
        id = run.id
        let first = run.items.first
        let external = first?.message?.origin
        let session = external == nil ? first.flatMap { model.session(forKey: $0.key) } : nil
        provider = run.spansSessions ? nil : session?.target.provider
        let project = session?.project ?? ""
        title = external ?? (project.isEmpty ? session?.title ?? "Unknown session" : project)
        let sessions = Set(run.items.map(\.key)).count
        // A session named after its only item (an agent result) would print the same words twice: the row keeps them.
        let sessionTitle = run.items.count == 1 && session?.title == first.map(WidgetInboxOverview.title)
            ? nil : session?.title
        subtitle = sessions > 1 ? Plural.count(sessions, "session") : (project.isEmpty ? nil : sessionTitle)
        let count = run.items.filter(\.needsAnswer).count
        waiting = count > 0
        // One item says what it is in its own row (kind, waiting, time); a count only adds words.
        counts = run.items.count < 2 ? "" : [Plural.count(run.items.count, "item"), count > 0 ? WidgetWords.waitingShort(count) : nil]
            .compactMap { $0 }.joined(separator: " · ")
        inboxTooltip = "Open the whole inbox of " + (session?.title ?? "this session")
        if let session, !run.spansSessions {
            openInbox = {
                model.openSessionInbox(session, on: surface)
            }
        } else {
            openInbox = nil
        }
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.id == rhs.id && lhs.provider == rhs.provider && lhs.title == rhs.title && lhs.subtitle == rhs.subtitle
            && lhs.counts == rhs.counts && lhs.waiting == rhs.waiting && lhs.inboxTooltip == rhs.inboxTooltip
            && (lhs.openInbox == nil) == (rhs.openInbox == nil)
    }

    var body: some View {
        HStack(spacing: 5) {
            if let provider { AIProviderGlyph(meta: AIProviders.meta(for: provider), size: 14) }
            Text(title).fontWeight(.semibold).lineLimit(1).layoutPriority(1)
            if let subtitle {
                Text("·").foregroundStyle(.secondary)
                Text(subtitle).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
            }
            Spacer(minLength: 0)
            if !counts.isEmpty {
                Text(counts).font(.system(size: 10)).foregroundStyle(waiting ? Color.orange : .secondary)
                    .lineLimit(1).fixedSize()
            }
            if let openInbox {
                // A glyph, not words: the feed has a header per run, and "Whole inbox" on each one read as a column.
                IconButton(systemName: "tray", tooltip: inboxTooltip, size: 11, action: openInbox)
                    .accessibilityLabel(inboxTooltip)
            }
        }
        .font(.system(size: 11.5))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("widget.feed.run." + id)
        .liveRow(selected: false)
    }
}

/// Keep the displayed prefix fixed while the reader is below the top. The next visit to the top reveals all
/// arrivals together. A refresh can still update or remove any existing row, including a resolved decision.
enum WidgetFeedReadingPlace {
    static func split(_ runs: [WidgetFeedRun], at boundary: WidgetInboxItem?) -> (runs: [WidgetFeedRun], pending: Int) {
        guard let boundary, let first = runs.first?.items.first, WidgetInboxFeed.newer(first, boundary) else {
            return (runs, 0)
        }
        var pending = 0
        for (index, run) in runs.enumerated() {
            let rest = run.items.drop(while: { WidgetInboxFeed.newer($0, boundary) })
            pending += run.items.count - rest.count
            if let head = rest.first {
                let visible = WidgetFeedRun(id: run.runKey + "|" + head.id, runKey: run.runKey, items: Array(rest))
                return ([visible] + runs.dropFirst(index + 1), pending)
            }
        }
        // The entire old window has gone. Show the new data, including its first header.
        return (runs, 0)
    }
}

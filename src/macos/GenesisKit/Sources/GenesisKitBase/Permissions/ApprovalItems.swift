import AppKit
import Quartz
import SwiftUI

/// What git says about one path of a request: `state` is "untracked", "modified", "ignored", "clean" or "none"
/// (outside a repository); `lastCommit` is "a5fed04 2 days ago: …" for a tracked path.
public struct ApprovalGitState: Equatable {
    public let state: String
    public let lastCommit: String?

    public init(state: String, lastCommit: String? = nil) {
        self.state = state
        self.lastCommit = lastCommit
    }
}

/// A small coloured word on a row ("same name as its folder", "empty folder"), with a tooltip that says why it matters.
/// The word carries the meaning, so the colour is never the only signal.
public struct ApprovalChip: Equatable, Identifiable {
    public enum Tone: Equatable {
        /// Grey: worth knowing, nothing to fear.
        case quiet
        /// Amber: look before approving.
        case caution
        /// Orange: something looks wrong.
        case warning
        /// Red: work may be lost.
        case danger
    }

    public let word: String
    /// One or two sentences: why it matters.
    public let help: String
    public let tone: Tone

    public var id: String { word }

    public init(_ word: String, help: String, tone: Tone) {
        self.word = word
        self.help = help
        self.tone = tone
    }
}

/// How much a delete can lose, as the row's risk chip: grey "low risk" (nothing is there, or git or a build brings it
/// back), amber "review" (no rule allowed it, so look first), red "unsaved work" (nothing brings it back).
public struct ApprovalRisk: Equatable {
    public enum Level: Equatable {
        case low
        case review
        case unsaved
    }

    public let level: Level
    /// The tooltip: why this level ("Tracked and committed: git can bring it back.").
    public let why: String

    public init(_ level: Level, why: String) {
        self.level = level
        self.why = why
    }

    /// The chip's word.
    public var word: String {
        switch level {
        case .low: return "low risk"
        case .review: return "review"
        case .unsaved: return "unsaved work"
        }
    }

    public var chip: ApprovalChip {
        switch level {
        case .low: return ApprovalChip(word, help: why, tone: .quiet)
        case .review: return ApprovalChip(word, help: why, tone: .caution)
        case .unsaved: return ApprovalChip(word, help: why, tone: .danger)
        }
    }
}

/// One path a destructive request names, as the approval window lists it: the Finder icon, the name, where it sits,
/// its size and why no rule allowed it, with buttons that open it where a person can look before deciding.
public struct ApprovalItem: Identifiable {
    /// The path the request names (where the item was).
    public let path: String
    /// Where the item is now: the aside copy while it waits, else `path`.
    public let location: String
    public let name: String
    /// The parent folder as the caller shows it: relative to the asking session's folder ("./Design"), else with the
    /// home folder as `~`. The tooltip shows the full path.
    public let folder: String
    /// "12.4 KB", "Empty folder", "Already gone"; nil when not measured.
    public let size: String?
    /// One sentence: why it needs a person.
    public let reason: String
    /// Nothing is there any more.
    public let gone: Bool
    /// It waits in the aside folder, out of the agent's way.
    public let aside: Bool
    public let isFolder: Bool
    /// A markdown file and an app that shows it (Genesis Markdown).
    public let opensInMarkdown: Bool
    /// The Finder icon, read once when the window is built; nil draws a symbol.
    public let icon: NSImage?
    /// What git says about the path; nil when not asked.
    public let git: ApprovalGitState?
    /// A folder's contents in one phrase ("12 files, newest 2 hours ago").
    public let detail: String?
    /// Other pending requests that name the same path; they are decided with this one.
    public let alsoIn: [String]
    /// Warnings and facts as chips on the folder line ("same name as its folder", "empty folder").
    public let notes: [ApprovalChip]
    /// How much the delete can lose; nil draws no risk chip.
    public let risk: ApprovalRisk?

    public var id: String { path }

    public init(path: String, location: String? = nil, name: String, folder: String, size: String?, reason: String,
                gone: Bool, aside: Bool = false, isFolder: Bool, opensInMarkdown: Bool = false, icon: NSImage? = nil,
                git: ApprovalGitState? = nil, detail: String? = nil, alsoIn: [String] = [], notes: [ApprovalChip] = [],
                risk: ApprovalRisk? = nil) {
        self.path = path
        self.location = location ?? path
        self.name = name
        self.folder = folder
        self.size = size
        self.reason = reason
        self.gone = gone
        self.aside = aside
        self.isFolder = isFolder
        self.opensInMarkdown = opensInMarkdown
        self.icon = icon
        self.git = git
        self.detail = detail
        self.alsoIn = alsoIn
        self.notes = notes
        self.risk = risk
    }

    /// The reason, the folder's contents and the other requests, in one line or two: sentences, each with its stop.
    /// An aside row says nothing about waiting: the group's header says it.
    public var reasonLine: String {
        var parts: [String] = []
        if let detail { parts.append(detail) }
        parts.append(reason)
        if !alsoIn.isEmpty {
            parts.append("Also asked by \(alsoIn.count == 1 ? "request" : "requests") \(alsoIn.joined(separator: ", ")).")
        }
        return parts.map { part in
            let trimmed = part.trimmingCharacters(in: .whitespaces)
            return trimmed.hasSuffix(".") || trimmed.hasSuffix("!") || trimmed.hasSuffix("?") ? trimmed : "\(trimmed)."
        }.joined(separator: " ")
    }
}

/// A run of rows under one small header: the rows moved aside apart from the rows still in place, so a person sees at
/// once which ones already wait out of the agent's way.
public struct ApprovalItemGroup: Identifiable {
    /// nil draws no header (a request whose rows are all in place).
    public let title: String?
    public let items: [ApprovalItem]

    public var id: String { title ?? "rows" }

    public static let asideTitle = "Moved aside, waiting for you"
    public static let inPlaceTitle = "In place"

    /// With aside rows and rows in place: "Moved aside, waiting for you · N" first, then "In place · N". With aside rows
    /// only: one header without a count. With rows in place only: one group without a header. Each group keeps the
    /// order it was given (gone rows last).
    public static func groups(_ items: [ApprovalItem]) -> [ApprovalItemGroup] {
        let aside = items.filter(\.aside)
        let inPlace = items.filter { !$0.aside }
        if aside.isEmpty { return [ApprovalItemGroup(title: nil, items: inPlace)] }
        if inPlace.isEmpty { return [ApprovalItemGroup(title: asideTitle, items: aside)] }
        return [
            ApprovalItemGroup(title: "\(asideTitle) · \(aside.count)", items: aside),
            ApprovalItemGroup(title: "\(inPlaceTitle) · \(inPlace.count)", items: inPlace),
        ]
    }
}

/// The items of a request: plain rows split by hairlines (no card around them, Golden Gate), a scroll view with a
/// fade at the cut edge once there are more than `visibleRows`.
struct ApprovalItemList: View {
    let items: [ApprovalItem]
    let identifier: String
    /// The ids of the rows ticked; nil shows no checkboxes.
    var selection: Binding<Set<String>>?
    /// The row under the pointer (the space bar previews it).
    var hovered: Binding<String?>?
    /// Rows shown before the list scrolls.
    var visibleRows = 4
    /// About one row with a one-line reason; the scroll height shows half of the next row as a cue.
    private let rowHeight: CGFloat = 64

    var body: some View {
        if items.count > visibleRows {
            ScrollView(.vertical) {
                rows.padding(.bottom, 4)
            }
            .frame(height: rowHeight * (CGFloat(visibleRows) + 0.5))
            // The cut row fades out to nothing: at 15% it read as a row drawn wrong, not as "more below".
            .mask(alignment: .bottom) {
                VStack(spacing: 0) {
                    Rectangle()
                    LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom)
                        .frame(height: 28)
                }
            }
            .overlay(alignment: .top) { Divider() }
            .overlay(alignment: .bottom) { Divider() }
            .accessibilityElement(children: .contain)
            .accessibilityLabel(Plural.count(items.count, "item"))
            .accessibilityIdentifier("\(identifier)-items")
        } else {
            rows
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("\(identifier)-items")
        }
    }

    /// The rows by group: a header over the aside rows (and over the rows in place when both are there). Grouping is
    /// only what the list shows; the ticks, the hover and Quick Look still go by each row's id.
    private var rows: some View {
        let groups = ApprovalItemGroup.groups(items)
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(groups.enumerated()), id: \.element.id) { groupIndex, group in
                if let title = group.title {
                    Text(verbatim: title)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .padding(.top, groupIndex == 0 ? 4 : 12)
                        .padding(.bottom, 2)
                        .accessibilityAddTraits(.isHeader)
                }
                ForEach(Array(group.items.enumerated()), id: \.element.id) { index, item in
                    if index > 0 { Divider().padding(.leading, selection == nil ? 42 : 66) }
                    row(item)
                }
            }
        }
    }

    private func row(_ item: ApprovalItem) -> some View {
        ApprovalItemRow(item: item, selected: selection.map { binding in
            Binding(get: { binding.wrappedValue.contains(item.id) }, set: { on in
                if on { binding.wrappedValue.insert(item.id) } else { binding.wrappedValue.remove(item.id) }
            })
        }, identifier: identifier)
        .onHover { inside in
            if inside {
                hovered?.wrappedValue = item.id
            } else if hovered?.wrappedValue == item.id {
                hovered?.wrappedValue = nil
            }
        }
    }
}

struct ApprovalItemRow: View {
    let item: ApprovalItem
    /// The checkbox; nil draws none.
    var selected: Binding<Bool>?
    let identifier: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if let selected {
                Toggle("", isOn: selected)
                    .toggleStyle(.checkbox)
                    .labelsHidden()
                    .padding(.top, 8)
                    .help(selected.wrappedValue ? "Ticked: this one goes" : "Unticked: this one stays")
                    .accessibilityLabel(Text("Delete \(item.name)"))
                    .accessibilityIdentifier("\(identifier)-tick-\(item.name)")
            }
            icon
            VStack(alignment: .leading, spacing: 2) {
                // The buttons sit on the name's line only, so the folder and the reason below get the full width.
                HStack(alignment: .center, spacing: 8) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(verbatim: item.name)
                            .font(.system(size: 13, weight: .semibold))
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .strikethrough(item.gone, color: .secondary)
                            .foregroundStyle(item.gone || selected?.wrappedValue == false ? .secondary : .primary)
                            .help(item.path)
                        if let risk = item.risk {
                            ApprovalChipView(chip: risk.chip)
                        }
                        Spacer(minLength: 4)
                        if let size = item.size {
                            Text(verbatim: size)
                                .font(.system(size: 11).monospacedDigit())
                                .foregroundStyle(item.gone ? Color.orange : Color.secondary)
                                .lineLimit(1)
                                .fixedSize()
                        }
                    }
                    .accessibilityElement(children: .combine)
                    actions
                }
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(verbatim: item.folder)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .help(item.aside ? "\(item.path)\nWaits at \(item.location)" : item.path)
                    if let git = item.git, git.state != "none" {
                        ApprovalGitBadge(git: git)
                    }
                    ForEach(item.notes) { note in
                        ApprovalChipView(chip: note)
                    }
                }
                Text(verbatim: item.reasonLine)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 8)
        .padding(.trailing, 2)
        .opacity(selected?.wrappedValue == false ? 0.6 : 1)
        .accessibilityElement(children: .contain)
    }

    private var icon: some View {
        Group {
            if let image = item.icon {
                Image(nsImage: image).resizable().interpolation(.high)
            } else {
                Image(systemName: item.isFolder ? "folder" : "doc")
                    .font(.system(size: 20, weight: .regular))
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: 32, height: 32)
        .opacity(item.gone ? 0.45 : 1)
        .accessibilityHidden(true)
    }

    /// Visible on every row, not only on hover: the person decides by looking, so the way to look is always there.
    private var actions: some View {
        HStack(spacing: 2) {
            if !item.gone {
                ApprovalIconButton(systemName: "eye", label: "Quick Look (Space)") { ApprovalQuickLook.toggle(item.location) }
                ApprovalIconButton(systemName: "folder", label: "Reveal in Finder") { PathOpener.reveal(item.location) }
                ApprovalIconButton(systemName: "chevron.left.forwardslash.chevron.right", label: "Open in Cursor") {
                    PathOpener.cursor(item.location)
                }
                if item.opensInMarkdown {
                    ApprovalIconButton(systemName: "doc.richtext", label: "Open in Genesis Markdown") {
                        PathOpener.genesisMarkdown(item.location)
                    }
                }
            }
        }
        // Room for all four buttons on every row, so the sizes line up in one column.
        .frame(width: 4 * 24 + 3 * 2, alignment: .trailing)
    }
}

/// The small capsule every badge of a row draws: a word in a colour on a faint fill of the same colour. 11 pt, the
/// smallest size text a person must read may have.
struct ApprovalCapsule: View {
    let text: String
    let color: Color

    var body: some View {
        Text(verbatim: text)
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(color)
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(Capsule().fill(color.opacity(0.14)))
    }
}

/// A chip ("same name as its folder", "low risk") with its tooltip; VoiceOver reads the word and why.
struct ApprovalChipView: View {
    let chip: ApprovalChip

    var body: some View {
        ApprovalCapsule(text: chip.word, color: color)
            .help(chip.help)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(verbatim: chip.word))
            .accessibilityHint(Text(verbatim: chip.help))
    }

    private var color: Color {
        switch chip.tone {
        case .quiet: return .secondary
        case .caution: return .yellow
        case .warning: return .orange
        case .danger: return .red
        }
    }
}

/// "untracked", "modified", "ignored" or "clean · a5fed04 2 days ago: …" as a small capsule on the folder line.
struct ApprovalGitBadge: View {
    let git: ApprovalGitState

    var body: some View {
        HStack(spacing: 4) {
            ApprovalCapsule(text: git.state, color: color)
            if let commit = git.lastCommit {
                Text(verbatim: commit)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .help(help)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text("git \(git.state)\(git.lastCommit.map { ", \($0)" } ?? "")"))
    }

    private var color: Color {
        switch git.state {
        case "untracked": return .orange
        case "modified": return .yellow
        case "clean": return .green
        default: return .secondary
        }
    }

    private var help: String {
        switch git.state {
        case "untracked": return "Not in git: may be new work nothing else holds."
        case "modified": return "Tracked, with changes not committed."
        case "ignored": return "Ignored by git: build output or a cache, usually."
        case "clean": return "Tracked and committed: git can bring it back."
        default: return "Not in a git repository."
        }
    }
}

/// Quick Look for a row: the system's preview panel over the approval window, the space bar or the eye button opens
/// and closes it.
@MainActor
enum ApprovalQuickLook {
    private static let source = Source()

    static func toggle(_ path: String) {
        guard let panel = QLPreviewPanel.shared() else { return }
        if panel.isVisible, source.url?.path == path {
            panel.orderOut(nil)
            return
        }

        source.url = URL(fileURLWithPath: path)
        panel.dataSource = source
        panel.reloadData()
        panel.makeKeyAndOrderFront(nil)
    }

    private final class Source: NSObject, QLPreviewPanelDataSource {
        var url: URL?

        func numberOfPreviewItems(in panel: QLPreviewPanel!) -> Int { url == nil ? 0 : 1 }

        func previewPanel(_ panel: QLPreviewPanel!, previewItemAt index: Int) -> QLPreviewItem! {
            url.map { $0 as NSURL }
        }
    }
}

/// An icon-only button for this base library, which has no `IconButton` (that lives in the full GenesisKit, which the
/// app's host does not link): a 24 pt round target with a hover ring, the hand cursor, a tooltip, and the tooltip's
/// text as the VoiceOver label.
struct ApprovalIconButton: View {
    let systemName: String
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 12, weight: .medium))
                .frame(width: 24, height: 24)
                .contentShape(Circle())
        }
        .buttonStyle(ApprovalIconButtonStyle())
        .help(label)
        .accessibilityLabel(Text(label))
    }
}

private struct ApprovalIconButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        ApprovalIconButtonBody(configuration: configuration)
    }
}

private struct ApprovalIconButtonBody: View {
    let configuration: ButtonStyleConfiguration
    @State private var hovering = false
    @GenReduceMotion private var reduceMotion

    var body: some View {
        configuration.label
            .foregroundStyle(hovering ? Color.primary : Color.secondary)
            .background(Circle().fill(Color.primary.opacity(configuration.isPressed ? 0.18 : (hovering ? 0.1 : 0))))
            .overlay(Circle().strokeBorder(Color.primary.opacity(hovering ? 0.18 : 0), lineWidth: 1))
            .pointerCursor()
            .onHover { inside in
                withAnimation(reduceMotion ? nil : KitTheme.quick) { hovering = inside }
            }
            .onDisappear { hovering = false }
    }
}

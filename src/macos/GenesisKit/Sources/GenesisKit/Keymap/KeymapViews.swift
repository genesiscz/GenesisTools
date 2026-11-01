import AppKit
import SwiftUI

/// A key label drawn as caps: "⇧⌘Ú" as ⇧ ⌘ Ú.
public struct KeyCaps: View {
    private let label: String
    private let dimmed: Bool

    public init(_ label: String, dimmed: Bool = false) {
        self.label = label
        self.dimmed = dimmed
    }

    public var body: some View {
        HStack(spacing: 3) {
            ForEach(Array(Self.parts(label).enumerated()), id: \.offset) { _, part in
                Text(part)
                    .font(.system(size: 11, weight: .medium, design: .rounded))
                    .foregroundStyle(dimmed ? .secondary : .primary)
                    .padding(.horizontal, 5).padding(.vertical, 2)
                    .frame(minWidth: 20)
                    .background(Color.white.opacity(dimmed ? 0.04 : 0.08), in: RoundedRectangle(cornerRadius: 5))
                    .overlay(RoundedRectangle(cornerRadius: 5).stroke(Color.white.opacity(0.12), lineWidth: 1))
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
    }

    /// The modifier symbols one by one, then the key's name whole ("F6", "Space").
    static func parts(_ label: String) -> [String] {
        var parts: [String] = []
        var rest = Substring(label)
        while let first = rest.first, "⌃⌥⇧⌘".contains(first), rest.count > 1 {
            parts.append(String(first))
            rest = rest.dropFirst()
        }
        if !rest.isEmpty { parts.append(String(rest)) }
        return parts
    }
}

/// One library in a shortcut list. `commandIDs` nil shows every command; a set shows only those (a window that
/// runs some of another library's keys).
public struct KeymapPage: Identifiable {
    public let keymap: Keymap
    public let commandIDs: Set<String>?

    public var id: String {
        let filter = commandIDs?.sorted().joined(separator: ",") ?? "*"
        return "\(keymap.library.id)[\(filter)]"
    }

    public init(_ keymap: Keymap, commandIDs: Set<String>? = nil) {
        self.keymap = keymap
        self.commandIDs = commandIDs
    }
}

/// The list of every command with its keys, by group, with a search field. `editing` swaps each key for a recorder,
/// a reset button for a changed key and a button that turns the key off. A key two commands share, including across
/// the pages, is marked on both.
public struct KeymapListView: View {
    private let pages: [KeymapPage]
    private let editing: Bool
    @State private var query = ""
    /// Bumps when any page's keys change: the list then reads every row's keys and conflicts again (a conflict line can
    /// belong to another page), and a row redraws only when its own values changed.
    @State private var revision = 0

    public init(keymap: Keymap, editing: Bool) {
        self.init(pages: [KeymapPage(keymap)], editing: editing)
    }

    public init(pages: [KeymapPage], editing: Bool) {
        self.pages = pages
        self.editing = editing
    }

    public var body: some View {
        VStack(spacing: 0) {
            searchField
                .padding(.horizontal, 16).padding(.vertical, 10)
            Divider().opacity(0.4)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                    let listed = listedSections
                    ForEach(listed) { section in
                        Section {
                            ForEach(section.commands) { command in
                                KeymapCommandRow(command: command, page: section.page, others: section.others,
                                                 editing: editing)
                                    .equatable()
                            }
                        } header: {
                            Text(section.title.uppercased())
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 4)
                                .background(.bar)
                        }
                    }
                    if listed.isEmpty {
                        Text("No shortcut matches “\(query)”.")
                            .font(.system(size: 12)).foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity).padding(.top, 40)
                    }
                }
                .padding(.bottom, 12)
            }
            // The lazy rows have estimated heights until they draw, and without an anchor a new window opened
            // part way down the list.
            .defaultScrollAnchor(.top)
            .background {
                ForEach(pages) { page in
                    KeymapPageRefresh(keymap: page.keymap, revision: $revision)
                }
            }
        }
    }

    /// Every visible group, in library order. A second page's group is named with the library.
    private var listedSections: [KeymapListedSection] {
        let _ = revision
        return pages.flatMap { page in
            let others = pages.filter { $0.id != page.id }
            return KeymapCommandRow.sections(page: page, editing: editing, query: query).map { section in
                KeymapListedSection(page: page, others: others, group: section.group, commands: section.commands)
            }
        }
    }

    private var searchField: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField("Search shortcuts", text: $query)
                .textFieldStyle(.plain)
                .accessibilityIdentifier("keymap-search")
            if !query.isEmpty {
                IconButton(systemName: "xmark.circle.fill", tooltip: "Clear the search") { query = "" }
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 5)
        .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 7))
    }

}

/// Redraws the list when one page's keys change, including a conflict line that belongs to another page.
private struct KeymapPageRefresh: View {
    // lint-rules-ignore: one per page (1 or 2 rows, fixed while the window is open), observes on purpose: it only bumps the list's revision
    @ObservedObject var keymap: Keymap
    @Binding var revision: Int

    var body: some View {
        Color.clear.frame(width: 0, height: 0)
            .onReceive(keymap.objectWillChange) { _ in revision += 1 }
    }
}

private struct KeymapListedSection: Identifiable {
    let page: KeymapPage
    let others: [KeymapPage]
    let group: String
    let commands: [KeymapCommand]
    var id: String { "\(page.id)/\(group)" }
    var title: String { others.isEmpty ? group : "\(page.keymap.library.title) · \(group)" }
}

/// One row, from values: the list reads the page's keymap (its `revision` bumps on every key change) and hands the row
/// its key labels and conflicts, so a key change redraws only the rows whose caps, badge or conflict line changed. Its
/// buttons exist while the pointer is on it (`liveRow`); at rest the same glyphs, which VoiceOver still presses.
private struct KeymapCommandRow: View, Equatable {
    private let command: KeymapCommand
    private let editing: Bool
    /// The keys in force, as labels ("⇧⌘Ú").
    private let labels: [String]
    private let customized: Bool
    /// The commands that share one of its keys, on its page and where the scopes meet on the others.
    private let conflictTitles: [String]
    private let restoreTooltip: String
    private let record: (KeyChord) -> Void
    private let clear: () -> Void
    private let reset: () -> Void

    init(command: KeymapCommand, page: KeymapPage, others: [KeymapPage], editing: Bool) {
        let keymap = page.keymap
        let chords = keymap.chords(for: command.id)
        let defaults = command.defaults.map(keymap.label).joined(separator: " or ")
        self.command = command
        self.editing = editing
        labels = chords.map(keymap.label)
        customized = keymap.isCustomized(command.id)
        conflictTitles = Self.conflicts(command, chords: chords, keymap: keymap, others: others).map(\.title)
        restoreTooltip = defaults.isEmpty ? "Restore: no key" : "Restore \(defaults)"
        record = { chord in keymap.setChords([chord], for: command.id) }
        clear = { keymap.setChords([], for: command.id) }
        reset = { keymap.reset(command.id) }
    }

    static func == (a: KeymapCommandRow, b: KeymapCommandRow) -> Bool {
        a.command == b.command && a.editing == b.editing && a.labels == b.labels && a.customized == b.customized
            && a.conflictTitles == b.conflictTitles && a.restoreTooltip == b.restoreTooltip
    }

    var body: some View {
        row
    }

    static func sections(page: KeymapPage, editing: Bool, query: String) -> [(group: String, commands: [KeymapCommand])] {
        let shown = page.keymap.library.commands.filter { command in
            (page.commandIDs?.contains(command.id) ?? true) && (!editing || command.configurable)
                && matches(command, in: page.keymap, query: query)
        }
        return page.keymap.library.groups.compactMap { group in
            let commands = shown.filter { $0.group == group }
            return commands.isEmpty ? nil : (group, commands)
        }
    }

    /// Title, group, detail and the key itself, ignoring case and accents: "zalozka", "⌘W" and "w" all find a row.
    private static func matches(_ command: KeymapCommand, in keymap: Keymap, query: String) -> Bool {
        let needle = query.trimmingCharacters(in: .whitespaces)
        guard !needle.isEmpty else { return true }
        let labels = keymap.chords(for: command.id).map(keymap.label)
        let haystack = ([command.title, command.group, command.detail ?? ""] + labels).joined(separator: " ")
        return haystack.range(of: needle, options: [.caseInsensitive, .diacriticInsensitive]) != nil
            || labels.contains { $0.localizedCaseInsensitiveContains(needle) }
    }

    private var row: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(command.title).font(.system(size: 12.5, weight: .medium))
                    if customized {
                        Text("Changed").font(.system(size: 9.5, weight: .semibold)).foregroundStyle(Color.accentColor)
                            .padding(.horizontal, 4).padding(.vertical, 1)
                            .background(Color.accentColor.opacity(0.14), in: Capsule())
                    }
                }
                if let detail = command.detail {
                    Text(detail).font(.system(size: 11)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if !conflictTitles.isEmpty {
                    Label("Also \(conflictTitles.joined(separator: ", "))", systemImage: "exclamationmark.triangle.fill")
                        .font(.system(size: 11)).foregroundStyle(.orange)
                        .accessibilityIdentifier("keymap-conflict-\(command.id)")
                }
            }
            Spacer(minLength: 8)
            if editing {
                editor
            } else {
                keys
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("keymap-row-\(command.id)")
        .padding(.horizontal, 16).padding(.vertical, 7)
        .liveRow()
    }

    @ViewBuilder
    private var keys: some View {
        if labels.isEmpty {
            Text("None").font(.system(size: 11)).foregroundStyle(.secondary)
        } else {
            HStack(spacing: 6) {
                ForEach(Array(labels.enumerated()), id: \.offset) { index, label in
                    if index > 0 { Text("or").font(.system(size: 10)).foregroundStyle(.secondary) }
                    KeyCaps(label, dimmed: !command.configurable)
                }
            }
        }
    }

    private var editor: some View {
        HStack(alignment: .top, spacing: 4) {
            KeyChordRecorder(
                label: labels.isEmpty ? nil : labels.joined(separator: " or "),
                identifier: "keymap-recorder-\(command.id)",
                onRecord: record
            )
            if !labels.isEmpty {
                IconButton(systemName: "xmark", tooltip: "No key for \(command.title)", action: clear)
            }
            if customized {
                IconButton(systemName: "arrow.counterclockwise", tooltip: restoreTooltip, action: reset)
            }
        }
    }

    /// This page's other commands, then the same key on the other pages where the scopes meet.
    private static func conflicts(_ command: KeymapCommand, chords: [KeyChord], keymap: Keymap,
                                  others: [KeymapPage]) -> [KeymapCommand] {
        chords.flatMap { chord in
            keymap.commands(using: chord, besides: command.id) + others.flatMap { other in
                other.keymap.commands(meeting: command.scope, using: chord, ids: other.commandIDs)
            }
        }
    }
}

/// The help window's content: the list, and a switch between reading it and changing the keys.
public struct KeymapHelpView: View {
    private let pages: [KeymapPage]
    @State private var editing: Bool

    public init(keymap: Keymap, editing: Bool = false) {
        self.init(pages: [KeymapPage(keymap)], editing: editing)
    }

    public init(pages: [KeymapPage], editing: Bool = false) {
        self.pages = pages
        _editing = State(initialValue: editing)
    }

    public var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Keyboard Shortcuts").font(.system(size: 15, weight: .semibold))
                    Text(pages.map { $0.keymap.library.title }.joined(separator: ", "))
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                }
                Spacer()
                if editing, pages.contains(where: { !$0.keymap.configuration.overrides.isEmpty }) {
                    Button("Restore All") { pages.forEach { $0.keymap.resetAll() } }
                        .accessibilityIdentifier("keymap-restore-all")
                }
                Button(editing ? "Done" : "Change Keys…") { editing.toggle() }
                    .keyboardShortcut(editing ? .defaultAction : nil)
                    .accessibilityIdentifier("keymap-edit")
            }
            .padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 4)
            KeymapListView(pages: pages, editing: editing)
        }
        .frame(minWidth: 460, minHeight: 400)
    }
}

/// One help window per set of pages. `show` brings it forward, or opens it.
@MainActor
public enum KeymapHelpWindow {
    private static var windows: [String: NSWindow] = [:]

    public static func show(_ keymap: Keymap, editing: Bool = false) {
        show([KeymapPage(keymap)], editing: editing)
    }

    public static func show(_ pages: [KeymapPage], editing: Bool = false) {
        let id = pages.map(\.id).joined(separator: "|")
        if let window = windows[id] {
            window.makeKeyAndOrderFront(nil)
            return
        }
        let window = KeymapHelpPanel(
            contentRect: NSRect(x: 0, y: 0, width: 560, height: 680),
            styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Keyboard Shortcuts"
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .darkAqua)
        window.contentView = NSHostingView(rootView: KeymapHelpView(pages: pages, editing: editing))
        if !window.setFrameUsingName("KeymapHelp.\(id)") { window.center() }
        window.setFrameAutosaveName("KeymapHelp.\(id)")
        windows[id] = window
        window.makeKeyAndOrderFront(nil)
    }
}

/// The help window closes on ⌘W like any document window: the app's own ⌘W (a tab, in the markdown viewer) belongs
/// to its main window, and the dispatcher hands this one the key untouched.
final class KeymapHelpPanel: NSWindow {
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if let stroke = KeyStroke(event), KeyChord.character("w", .command).matches(stroke) {
            performClose(nil)
            return true
        }
        return super.performKeyEquivalent(with: event)
    }
}

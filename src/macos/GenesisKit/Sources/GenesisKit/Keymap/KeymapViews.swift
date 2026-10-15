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

/// The list of every command with its keys, by group, with a search field. `editing` swaps each key for a recorder,
/// a reset button for a changed key and a button that turns the key off. A key two commands share is marked on both.
public struct KeymapListView: View {
    @ObservedObject private var keymap: Keymap
    private let editing: Bool
    @State private var query = ""

    public init(keymap: Keymap, editing: Bool) {
        self.keymap = keymap
        self.editing = editing
    }

    public var body: some View {
        VStack(spacing: 0) {
            searchField
                .padding(.horizontal, 16).padding(.vertical, 10)
            Divider().opacity(0.4)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                    ForEach(sections, id: \.group) { section in
                        Section {
                            ForEach(section.commands) { command in
                                row(command)
                                    .padding(.horizontal, 16).padding(.vertical, 7)
                            }
                        } header: {
                            Text(section.group.uppercased())
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 4)
                                .background(.bar)
                        }
                    }
                    if sections.isEmpty {
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

    private var sections: [(group: String, commands: [KeymapCommand])] {
        let shown = keymap.library.commands.filter { command in
            (!editing || command.configurable) && matches(command)
        }
        return keymap.library.groups.compactMap { group in
            let commands = shown.filter { $0.group == group }
            return commands.isEmpty ? nil : (group, commands)
        }
    }

    /// Title, group, detail and the key itself, ignoring case and accents: "zalozka", "⌘W" and "w" all find a row.
    private func matches(_ command: KeymapCommand) -> Bool {
        let needle = query.trimmingCharacters(in: .whitespaces)
        guard !needle.isEmpty else { return true }
        let labels = keymap.chords(for: command.id).map(keymap.label)
        let haystack = ([command.title, command.group, command.detail ?? ""] + labels).joined(separator: " ")
        return haystack.range(of: needle, options: [.caseInsensitive, .diacriticInsensitive]) != nil
            || labels.contains { $0.localizedCaseInsensitiveContains(needle) }
    }

    @ViewBuilder
    private func row(_ command: KeymapCommand) -> some View {
        let chords = keymap.chords(for: command.id)
        let shared = chords.flatMap { keymap.commands(using: $0, besides: command.id) }
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(command.title).font(.system(size: 12.5, weight: .medium))
                    if keymap.isCustomized(command.id) {
                        Text("Changed").font(.system(size: 9.5, weight: .semibold)).foregroundStyle(Color.accentColor)
                            .padding(.horizontal, 4).padding(.vertical, 1)
                            .background(Color.accentColor.opacity(0.14), in: Capsule())
                    }
                }
                if let detail = command.detail {
                    Text(detail).font(.system(size: 11)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if !shared.isEmpty {
                    Label("Also \(shared.map(\.title).joined(separator: ", "))", systemImage: "exclamationmark.triangle.fill")
                        .font(.system(size: 11)).foregroundStyle(.orange)
                        .accessibilityIdentifier("keymap-conflict-\(command.id)")
                }
            }
            Spacer(minLength: 8)
            if editing {
                editor(command, chords: chords)
            } else {
                keys(command, chords: chords)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("keymap-row-\(command.id)")
    }

    @ViewBuilder
    private func keys(_ command: KeymapCommand, chords: [KeyChord]) -> some View {
        if chords.isEmpty {
            Text("None").font(.system(size: 11)).foregroundStyle(.secondary)
        } else {
            HStack(spacing: 6) {
                ForEach(Array(chords.enumerated()), id: \.offset) { index, chord in
                    if index > 0 { Text("or").font(.system(size: 10)).foregroundStyle(.secondary) }
                    KeyCaps(keymap.label(chord), dimmed: !command.configurable)
                }
            }
        }
    }

    private func editor(_ command: KeymapCommand, chords: [KeyChord]) -> some View {
        HStack(alignment: .top, spacing: 4) {
            KeyChordRecorder(
                label: chords.isEmpty ? nil : chords.map(keymap.label).joined(separator: " or "),
                identifier: "keymap-recorder-\(command.id)"
            ) { chord in
                keymap.setChords([chord], for: command.id)
            }
            if !chords.isEmpty {
                IconButton(systemName: "xmark", tooltip: "No key for \(command.title)") {
                    keymap.setChords([], for: command.id)
                }
            }
            if keymap.isCustomized(command.id) {
                IconButton(systemName: "arrow.counterclockwise", tooltip: restoreTooltip(command)) {
                    keymap.reset(command.id)
                }
            }
        }
    }

    private func restoreTooltip(_ command: KeymapCommand) -> String {
        let defaults = command.defaults.map(keymap.label).joined(separator: " or ")
        return defaults.isEmpty ? "Restore: no key" : "Restore \(defaults)"
    }
}

/// The help window's content: the list, and a switch between reading it and changing the keys.
public struct KeymapHelpView: View {
    @ObservedObject private var keymap: Keymap
    @State private var editing: Bool

    public init(keymap: Keymap, editing: Bool = false) {
        self.keymap = keymap
        _editing = State(initialValue: editing)
    }

    public var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Keyboard Shortcuts").font(.system(size: 15, weight: .semibold))
                    Text(keymap.library.title).font(.system(size: 11)).foregroundStyle(.secondary)
                }
                Spacer()
                if editing, !keymap.configuration.overrides.isEmpty {
                    Button("Restore All") { keymap.resetAll() }
                        .accessibilityIdentifier("keymap-restore-all")
                }
                Button(editing ? "Done" : "Change Keys…") { editing.toggle() }
                    .keyboardShortcut(editing ? .defaultAction : nil)
                    .accessibilityIdentifier("keymap-edit")
            }
            .padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 4)
            KeymapListView(keymap: keymap, editing: editing)
        }
        .frame(minWidth: 460, minHeight: 400)
    }
}

/// One help window per keymap library. `show` brings it forward, or opens it.
@MainActor
public enum KeymapHelpWindow {
    private static var windows: [String: NSWindow] = [:]

    public static func show(_ keymap: Keymap, editing: Bool = false) {
        let id = keymap.library.id
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
        window.contentView = NSHostingView(rootView: KeymapHelpView(keymap: keymap, editing: editing))
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

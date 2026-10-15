//
//  MarkdownPathBar.swift
//  GenesisKit
//
//  The open file's path in the window's title bar, where the title text was: `~ › notes › plan.md`.
//  Every step is a control that drops the path verbs of that folder, or of the file for the last one
//  (`PathMenu` with the configuration's `folderActions` / `fileActions`): Show in Sidebar, Navigate in
//  Sidebar, Search in Folder…, Finder, Cursor on the whole folder, and so on. A path too long for the
//  strip folds its first folders into one "…" control that lists them, so the row never reaches the
//  traffic lights and the strip keeps an empty end to drag and double-click.
//
//  Title bar rules (Window/WindowTitlebar.swift, .claude/docs/swift-headers.md): the row is a
//  `.titlebarRow()`, every step is a button that hugs its width, and the chevrons between them are
//  `.titlebarLabel()`, so the empty strip around them still drags the window and zooms on a double-click.
//

import SwiftUI

/// One step of the breadcrumb: the home folder (`~`) or `/`, a folder, or the file.
struct MarkdownPathSegment: Equatable, Identifiable {
    let url: URL
    let title: String
    let isFile: Bool

    var id: String { url.path }
}

/// What the row draws: a step, or the folders folded into one "…".
enum MarkdownPathItem: Equatable, Identifiable {
    case segment(MarkdownPathSegment)
    case collapsed([MarkdownPathSegment])

    var id: String {
        switch self {
        case .segment(let segment): return segment.id
        case .collapsed(let hidden): return "…" + (hidden.first?.id ?? "")
        }
    }

    /// The row as text, "…" for the folded folders: what a test compares.
    static func outline(_ items: [MarkdownPathItem]) -> [String] {
        items.map { item in
            switch item {
            case .segment(let segment): return segment.title
            case .collapsed: return "…"
            }
        }
    }
}

enum MarkdownPathBarLayout {
    /// The steps for `file`: `~` when it is under the home folder, else `/`, then every folder, then the file.
    static func segments(for file: URL, home: String = FileManager.default.homeDirectoryForCurrentUser.path) -> [MarkdownPathSegment] {
        let path = file.standardizedFileURL.path
        let home = URL(fileURLWithPath: home, isDirectory: true).standardizedFileURL.path
        var segments: [MarkdownPathSegment] = []
        var current: String
        let rest: [Substring]
        if path.hasPrefix(home + "/") {
            segments.append(MarkdownPathSegment(url: URL(fileURLWithPath: home, isDirectory: true), title: "~", isFile: false))
            current = home
            rest = path.dropFirst(home.count + 1).split(separator: "/")
        } else {
            segments.append(MarkdownPathSegment(url: URL(fileURLWithPath: "/", isDirectory: true), title: "/", isFile: false))
            current = ""
            rest = path.split(separator: "/")
        }
        for (index, part) in rest.enumerated() {
            current += "/" + part
            let isFile = index == rest.count - 1
            segments.append(MarkdownPathSegment(url: URL(fileURLWithPath: current, isDirectory: !isFile), title: String(part), isFile: isFile))
        }
        return segments
    }

    /// The row with `count` folders folded into "…", starting with the one after `~` (or `/`): the
    /// folders nearest the file stay readable longest. The first step and the file never fold here.
    static func items(_ segments: [MarkdownPathSegment], hiding count: Int) -> [MarkdownPathItem] {
        guard segments.count > 2, count > 0 else {
            return segments.map(MarkdownPathItem.segment)
        }
        let hidden = min(count, segments.count - 2)
        return [.segment(segments[0]), .collapsed(Array(segments[1...hidden]))]
            + segments[(hidden + 1)...].map(MarkdownPathItem.segment)
    }

    /// Every row to try, widest first: nothing folded, then one more folder folded each step (the file's
    /// own folder last), then every folder behind one "…" before the file.
    static func candidates(_ segments: [MarkdownPathSegment]) -> [[MarkdownPathItem]] {
        var out = [items(segments, hiding: 0)]
        if segments.count > 2 {
            for count in 1...(segments.count - 2) {
                out.append(items(segments, hiding: count))
            }
        }
        if segments.count > 1, let file = segments.last {
            out.append([.collapsed(Array(segments.dropLast())), .segment(file)])
        }
        return out
    }
}

struct MarkdownPathBar: View {
    @ObservedObject var model: MarkdownDocumentsModel

    /// The strip's right end that always stays empty: room to drag the window and double-click it.
    static let trailingRoom: CGFloat = 96

    var body: some View {
        let _ = RenderProbe.hit("md.pathBar")
        if let doc = model.selected {
            // The model publishes on every scroll (the active heading); the row draws again only when
            // the file or the theme changes.
            MarkdownPathBarRow(url: doc.url, theme: model.theme, model: model)
                .equatable()
        }
    }
}

/// The breadcrumb for one file. Equal while its file and theme are.
private struct MarkdownPathBarRow: View, Equatable {
    let url: URL
    let theme: MarkdownTheme
    /// For the menus' verbs; never compared.
    let model: MarkdownDocumentsModel

    static func == (left: MarkdownPathBarRow, right: MarkdownPathBarRow) -> Bool {
        left.url == right.url && left.theme == right.theme
    }

    var body: some View {
        let candidates = MarkdownPathBarLayout.candidates(MarkdownPathBarLayout.segments(for: url))
        // The first row that fits the strip at its own width; the last one squeezes the file name.
        ViewThatFits(in: .horizontal) {
            ForEach(Array(candidates.enumerated()), id: \.offset) { index, items in
                row(items, squeezes: index == candidates.count - 1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.trailing, MarkdownPathBar.trailingRoom)
        .axMarker("markdown-path-bar")
    }

    private func row(_ items: [MarkdownPathItem], squeezes: Bool) -> some View {
        HStack(spacing: 1) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                if index > 0 {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 8, weight: .semibold))
                        .foregroundColor(theme.textMuted)
                        .titlebarLabel()
                        .accessibilityHidden(true)
                }
                switch item {
                case .segment(let segment):
                    segmentButton(segment)
                case .collapsed(let hidden):
                    collapsedButton(hidden)
                }
            }
        }
        .fixedSize(horizontal: !squeezes, vertical: false)
    }

    private func segmentButton(_ segment: MarkdownPathSegment) -> some View {
        let kind: PathKind = segment.isFile ? .file : .folder
        let display = PathLabel.display(segment.url.path)
        return PathMenuButton(entries: { model.pathMenu(for: segment.url, kind: kind) }) {
            HStack(spacing: 4) {
                if segment.isFile {
                    Image(systemName: FileTreeView.defaultIcon(FileTreeRow(id: segment.url.path, name: segment.title, isFolder: false, depth: 0)))
                        .font(.system(size: 11))
                        .foregroundColor(theme.accent)
                }
                Text(segment.title)
                    .font(.system(size: 12, weight: segment.isFile ? .semibold : .regular))
                    .foregroundColor(segment.isFile ? theme.text : theme.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .padding(.horizontal, 5)
            .padding(.vertical, 3)
            .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverPlain())
        .hoverHighlight(color: theme.accent, cornerRadius: 5, fillOpacity: 0.12, borderOpacity: 0.35)
        .instantTooltip("\(display)\nClick for the \(segment.isFile ? "file's" : "folder's") actions")
        .accessibilityLabel(segment.isFile ? "File \(segment.title)" : "Folder \(segment.title)")
        .accessibilityHint("Shows the actions for \(display)")
        .accessibilityIdentifier(segment.isFile ? "markdown-path-file" : "markdown-path-folder")
    }

    /// The folded folders: a menu of them, each with its own folder actions.
    private func collapsedButton(_ hidden: [MarkdownPathSegment]) -> some View {
        PathMenuButton(entries: {
            hidden.map { segment in
                PathMenuEntry.submenu(
                    id: segment.id, title: segment.title, systemImage: "folder",
                    entries: model.pathMenu(for: segment.url, kind: .folder)
                )
            }
        }) {
            Text("…")
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(theme.textSecondary)
                .padding(.horizontal, 5)
                .padding(.vertical, 3)
                .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverPlain())
        .hoverHighlight(color: theme.accent, cornerRadius: 5, fillOpacity: 0.12, borderOpacity: 0.35)
        .instantTooltip(hidden.map(\.title).joined(separator: " / "))
        .accessibilityLabel("\(hidden.count) more \(hidden.count == 1 ? "folder" : "folders")")
        .accessibilityIdentifier("markdown-path-collapsed")
    }
}

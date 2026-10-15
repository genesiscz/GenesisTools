//
//  GitPickerChrome.swift
//  GenesisKit
//
//  The parts the git choosers share: the compact chip a closed chooser shows (the markdown viewer's scope and commit
//  pickers, the GenesisTools review window's scope menu), the row background of an open one, and line counts in green
//  and red that read in a light window as well as a dark one.
//

import SwiftUI

/// A closed chooser: an optional icon, the current choice, a dimmer detail, and a chevron. It takes only the room it
/// needs; in a crowded row the detail truncates first, then the title.
public struct GitPickerChip: View {
    let systemImage: String?
    let title: String
    let detail: String?
    let monospacedTitle: Bool

    public init(systemImage: String? = nil, title: String, detail: String? = nil, monospacedTitle: Bool = false) {
        self.systemImage = systemImage
        self.title = title
        self.detail = detail
        self.monospacedTitle = monospacedTitle
    }

    public var body: some View {
        HStack(spacing: 5) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
            Text(verbatim: title)
                .font(.system(size: 12, weight: .medium, design: monospacedTitle ? .monospaced : .default))
                .lineLimit(1)
                .truncationMode(.middle)
                .layoutPriority(1)
            if let detail, !detail.isEmpty {
                Text(verbatim: detail)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            Image(systemName: "chevron.down")
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Color.primary.opacity(0.06)))
        .contentShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
}

/// `+12 −3` in the diff colours: the kit's bright pair on a dark background, a darker pair on a light one, where the
/// bright green measured too faint for 11 pt text.
public struct GitLineCounts: View {
    let additions: Int
    let deletions: Int
    var size: CGFloat
    @Environment(\.colorScheme) private var scheme

    public init(additions: Int, deletions: Int, size: CGFloat = 11) {
        self.additions = additions
        self.deletions = deletions
        self.size = size
    }

    public var body: some View {
        HStack(spacing: 4) {
            // A zero is not a change: it stays grey, so a pure addition does not show a red count.
            Text(verbatim: "+\(additions)")
                .foregroundStyle(additions == 0 ? AnyShapeStyle(.secondary) : AnyShapeStyle(scheme == .dark ? KitPalette.added : Color(red: 0.10, green: 0.50, blue: 0.22)))
            Text(verbatim: "−\(deletions)")
                .foregroundStyle(deletions == 0 ? AnyShapeStyle(.secondary) : AnyShapeStyle(scheme == .dark ? KitPalette.removed : Color(red: 0.76, green: 0.16, blue: 0.18)))
        }
        .font(.system(size: size, weight: .medium, design: .monospaced))
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: "\(Plural.count(additions, "line")) added, \(Plural.count(deletions, "line")) removed"))
    }
}

/// The row of an open chooser that the keyboard or the pointer is on (a soft accent fill), and the current choice
/// (a check, drawn by the row).
struct GitChooserRowBackground: View {
    let highlighted: Bool

    var body: some View {
        RoundedRectangle(cornerRadius: 6, style: .continuous)
            .fill(Color.accentColor.opacity(highlighted ? 0.18 : 0))
    }
}

/// A row button that draws nothing of its own: the list draws the highlight, so the hover box is the highlight box.
struct GitChooserRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.7 : 1)
            .pointerCursor()
    }
}


public extension GitFileScope {
    /// The scope's glyph, shared with the review window's scopes (`DiffScope.symbol`).
    var symbol: String {
        switch self {
        case .unstaged: return "pencil"
        case .staged: return "tray.and.arrow.down"
        case .uncommitted: return "square.and.pencil"
        case .lastCommit: return "clock.arrow.circlepath"
        case .branch: return "arrow.triangle.branch"
        }
    }

    /// What the two sides are, in a line.
    func summary(base: String? = nil, shown: GitCommit? = nil) -> String {
        switch self {
        case .unstaged: return "Working copy vs staged"
        case .staged: return "Staged vs last commit"
        case .uncommitted: return "Working copy vs last commit"
        case .lastCommit: return shown.map { "\($0.short) · \($0.subject)" } ?? "One commit's change to this file"
        case .branch: return "Working copy vs \(base ?? "the base branch")"
        }
    }
}

public extension DiffScope {
    /// The same glyphs as the file scopes, for the review window's scope menu.
    var symbol: String {
        switch self {
        case .lastTurns: return "text.bubble"
        case .uncommitted: return GitFileScope.uncommitted.symbol
        case .unstaged: return GitFileScope.unstaged.symbol
        case .staged: return GitFileScope.staged.symbol
        case .commit: return GitFileScope.lastCommit.symbol
        case .branch: return GitFileScope.branch.symbol
        case .range: return "arrow.triangle.pull"
        case .compare: return "arrow.left.arrow.right"
        }
    }
}

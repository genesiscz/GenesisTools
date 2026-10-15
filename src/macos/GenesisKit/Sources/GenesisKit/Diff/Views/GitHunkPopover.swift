//
//  GitHunkPopover.swift
//  GenesisKit
//
//  What a click on a gutter bar shows: which lines changed, the text HEAD had there, and "Revert this hunk".
//

import AppKit
import SwiftUI

public struct GitHunkCard: View {
    let hunk: GitHunk
    /// The agent session that wrote these lines, when attribution is on and one did.
    var source: AgentBlameSource?
    let revert: () -> Void

    public init(hunk: GitHunk, source: AgentBlameSource? = nil, revert: @escaping () -> Void) {
        self.hunk = hunk
        self.source = source
        self.revert = revert
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(verbatim: hunk.title)
                .font(.system(size: 12, weight: .semibold))
            if hunk.oldLines.isEmpty {
                Text("HEAD had nothing here.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            } else {
                Text("HEAD had:")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                ScrollView {
                    Text(verbatim: hunk.oldLines.joined(separator: "\n"))
                        .font(.system(size: 11, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 220)
                .fixedSize(horizontal: false, vertical: true)
                .padding(6)
                .background(RoundedRectangle(cornerRadius: 6).fill(GitChangeKind.deleted.color.opacity(0.1)))
            }
            if let source {
                HStack(spacing: 6) {
                    Image(systemName: "sparkles")
                    Text(verbatim: "Written by \(source.title)")
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Button("Open session") { AgentBlame.open(source) }
                        .buttonStyle(.genHoverPlain())
                        .accessibilityIdentifier("git-hunk-session")
                }
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .instantTooltip(source.prompt.map { "The turn began: \($0.prefix(160))" } ?? "")
            }
            HStack {
                Spacer()
                Button("Revert this hunk", action: revert)
                    .accessibilityIdentifier("git-hunk-revert")
            }
        }
        .padding(12)
        .frame(width: 380)
    }
}

@MainActor
public enum GitHunkPopover {
    private static weak var current: NSPopover?

    /// Shows the card beside `rect` of `view`; `revert` runs after it closes.
    public static func show(_ hunk: GitHunk, source: AgentBlameSource? = nil, at rect: NSRect, in view: NSView, revert: @escaping () -> Void) {
        current?.close()
        let popover = NSPopover()
        popover.behavior = .transient
        popover.contentViewController = NSHostingController(rootView: GitHunkCard(hunk: hunk, source: source) { [weak popover] in
            popover?.close()
            revert()
        })
        popover.show(relativeTo: rect, of: view, preferredEdge: .maxX)
        current = popover
    }
}

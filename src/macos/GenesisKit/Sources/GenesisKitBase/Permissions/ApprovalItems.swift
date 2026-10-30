import AppKit
import SwiftUI

/// One path a destructive request names, as the approval window lists it: the Finder icon, the name, where it sits,
/// its size and why no rule allowed it, with buttons that open it where a person can look before deciding.
public struct ApprovalItem: Identifiable {
    /// The path the request names (where the item was).
    public let path: String
    /// Where the item is now: the aside copy while it waits, else `path`.
    public let location: String
    public let name: String
    /// The parent folder with the home folder as `~`.
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

    public var id: String { path }

    public init(path: String, location: String? = nil, name: String, folder: String, size: String?, reason: String,
                gone: Bool, aside: Bool = false, isFolder: Bool, opensInMarkdown: Bool = false, icon: NSImage? = nil) {
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
    }
}

/// The items of a request: plain rows split by hairlines (no card around them, Golden Gate), a scroll view with a
/// fade at the cut edge once there are more than `visibleRows`.
struct ApprovalItemList: View {
    let items: [ApprovalItem]
    let identifier: String
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

    private var rows: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                if index > 0 { Divider().padding(.leading, 42) }
                ApprovalItemRow(item: item)
            }
        }
    }
}

struct ApprovalItemRow: View {
    let item: ApprovalItem

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
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
                            .foregroundStyle(item.gone ? .secondary : .primary)
                            .help(item.path)
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
                Text(verbatim: item.folder)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(item.aside ? "\(item.path)\nWaits at \(item.location)" : item.path)
                Text(verbatim: item.aside ? "\(item.reason). Moved aside, it waits for you." : item.reason)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 8)
        .padding(.trailing, 2)
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
        // Room for all three buttons on every row, so the sizes line up in one column.
        .frame(width: 3 * 24 + 2 * 2, alignment: .trailing)
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

import AppKit
import SwiftUI

/// One thing a request asks about, ticked on its own (an answer an agent relayed): what it is, the words it rests on,
/// one more line, and a button to check it (Play clip). `ApprovalItem` is for paths and carries file buttons; this row
/// carries only its own button.
public struct ApprovalCheck: Identifiable {
    public let id: String
    public let title: String
    /// The words the row rests on, shown in quotes.
    public let quote: String?
    public let detail: String?
    /// The row's own button (Play clip, then Stop while it plays); a click never answers the request.
    public let link: ApprovalLink?

    public init(id: String, title: String, quote: String? = nil, detail: String? = nil, link: ApprovalLink? = nil) {
        self.id = id
        self.title = title
        self.quote = quote
        self.detail = detail
        self.link = link
    }
}

/// The rows of a request that covers several things: plain rows split by hairlines, each with its tick and its own
/// button, a scroll view with a fade at the cut edge once there are more than `visibleRows`.
struct ApprovalCheckList: View {
    let checks: [ApprovalCheck]
    let identifier: String
    @Binding var selection: Set<String>
    var visibleRows = 4
    /// About one row with a one-line quote; the scroll height shows half of the next row as a cue.
    private let rowHeight: CGFloat = 60

    var body: some View {
        if checks.count > visibleRows {
            ScrollView(.vertical) {
                rows.padding(.bottom, 4)
            }
            .frame(height: rowHeight * (CGFloat(visibleRows) + 0.5))
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
            .accessibilityIdentifier("\(identifier)-checks")
        } else {
            rows
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("\(identifier)-checks")
        }
    }

    private var rows: some View {
        LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(Array(checks.enumerated()), id: \.element.id) { index, check in
                if index > 0 { Divider().padding(.leading, 24) }
                ApprovalCheckRow(check: check, identifier: identifier, selected: Binding(
                    get: { selection.contains(check.id) },
                    set: { on in
                        if on { selection.insert(check.id) } else { selection.remove(check.id) }
                    }))
                    .liveRow()
            }
        }
    }
}

struct ApprovalCheckRow: View {
    let check: ApprovalCheck
    let identifier: String
    @Binding var selected: Bool
    /// The link exists as a button only while the row is under the pointer; at rest it is the same label, which
    /// VoiceOver and a click still press (`restingButton`), so 40 rows carry no 40 resting responders.
    @Environment(\.rowLive) private var live

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Toggle("", isOn: $selected)
                .toggleStyle(.checkbox)
                .labelsHidden()
                .padding(.top, 1)
                .help(selected ? "Ticked: Confirm covers this one" : "Unticked: this one stays as it is")
                .accessibilityLabel(Text(verbatim: "Include \(check.title)"))
                .accessibilityIdentifier("\(identifier)-check-\(check.id)")
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(verbatim: check.title)
                        .font(.system(size: 12, weight: .semibold))
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .foregroundStyle(selected ? .primary : .secondary)
                    Spacer(minLength: 4)
                    if let link = check.link {
                        let label = Label(link.title, systemImage: link.symbol)
                            .font(.system(size: 11))
                            .foregroundStyle(link.enabled ? Color.accentColor : Color.secondary)
                        Group {
                            if live {
                                Button(action: link.action) { label }
                                    .buttonStyle(.plain)
                                    .pointerCursor()
                                    .disabled(!link.enabled)
                                    .help(link.help ?? "\(link.title): \(check.title)")
                            } else {
                                label.restingButton(enabled: link.enabled, action: link.action)
                            }
                        }
                        .fixedSize()
                        .accessibilityIdentifier("\(identifier)-check-\(check.id)-link")
                    }
                }
                if let quote = check.quote, !quote.isEmpty {
                    Text(verbatim: "\u{201C}\(quote)\u{201D}")
                        .font(.system(size: 12))
                        .italic()
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
                if let detail = check.detail {
                    Text(verbatim: detail)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 7)
        .opacity(selected ? 1 : 0.6)
        .accessibilityElement(children: .contain)
    }
}

import SwiftUI

// MARK: - The context stack's breadcrumb in the dock (R38, G-STACK-2)

/// "Design review › Q12 › ▶ 1:49:48": the meeting, then each Moment on the context stack from the bottom, the top
/// last and marked as playing. A click on a level below the top pops the stack to it (`onPop(index)`, the index into
/// `moments`); a click on the meeting reports `onMeeting` (the wiring picks: the Meeting view, or stop). Only one sound
/// plays at a time; the levels below wait (R38).
struct StackBreadcrumb: View {
    struct Level: Identifiable, Equatable {
        let id: String
        let title: String

        init(id: String, title: String) {
            self.id = id
            self.title = title
        }

        /// A MomentPlayer layer: its label.
        init(layer: MomentLayer) {
            self.init(id: layer.id.uuidString, title: layer.label)
        }
    }

    let meeting: String
    /// The stack from the bottom; the last one plays or waits.
    let moments: [Level]
    var isPlaying: Bool = true
    var onMeeting: () -> Void = {}
    var onPop: (Int) -> Void = { _ in }

    var body: some View {
        HStack(spacing: 4) {
            level(meeting, top: false, held: !moments.isEmpty, tooltip: "Show the whole meeting", action: onMeeting)
                .accessibilityIdentifier("meetings.dock.crumb.meeting")
            ForEach(Array(moments.enumerated()), id: \.element.id) { index, moment in
                Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
                let top = index == moments.count - 1
                level(top ? "\(isPlaying ? "▶" : "❚❚") \(moment.title)" : moment.title, top: top, held: !top,
                      tooltip: top ? "Plays now" : "Back to \(moment.title), where it stopped") { if !top { onPop(index) } }
                    // Not disabled: a disabled button dims the one level that must read strongest.
                    .accessibilityAddTraits(top ? .isSelected : [])
                    .accessibilityIdentifier("meetings.dock.crumb")
            }
        }
        .padding(.horizontal, 4).padding(.vertical, 3)
        .background(RoundedRectangle(cornerRadius: 7).fill(Color.primary.opacity(0.05)))
        .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(Color.primary.opacity(0.1)))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Context stack")
    }

    private func level(_ title: String, top: Bool, held: Bool, tooltip: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(verbatim: title)
                .font(.system(size: 12, weight: top ? .semibold : .regular))
                .lineLimit(1).truncationMode(.middle)
                .foregroundStyle(top ? Color.white : Color.primary.opacity(held ? 0.75 : 0.55))
                .padding(.horizontal, 6).padding(.vertical, 1)
                .background(RoundedRectangle(cornerRadius: 5).fill(top ? Color.accentColor : Color.clear))
                .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverPlain())
        .instantTooltip(tooltip)
        .accessibilityLabel(top ? "\(title), playing" : title)
    }
}

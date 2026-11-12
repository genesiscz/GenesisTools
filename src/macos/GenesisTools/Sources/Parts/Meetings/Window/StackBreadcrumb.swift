import SwiftUI

// MARK: - The context stack's breadcrumb in the dock (R38, G-STACK-2)

/// "Design review › Q12 › ▶ 1:49:48 › ⌕ 1:49:40 to 1:50:10": the meeting, then each Moment on the context stack from
/// the bottom, the top marked as playing, then each range the reader zoomed the timeline to while it plays, the shown
/// one last. A click on a level below the top pops the stack to it (`onPop(index)`, the index into `moments`); a click
/// on the meeting reports `onMeeting` (the wiring picks: the Meeting view, or stop); a click on a range before the
/// shown one goes back to it, and a click on the playing level shows its own span again (`onView`). Only one sound
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
    /// The ranges the timeline was zoomed to while the top plays ("48:46 to 1:27:00"), the shown one last. Empty: the
    /// timeline shows the top's own span.
    var views: [String] = []
    var isPlaying: Bool = true
    var onMeeting: () -> Void = {}
    var onPop: (Int) -> Void = { _ in }
    /// The index of a range before the shown one, or nil for the top's own span.
    var onView: (Int?) -> Void = { _ in }

    var body: some View {
        HStack(spacing: 4) {
            level(meeting, top: false, held: !moments.isEmpty, tooltip: "Show the whole meeting", action: onMeeting)
                .accessibilityIdentifier("meetings.dock.crumb.meeting")
            ForEach(Array(moments.enumerated()), id: \.element.id) { index, moment in
                chevron
                let top = index == moments.count - 1
                level(top ? "\(isPlaying ? "▶" : "❚❚") \(moment.title)" : moment.title, top: top, held: !top,
                      tooltip: Self.tooltip(top: top, title: moment.title, zoomed: !views.isEmpty)) {
                    if !top { onPop(index) } else if !views.isEmpty { onView(nil) }
                }
                // Not disabled: a disabled button dims the one level that must read strongest.
                .accessibilityAddTraits(top ? .isSelected : [])
                .accessibilityIdentifier("meetings.dock.crumb")
            }
            ForEach(Array(views.enumerated()), id: \.offset) { index, title in
                chevron
                range(title, shown: index == views.count - 1) { onView(index) }
            }
        }
        .padding(.horizontal, 4).padding(.vertical, 3)
        .background(RoundedRectangle(cornerRadius: 7).fill(Color.primary.opacity(0.05)))
        .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(Color.primary.opacity(0.1)))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Context stack")
    }

    /// What a click on a Moment level does, in words.
    static func tooltip(top: Bool, title: String, zoomed: Bool) -> String {
        if !top { return "Back to \(title), where it stopped" }
        return zoomed ? "Plays now. Click to show all of it on the timeline again" : "Plays now"
    }

    private var chevron: some View {
        Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).foregroundStyle(.tertiary)
            .accessibilityHidden(true)
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

    /// A zoomed range: the shown one has an outline in the play hue, the ones before it are plain and go back.
    private func range(_ title: String, shown: Bool, action: @escaping () -> Void) -> some View {
        Button(action: { if !shown { action() } }) {
            HStack(spacing: 4) {
                Image(systemName: "magnifyingglass").font(.system(size: 9, weight: .semibold))
                Text(verbatim: title).font(.system(size: 12, weight: shown ? .medium : .regular).monospacedDigit())
                    .lineLimit(1).fixedSize()
            }
            .foregroundStyle(shown ? KitHue.play.ink : Color.primary.opacity(0.75))
            .padding(.horizontal, 6).padding(.vertical, 1)
            .background(RoundedRectangle(cornerRadius: 5).fill(shown ? KitHue.play.ink.opacity(0.14) : Color.clear))
            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(shown ? KitHue.play.ink.opacity(0.55) : Color.clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverPlain())
        .instantTooltip(shown ? "The timeline shows \(title)" : "Back to \(title)")
        .accessibilityLabel(shown ? "The timeline shows \(title)" : "Back to \(title)")
        .accessibilityAddTraits(shown ? .isSelected : [])
        .accessibilityIdentifier("meetings.dock.crumb.view")
    }
}

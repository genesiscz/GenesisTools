import SwiftUI

/// The two calendar numbers of "Ask each time" as one picture, so the reader sees what each decides before reading a
/// sentence: a line of time with the meeting on it, the band around its start where a calendar entry counts as its
/// entry (the slack), and the stretch before it that the calendar read covers (the look-behind).
///
/// The picture is a scheme, not to scale: 15 minutes beside 3 hours would be a hairline. Its words carry the numbers
/// and follow the two fields as they change. The rules it draws are `calendarCandidates` (an entry counts when it
/// overlaps the meeting or starts within the slack of its start) and `viewProposals` (the read starts the longer of
/// the two before the meeting) in the TypeScript engine.
struct MeetingsCalendarMatchDiagram: View {
    let slackMin: Int
    let lookbehindHours: Int
    @Environment(\.isEnabled) private var isEnabled

    /// The look-behind widens the read only when it is longer than the slack.
    private var readsBack: Bool { lookbehindHours * 60 > slackMin }

    private var sentence: String {
        var parts = [slackMin > 0
            ? "A calendar entry that starts within \(slackMin) minutes of the meeting's start counts as its entry."
            : "Only a calendar entry that overlaps the meeting counts as its entry."]
        if readsBack {
            parts.append("The calendar is read from \(Plural.count(lookbehindHours, "hour")) before the meeting.")
        }
        return parts.joined(separator: " ")
    }

    var body: some View {
        GeometryReader { proxy in
            let width = proxy.size.width
            let start = (width * 0.56).rounded()
            let half = (width * 0.13).rounded()
            let band = RoundedRectangle(cornerRadius: 5, style: .continuous)
            ZStack(alignment: .topLeading) {
                if readsBack {
                    let room = max(0, start - half - 6)
                    caption("read from \(Plural.count(lookbehindHours, "hour")) before", color: Color.white.opacity(0.5))
                        .frame(width: room)
                    Capsule()
                        .strokeBorder(Color.white.opacity(0.32), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                        .frame(width: room, height: 10)
                        .offset(y: 18)
                }
                if slackMin > 0 {
                    caption("± \(slackMin) min counts", color: KitHue.play.ink)
                        .frame(width: half * 2)
                        .offset(x: start - half)
                    band.fill(KitHue.play.ink.opacity(0.24))
                        .overlay(band.strokeBorder(KitHue.play.ink.opacity(0.75), lineWidth: 1))
                        .frame(width: half * 2, height: 10)
                        .offset(x: start - half, y: 18)
                }
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .fill(LinearGradient(
                        stops: [.init(color: Color.white.opacity(0.24), location: 0),
                                .init(color: Color.white.opacity(0.24), location: 0.6),
                                .init(color: Color.white.opacity(0.03), location: 1)],
                        startPoint: .leading, endPoint: .trailing))
                    .frame(width: max(0, width - start), height: 16)
                    .overlay(alignment: .leading) {
                        Text(verbatim: "the meeting").font(.system(size: 9.5, weight: .medium))
                            .foregroundStyle(Color.white.opacity(0.85)).padding(.leading, 8)
                    }
                    .offset(x: start, y: 33)
                // The meeting's start, through both lines.
                Capsule().fill(Color.white.opacity(0.8))
                    .frame(width: 1.5, height: 37)
                    .offset(x: start - 0.75, y: 14)
            }
        }
        .frame(height: 51)
        .opacity(isEnabled ? 1 : 0.45)
        .accessibilityElement()
        .accessibilityLabel(sentence)
    }

    private func caption(_ text: String, color: Color) -> some View {
        Text(verbatim: text).font(.system(size: 10, weight: .medium)).foregroundStyle(color)
            .lineLimit(1).minimumScaleFactor(0.8)
    }
}

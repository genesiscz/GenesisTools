import Foundation

/// A drag belongs to one rendered lane group, so another window or an external text drop cannot assign its data.
struct SpeakerLaneDrag: Codable, Equatable {
    let owner: UUID
    let label: String
    let fromSec: Double
    let toSec: Double

    /// Recheck the source against the current lanes after the drag. A refresh may have removed its span meanwhile.
    func stretch(owner: UUID, target: String, speakers: [MeetingsAPI.MeetingSpeakers.Speaker]) -> DecisionAction.Stretch? {
        guard self.owner == owner, !label.isEmpty, !target.isEmpty, label != target,
              fromSec.isFinite, toSec.isFinite, fromSec >= 0, toSec >= fromSec,
              speakers.contains(where: { $0.label == target }),
              let source = speakers.first(where: { $0.label == label }),
              source.talkSpans.contains(where: { $0.fromSec == fromSec }),
              source.talkSpans.contains(where: { $0.toSec == toSec }) else { return nil }
        return .init(label: label, fromSec: fromSec, toSec: toSec)
    }
}

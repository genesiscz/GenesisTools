import Foundation

/// One person's stay in the meeting as the one editor of who was there edits it (audit M5): the join and the leave on
/// the transcript clock and the seat. The people chip, the "Who was there" strip and its drag read and write this one
/// shape through `meeting.people.edit`, with one time format.
struct PersonStay: Equatable {
    var name: String
    /// nil: from the start of the meeting.
    var fromSec: Double?
    /// nil: to its end.
    var toSec: Double?
    /// At this Mac's microphone, in the room; false: on another device.
    var atMic: Bool
    /// Whose device another seat goes through; nil for the person's own.
    var via: String?
    /// The stays the record keeps for them; a save replaces them with this one window.
    var stays: Int

    /// The person as the record has them now; a name the record lacks reads as a new person in the room.
    static func of(_ name: String, in record: MeetingRecordView?) -> PersonStay {
        let participant = record?.participants?.first { $0.name == name }
        let attended = record?.attendance?.people.first { $0.name == name }
        let group = record?.seats?.microphones?.first { $0.people.contains(name) }
        let stays = participant?.stays ?? []
        let inRoom = group?.id == "self" || record?.seats?.room.contains(name) == true
        return PersonStay(name: name,
                          fromSec: attended?.fromSec ?? stays.first?.fromSec ?? participant?.firstSeenSec,
                          toSec: attended?.toSec ?? stays.last?.toSec,
                          atMic: participant == nil || inRoom,
                          via: group?.id == "self" ? nil : group?.deviceId,
                          stays: stays.count)
    }

    func params(meeting: String, remove: Bool = false) -> MeetingsAPI.MeetingPeopleEdit.Params {
        .init(meeting: meeting, name: name, action: remove ? "remove" : "add", fromSec: remove ? nil : fromSec,
              toSec: remove ? nil : toSec, atMic: remove ? nil : atMic, via: remove || atMic ? nil : via)
    }

    /// "00:05 to 1:05:30", "from the start to 42:10", "12:04 to the end".
    var windowWords: String {
        "\(fromSec.map(MeetingsFormat.clock) ?? "from the start") to \(toSec.map(MeetingsFormat.clock) ?? "the end")"
    }

    /// A clock text as seconds: "12:04", "1:05:30", "75"; an empty text is nil and valid ("from the start", "to the
    /// end"); anything else is not a time.
    enum Clock: Equatable {
        case empty
        case seconds(Double)
        case invalid

        init(_ text: String) {
            let trimmed = text.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty else { self = .empty; return }
            let parts = trimmed.split(separator: ":", omittingEmptySubsequences: false)
            guard (1...3).contains(parts.count) else { self = .invalid; return }
            var result = 0.0
            for (index, part) in parts.enumerated() {
                guard let number = Double(part), number.isFinite, number >= 0, index == 0 || number < 60 else {
                    self = .invalid
                    return
                }
                result = result * 60 + number
            }
            self = .seconds(result)
        }

        var value: Double? {
            if case .seconds(let seconds) = self { return seconds }
            return nil
        }
    }

    /// The draft's window from two clock texts, or why it is not one: nil when both are fine.
    static func problem(from: Clock, to: Clock, duration: Double?) -> String? {
        if from == .invalid || to == .invalid { return "Write a time as 12:04 or 1:05:30, or leave it empty." }
        if let start = from.value, let end = to.value, end < start { return "The leave comes before the join." }
        if let duration, let late = [from.value, to.value].compactMap({ $0 }).first(where: { $0 > duration + 1 }) {
            return "\(MeetingsFormat.clock(late)) is after the meeting's end (\(MeetingsFormat.clock(duration)))."
        }
        return nil
    }
}

extension MeetingDetailModel {
    /// Saves a person's stay and leaves a notice whose Undo puts `before` back (nil: a person added here, removed
    /// again). A person who had several stays gets no Undo: one window cannot bring them back, and the editor said so.
    func savePersonStay(_ stay: PersonStay, before: PersonStay?) async throws {
        try await editMeetingPerson(stay.params(meeting: id))
        let undoable = (before?.stays ?? 0) <= 1
        notices.push(StackedNotice(text: "\(stay.name): \(stay.windowWords)", actions: undoable ? [.undo { [weak self] _ in
            self?.undoPersonStay(stay, before: before)
        }] : []))
    }

    /// Removes a person and leaves a notice whose Undo adds them back, with one stay from their first join to their
    /// last leave when they had several.
    func removePersonStay(_ stay: PersonStay) async throws {
        try await editMeetingPerson(stay.params(meeting: id, remove: true))
        let text = stay.stays > 1 ? "Removed \(stay.name); Undo brings them back with one stay, \(stay.windowWords)"
                                  : "Removed \(stay.name) from the meeting"
        notices.push(StackedNotice(text: text, actions: [.undo { [weak self] _ in self?.undoPersonStay(nil, before: stay) }]))
    }

    /// `after` nil undoes a removal; `before` nil undoes an addition.
    private func undoPersonStay(_ after: PersonStay?, before: PersonStay?) {
        Task {
            do {
                if let before {
                    try await editMeetingPerson(before.params(meeting: id))
                } else if let after {
                    try await editMeetingPerson(after.params(meeting: id, remove: true))
                }
            } catch {
                notices.push(.meetingsFailure(error))
            }
        }
    }
}

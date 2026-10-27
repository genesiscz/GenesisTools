import Foundation

/// Who decides the text of a field that round-trips through the widget's stored state: the user editing it, or the
/// snapshots that carry the stored copy back.
///
/// `hub widget watch` reads `state.json` when a snapshot starts and sends the snapshot when it is done, which takes 1 to
/// 17 s under load. So a snapshot can carry a draft older than a save that already landed, and written into the field
/// it took the newer typing away until the next save put it back (Martin, 2026-10-27: "it literally removed part of
/// the message or re-added it"). A key is held, and no snapshot writes it, while:
/// - a field showing it has the keyboard,
/// - it was edited less than `quietPeriod` ago,
/// - an edit of it is not stored yet,
/// - or the snapshot was read before the newest stored write of it (`floor`: `state.json`'s revision after the write).
/// Echoes of the field's own saves then arrive at or above the floor and carry the text the field already shows; a
/// change made elsewhere (another surface answered, the draft was sent) applies once the field is idle.
struct FieldTextOwnership {
    /// How long after the last keystroke the field keeps its text, whatever a snapshot says.
    var quietPeriod: TimeInterval = 3
    private(set) var unsaved: Set<String> = []
    private var lastEdit: [String: Date] = [:]
    /// The fields that have the keyboard, by field id, with the key each one shows.
    private var focused: [String: String] = [:]
    /// The lowest state revision whose copy of a key is not older than this model's last stored write of it.
    private var floors: [String: Int] = [:]
    /// Keys whose write landed while its revision is still being read.
    private var awaitingFloor: Set<String> = []
    private var writeGeneration: [String: Int] = [:]

    /// The user typed into the field of `key`.
    mutating func edited(_ key: String, at now: Date) {
        unsaved.insert(key)
        lastEdit[key] = now
    }

    /// A write of `key` is on its way that no keystroke started (an attachment, a dictation, a send).
    mutating func pending(_ key: String) { unsaved.insert(key) }

    func isUnsaved(_ key: String) -> Bool { unsaved.contains(key) }

    /// The newest write of `key` is stored; its revision follows through `stored(_:at:)`.
    @discardableResult
    mutating func landed(_ key: String) -> Int {
        unsaved.remove(key)
        awaitingFloor.insert(key)
        writeGeneration[key, default: 0] += 1
        return writeGeneration[key]!
    }

    /// `state.json`'s revision read after the write of `key` landed. A floor only rises.
    mutating func stored(_ key: String, at revision: Int, generation: Int? = nil) {
        if let generation, writeGeneration[key] != generation { return }
        awaitingFloor.remove(key)
        floors[key] = max(floors[key] ?? revision, revision)
    }

    mutating func focus(field: String, key: String?) {
        focused[field] = key
    }

    mutating func blur(field: String, key: String) {
        if focused[field] == key { focused.removeValue(forKey: field) }
    }

    /// Whether a snapshot read at state `revision` may write its copy of `key` into the field.
    func accepts(_ key: String, revision: Int, now: Date) -> Bool {
        if unsaved.contains(key) || awaitingFloor.contains(key) || focused.values.contains(key) { return false }
        if let last = lastEdit[key], now.timeIntervalSince(last) < quietPeriod { return false }
        return revision >= floors[key, default: Int.min]
    }

    /// When the typing hold on `key` ends by time alone, if it has not yet.
    func quietEnds(_ key: String, now: Date) -> Date? {
        guard let last = lastEdit[key] else { return nil }
        let end = last.addingTimeInterval(quietPeriod)
        return end > now ? end : nil
    }
}

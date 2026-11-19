import SwiftUI

/// The seats as the sheet edits them (w_sbxfmxen): people are picked, never typed as comma lists; a microphone is
/// this Mac's or a remote person's device, never a typed id; its members are ticked from the seats of its kind. Each
/// seat has start and end clock fields in the person editor's format (`PersonStay.Clock`), parsed on Save so
/// "1:" keeps its colon while the minutes are typed. What Save writes keeps the engine's shape (`MeetingSeats`).
struct MeetingSeatsDraft: Equatable {
    var seats: MeetingSeats
    var roomJoins: [String]
    var roomLeaves: [String]
    var joins: [String]
    var leaves: [String]
    /// The older groups (made another way) that carried room people when the sheet opened. Their seat kind stays with
    /// the group, so unticking the last member keeps the room's tick boxes instead of turning it into a remote device.
    private let roomGroupIDs: Set<String>

    init(_ seats: MeetingSeats) {
        self.seats = seats
        roomJoins = seats.roomRows.map { Self.displayJoin($0.fromSec) }
        roomLeaves = seats.roomRows.map { $0.toSec.map(Self.displayClock) ?? "" }
        joins = seats.remote.map { Self.displayJoin($0.fromSec) }
        leaves = seats.remote.map { $0.toSec.map(Self.displayClock) ?? "" }
    }

    /// A join this close to the start is the start. The call roster's first read lands a second or so after the
    /// recording starts (1.4 s on a real call), and "00:01.4" in the field read as a join time nobody could know.
    static let startSlack: Double = 2

    /// The device a microphone group stands for: the engine writes `self` for this Mac's microphone and
    /// `device:<owner>` with the owner's name for a remote person's own device (room-people.ts). A group made another
    /// way keeps its id and owner until the device is changed.
    enum Device: Hashable {
        case thisMac
        case owner(String)
        case other(id: String, owner: String?)

        init(_ group: MeetingSeats.Microphone) {
            if group.id == "self" { self = .thisMac }
            else if let owner = group.deviceId, group.id == "device:\(owner)" { self = .owner(owner) }
            else { self = .other(id: group.id, owner: group.deviceId) }
        }

        var title: String {
            switch self {
            case .thisMac: return "This Mac's microphone"
            case .owner(let owner): return "\(owner)'s device"
            case .other(let id, let owner): return owner.map { "\($0)'s device" } ?? "Device \(id)"
            }
        }

        /// This Mac's microphone carries room people; another device carries remote people.
        var carriesRoom: Bool { self == .thisMac }

        fileprivate func apply(to group: inout MeetingSeats.Microphone) {
            switch self {
            case .thisMac: group.id = "self"; group.deviceId = nil
            case .owner(let owner): group.id = "device:\(owner)"; group.deviceId = owner
            case .other(let id, let owner): group.id = id; group.deviceId = owner
            }
        }
    }

    // MARK: Seats

    /// A whole-meeting pick moves the person. Adding an interval keeps the other stays and device memberships.
    mutating func seatInRoom(_ name: String, additionalInterval: Bool = false) {
        let name = name.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return }
        if !additionalInterval {
            guard !Self.contains(seats.room, name) else { return }
            unseat(name)
        }
        seats.roomRows.append(.init(name))
        roomJoins.append("")
        roomLeaves.append("")
    }

    mutating func seatRemote(_ name: String, additionalInterval: Bool = false) {
        let name = name.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return }
        if !additionalInterval {
            guard !seats.remote.contains(where: { Self.same($0.name, name) }) else { return }
            unseat(name)
        }
        seats.remote.append(.init(name: name))
        joins.append("")
        leaves.append("")
    }

    mutating func unseat(_ name: String) {
        for index in seats.roomRows.indices.reversed() where Self.same(seats.roomRows[index].name, name) {
            removeRoom(at: index)
        }
        for index in seats.remote.indices.reversed() where Self.same(seats.remote[index].name, name) {
            removeRemote(at: index)
        }
        dropMember(name)
    }

    mutating func removeRoom(at index: Int) {
        guard seats.roomRows.indices.contains(index) else { return }
        let roomGroups = (seats.microphones ?? []).indices.filter { carriesRoom($0) }
        let name = seats.roomRows.remove(at: index).name
        roomJoins.remove(at: index)
        roomLeaves.remove(at: index)
        if !Self.contains(seats.room, name) { dropMember(name, from: roomGroups) }
    }

    mutating func removeRemote(at index: Int) {
        guard seats.remote.indices.contains(index) else { return }
        let remoteGroups = (seats.microphones ?? []).indices.filter { !carriesRoom($0) }
        let name = seats.remote.remove(at: index).name
        joins.remove(at: index)
        leaves.remove(at: index)
        if !seats.remote.contains(where: { Self.same($0.name, name) }) { dropMember(name, from: remoteGroups) }
    }

    private mutating func dropMember(_ name: String, from indices: [Int]? = nil) {
        guard var groups = seats.microphones else { return }
        for index in indices ?? Array(groups.indices) { groups[index].people.removeAll { Self.same($0, name) } }
        seats.microphones = groups
    }

    // MARK: Microphones

    func device(at index: Int) -> Device {
        guard let groups = seats.microphones, groups.indices.contains(index) else { return .thisMac }
        return Device(groups[index])
    }

    /// Whether the group at `index` holds room people: this Mac's microphone, or an older group whose members sat in
    /// the room when the sheet opened, whatever is ticked now.
    func carriesRoom(_ index: Int) -> Bool {
        guard let groups = seats.microphones, groups.indices.contains(index) else { return false }
        switch Device(groups[index]) {
        case .thisMac: return true
        case .owner, .other:
            let remote = seats.remote.map(\.name)
            return !groups[index].people.allSatisfy { Self.contains(remote, $0) }
        }
    }

    /// The people a group may hold: the room for a room microphone, the remote people for a device.
    func eligible(_ index: Int) -> [String] {
        carriesRoom(index) ? seats.room : MeetingSeats.names(seats.remote.map(\.name))
    }

    /// The tick boxes of a group: who it may hold, then anyone it holds outside them (an older record), so Save never
    /// keeps a member the sheet does not show.
    func members(_ index: Int) -> [String] {
        let eligible = eligible(index)
        let eligibleKeys = Set(eligible.map(PeopleText.personKey))
        let held = seats.microphones.flatMap { $0.indices.contains(index) ? $0[index].people : nil } ?? []
        return eligible + held.filter { !eligibleKeys.contains(PeopleText.personKey($0)) }
    }

    /// The devices the group at `index` can switch to: this Mac and each remote person's device that no other group is.
    func devices(for index: Int? = nil) -> [(device: Device, free: Bool)] {
        let groups = seats.microphones ?? []
        let others = groups.indices.filter { $0 != index }.map { groups[$0] }
        let takenIDs = Set(others.map(\.id))
        let owners = Set(others.compactMap(\.deviceId).map(PeopleText.personKey))
        var choices: [(device: Device, free: Bool)] = [(.thisMac, !takenIDs.contains("self"))]
        for name in MeetingSeats.names(seats.remote.map(\.name)) {
            let available = !owners.contains(PeopleText.personKey(name)) && !takenIDs.contains("device:\(name)")
            choices.append((.owner(name), available))
        }
        return choices
    }

    /// The devices a new microphone can be: this Mac's while it has no group, and each remote person's own device
    /// that has none yet.
    var newDevices: [Device] {
        devices().compactMap { $0.free ? $0.device : nil }
    }

    /// Adds a microphone for `device`, with the people it most likely carries: the room for this Mac, the owner for
    /// their own device.
    mutating func addMicrophone(_ device: Device) {
        var group = MeetingSeats.Microphone()
        device.apply(to: &group)
        switch device {
        case .thisMac: group.people = seats.room
        case .owner(let owner): group.people = [owner]
        case .other: break
        }
        seats.microphones = (seats.microphones ?? []) + [group]
    }

    /// Another device for the group at `index`; members of the other kind leave it.
    mutating func setDevice(_ device: Device, at index: Int) {
        guard var groups = seats.microphones, groups.indices.contains(index) else { return }
        device.apply(to: &groups[index])
        let allowed = device.carriesRoom ? seats.room : seats.remote.map(\.name)
        groups[index].people.removeAll { !Self.contains(allowed, $0) }
        if case .owner(let owner) = device, !Self.contains(groups[index].people, owner) { groups[index].people.insert(owner, at: 0) }
        seats.microphones = groups
    }

    mutating func removeMicrophone(at index: Int) {
        guard seats.microphones?.indices.contains(index) == true else { return }
        seats.microphones?.remove(at: index)
    }

    mutating func toggle(_ name: String, inMicrophone index: Int) {
        guard var groups = seats.microphones, groups.indices.contains(index) else { return }
        if Self.contains(groups[index].people, name) { groups[index].people.removeAll { Self.same($0, name) } }
        else { groups[index].people.append(name) }
        seats.microphones = groups
    }

    // MARK: Save

    private static func displayClock(_ sec: Double) -> String {
        // The shared clock converts tenths to Int. Keep large, valid transcript seconds editable as seconds.
        sec < Double(Int.max) / 10 ? ListenPresenceStrip.clock(sec) : String(sec)
    }

    /// An empty join field shows "At the start", so a join within `startSlack` stays empty.
    private static func displayJoin(_ sec: Double?) -> String {
        guard let sec else { return "" }
        return sec <= startSlack ? "" : displayClock(sec)
    }

    /// An unchanged clock field still denotes the full stored time, even when its display rounded to a tenth or showed
    /// an early join as empty.
    private func clock(_ fields: [String], at index: Int, stored: Double?, join: Bool) -> PersonStay.Clock {
        let text = fields.indices.contains(index) ? fields[index] : ""
        if let stored, text == (join ? Self.displayJoin(stored) : Self.displayClock(stored)) { return .seconds(stored) }
        return PersonStay.Clock(text)
    }

    /// A seat row's join and leave as Save would write them; nil for an empty or unreadable field.
    func times(_ kind: MeetingSeatsEditor.SeatKind, at index: Int) -> (from: Double?, to: Double?) {
        switch kind {
        case .room:
            guard seats.roomRows.indices.contains(index) else { return (nil, nil) }
            let row = seats.roomRows[index]
            return (clock(roomJoins, at: index, stored: row.fromSec, join: true).value,
                    clock(roomLeaves, at: index, stored: row.toSec, join: false).value)
        case .remote:
            guard seats.remote.indices.contains(index) else { return (nil, nil) }
            let row = seats.remote[index]
            return (clock(joins, at: index, stored: row.fromSec, join: true).value,
                    clock(leaves, at: index, stored: row.toSec, join: false).value)
        }
    }

    /// Where a seat's times come from, in the words of the "Who was there" strip (`ListenPresenceStrip.sourceWords`):
    /// the record's stay or attendance row at the same second, else the time was set by hand. A read of the call
    /// roster says that the exact time is not known; a join within `startSlack` is the start.
    @MainActor
    static func timeWords(name: String, from: Double?, to: Double?, record: MeetingRecordView?) -> String {
        let key = PeopleText.personKey(name)
        let person = record?.participants?.first { PeopleText.personKey($0.name) == key }
        let attended = record?.attendance?.people.filter { PeopleText.personKey($0.name) == key } ?? []
        func same(_ a: Double?, _ b: Double) -> Bool { a.map { abs($0 - b) < 0.05 } ?? false }
        let roster = "platform-roster"
        var clauses: [(source: String, text: String)] = []
        if let from {
            let source: String?
            if let stay = person?.stays?.first(where: { same($0.fromSec, from) }) { source = stay.source }
            else if same(person?.firstSeenSec, from) { source = person?.from?.contains(roster) == true ? roster : nil }
            else if attended.contains(where: { same($0.fromSec, from) }) { source = "attendance" }
            else { source = "hand" }
            var text: String
            if from <= startSlack { text = "there when the recording started" }
            else if source == roster { text = "first seen \(ListenPresenceStrip.clock(from))" }
            else { text = "joined at \(ListenPresenceStrip.clock(from))" }
            if source == roster { text += ", the exact join time is unknown" }
            clauses.append((ListenPresenceStrip.sourceWords(source), text))
        }
        if let to {
            let source: String?
            if let stay = person?.stays?.first(where: { same($0.toSec, to) }) { source = stay.leaveSource ?? stay.source }
            else if attended.contains(where: { same($0.toSec, to) }) { source = "attendance" }
            else { source = "hand" }
            let text = source == roster ? "last seen \(ListenPresenceStrip.clock(to)), the exact leave time is unknown"
                : "left at \(ListenPresenceStrip.clock(to))"
            clauses.append((ListenPresenceStrip.sourceWords(source), text))
        }
        guard let first = clauses.first else { return "Whole meeting." }
        func sentence(_ source: String, _ text: String) -> String {
            let head = source.prefix(1).uppercased() + String(source.dropFirst())
            return "\(head): \(text)."
        }
        if clauses.count == 2, clauses[1].source == first.source {
            return sentence(first.source, "\(first.text), \(clauses[1].text)")
        }
        return clauses.map { sentence($0.source, $0.text) }.joined(separator: " ")
    }

    /// The first thing Save cannot write, in words; nil when the seats are whole.
    var problem: String? {
        func check(_ name: String, _ join: PersonStay.Clock, _ leave: PersonStay.Clock) -> String? {
            PersonStay.problem(from: join, to: leave, duration: nil).map { "\(name): \($0)" }
        }
        for (index, row) in seats.roomRows.enumerated() {
            if let problem = check(row.name, clock(roomJoins, at: index, stored: row.fromSec, join: true),
                                   clock(roomLeaves, at: index, stored: row.toSec, join: false)) { return problem }
        }
        for (index, row) in seats.remote.enumerated() {
            if let problem = check(row.name, clock(joins, at: index, stored: row.fromSec, join: true),
                                   clock(leaves, at: index, stored: row.toSec, join: false)) { return problem }
        }
        if let issue = parsed.intervalProblem() { return issue }
        for (index, group) in (seats.microphones ?? []).enumerated() {
            if group.people.isEmpty { return "\(device(at: index).title) carries nobody. Tick a person, or remove it." }
            let available = eligible(index)
            if let person = group.people.first(where: { !Self.contains(available, $0) }) {
                return "\(person) has no seat on \(device(at: index).title)."
            }
        }
        return nil
    }

    /// The seats Save writes, with the typed times read.
    var parsed: MeetingSeats {
        var seats = seats
        for index in seats.roomRows.indices {
            let read = times(.room, at: index)
            seats.roomRows[index].fromSec = read.from
            seats.roomRows[index].toSec = read.to
        }
        for index in seats.remote.indices {
            let read = times(.remote, at: index)
            seats.remote[index].fromSec = read.from
            seats.remote[index].toSec = read.to
        }
        if seats.microphones?.isEmpty == true { seats.microphones = nil }
        return seats
    }

    /// The engine compares names with case and accents folded (`nameKey`).
    static func same(_ a: String, _ b: String) -> Bool { PeopleText.personKey(a) == PeopleText.personKey(b) }

    static func contains(_ names: [String], _ name: String) -> Bool { names.contains { same($0, name) } }
}

/// The review starts with the engine's choices. Only a chosen room or remote seat goes into the save.
struct MeetingSeatChoices {
    typealias Seat = MeetingsAPI.SeatsSuggest.Seat
    let suggestion: MeetingsAPI.SeatsSuggest.Suggestion
    private(set) var choices: [String: Seat]
    private(set) var count: Int

    init(_ suggestion: MeetingsAPI.SeatsSuggest.Suggestion) {
        self.suggestion = suggestion
        choices = Dictionary(uniqueKeysWithValues: suggestion.people.map { ($0.name, $0.seat) })
        count = suggestion.people.filter { $0.seat != .unsure }.count
    }

    mutating func set(_ seat: Seat, for name: String) {
        guard let old = choices[name], old != seat else { return }
        if old == .unsure { count += 1 }
        if seat == .unsure { count -= 1 }
        choices[name] = seat
    }

    /// A device decision can remove a proposed speaker. Keep manual picks only for people still suggested.
    func refreshed(with fresh: MeetingsAPI.SeatsSuggest.Suggestion) -> Self {
        var next = Self(fresh)
        for person in suggestion.people {
            if let pick = choices[person.name], pick != person.seat { next.set(pick, for: person.name) }
        }
        return next
    }

    /// Built only when a button takes the choices. A remote person's original fractional times survive the review.
    func seats(record: MeetingRecordView?) -> MeetingSeats {
        let remote = Dictionary(grouping: suggestion.seats.remote, by: { PeopleText.personKey($0.name) })
        let room = Dictionary(grouping: suggestion.seats.roomRows, by: { PeopleText.personKey($0.name) })
        var seats = MeetingSeats()
        var placed = Set<String>()
        for person in suggestion.people where placed.insert(person.name).inserted {
            switch choices[person.name] ?? .unsure {
            case .room: seats.roomRows += room[PeopleText.personKey(person.name)] ?? [.init(person.name)]
            case .remote:
                if let original = remote[PeopleText.personKey(person.name)] { seats.remote += original }
                else {
                    seats.remote += Self.remoteStays(for: person.name, record: record)
                }
            case .unsure: break
            }
        }
        return seats
    }

    private static func remoteStays(for name: String, record: MeetingRecordView?) -> [MeetingSeats.Remote] {
        let key = PeopleText.personKey(name)
        let participant = record?.participants?.first { PeopleText.personKey($0.name) == key }
        let attendance = record?.attendance?.people.filter { PeopleText.personKey($0.name) == key } ?? []
        let spans: [(from: Double, to: Double?)]
        if let stays = participant?.stays, attendance.isEmpty || stays.contains(where: { $0.source == "hand" }) {
            spans = stays.map { ($0.fromSec, $0.toSec) }
        } else if !attendance.isEmpty {
            spans = attendance.map { (max(0, $0.fromSec), $0.toSec) }
        } else {
            return [.init(name: name, fromSec: participant?.firstSeenSec)]
        }
        var rows: [MeetingSeats.Remote] = []
        for span in spans.sorted(by: { $0.from < $1.from }) where (span.to ?? .infinity) > span.from {
            if let last = rows.last, span.from <= (last.toSec ?? .infinity) {
                let end = max(last.toSec ?? .infinity, span.to ?? .infinity)
                rows[rows.count - 1].toSec = end.isFinite ? end : nil
            } else {
                rows.append(.init(name: name, fromSec: span.from, toSec: span.to))
            }
        }
        return rows
    }
}

struct RoomDeviceOfferRow: View {
    let offer: RoomDeviceOffer
    let window: MeetingsWindowModel?
    let answer: (Bool) -> Void
    @State private var showingMeetings = false
    @State private var titles: [String: String] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(verbatim: offer.question).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                Button("Yes") { answer(true) }
                    .accessibilityLabel("Yes, mark \(offer.account) as a room device")
                    .accessibilityIdentifier("meetings.devices.yes.\(offer.account)")
                Button("No") { answer(false) }
                    .accessibilityLabel("No, keep \(offer.account) as a person")
                    .accessibilityIdentifier("meetings.devices.no.\(offer.account)")
            }
            .buttonStyle(.bordered)
            GenDisclosure(Plural.count(offer.meetings.count, "meeting"), isExpanded: $showingMeetings, minHeight: 22) {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(offer.meetings, id: \.self) { id in
                        Text(verbatim: titles[id] ?? id)
                    }
                }
                .task(id: offer.meetings) { await readTitles() }
            }
            .font(.callout).foregroundStyle(.secondary)
        }
        .padding(.vertical, 3)
    }

    /// The offer carries stable IDs. Resolve older meetings outside the overview only when the evidence is opened.
    private func readTitles() async {
        for id in offer.meetings where titles[id] == nil {
            guard !Task.isCancelled else { return }
            if let known = window?.meeting(id) {
                titles[id] = known.displayTitle
            } else if let record = try? await MeetingDetailModel.recordRead(id).run(service: window?.service),
                      !record.title.isEmpty, !Task.isCancelled {
                titles[id] = record.title
            }
        }
    }
}

/// "Seats and microphones…" from the meeting header's "…" menu: who sat in the room, who joined from elsewhere and
/// when, and which microphone carried whom. People come from the person picker the person editor uses (the meeting's
/// people first, or a new name), microphones from this Mac and the remote people's devices.
struct MeetingSeatsEditor: View {
    /// Menus, membership and validation follow edits. Redrawing the sheet only reads the rows.
    private struct FormState {
        struct Group {
            let microphone: MeetingSeats.Microphone
            let inRoom: Bool
            let members: [(name: String, checked: Bool)]
        }
        var draft: MeetingSeatsDraft {
            didSet {
                problem = draft.problem
                if oldValue.seats != draft.seats { updateGroups() }
            }
        }
        var problem: String?
        var groups: [Group] = []
        var newDevices: [MeetingSeatsDraft.Device] = []

        init(_ seats: MeetingSeats) {
            draft = MeetingSeatsDraft(seats)
            problem = draft.problem
            updateGroups()
        }

        private mutating func updateGroups() {
            groups = (draft.seats.microphones ?? []).enumerated().map { index, group in
                let held = Set(group.people.map(PeopleText.personKey))
                return Group(microphone: group, inRoom: draft.carriesRoom(index),
                             members: draft.members(index).map { ($0, held.contains(PeopleText.personKey($0))) })
            }
            newDevices = draft.newDevices
        }
    }
    @State private var form: FormState
    @State private var reviewing: Bool
    @State private var choices: MeetingSeatChoices?
    @State private var readFailure: MeetingsCLI.Failure?
    @State private var readAttempt = 0
    @State private var deviceActions = RoomDeviceActions()
    @State private var initiallyUnset: Bool
    let load: () async throws -> MeetingsAPI.SeatsSuggest.Suggestion
    let save: (MeetingSeats, Bool) async throws -> Void
    let saved: () -> Void
    @State private var saving = false
    @State private var failure: MeetingsCLI.Failure?
    /// The seat kind whose person picker is open.
    @State private var adding: SeatKind?
    @State private var query = ""
    @State private var search: PeopleSearch?
    @Environment(\.meetingDetail) private var detail
    @Environment(\.dismiss) private var dismiss

    enum SeatKind: String, Identifiable {
        case room, remote
        var id: String { rawValue }
    }

    /// What an empty time field means, shown in the field itself (U5: empty boxes read as a missing answer).
    static let startPrompt = "At the start"
    static let endPrompt = "At the end"

    /// A label names a person's own audio channel in the transcript, so it means something only when the recording
    /// keeps the voices apart (`evidence.channels.layout` "left-mic" or "right-mic"). A label already set stays
    /// visible, so it can be cleared. An unmeasured meeting (no layout) shows none.
    static func showsLabel(layout: String?, current: String?) -> Bool {
        if current != nil { return true }
        guard let layout else { return false }
        return layout != "unknown"
    }

    init(seats: MeetingSeats?, preview: Loadable<MeetingsAPI.SeatsSuggest.Suggestion> = .idle,
         load: @escaping () async throws -> MeetingsAPI.SeatsSuggest.Suggestion,
         save: @escaping (MeetingSeats, Bool) async throws -> Void, saved: @escaping () -> Void) {
        _form = State(initialValue: FormState(seats ?? MeetingSeats()))
        _reviewing = State(initialValue: seats == nil)
        _choices = State(initialValue: preview.value.map(MeetingSeatChoices.init))
        _readFailure = State(initialValue: preview.failure)
        _initiallyUnset = State(initialValue: seats == nil)
        self.load = load
        self.save = save
        self.saved = saved
    }

    var body: some View {
        if let detail {
            editor.noticeStack(detail.notices, alignment: detail.window?.noticePlace.alignment ?? .bottom)
        } else {
            editor
        }
    }

    private var editor: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Seats and microphones").font(.headline)
                Text("Who sat in the room, who joined from elsewhere, and which microphone carried whom. The voice pass narrows each line's speaker by these facts.")
                    .font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if reviewing {
                suggestionReview
            } else {
                manualForm
            }
            if !reviewing, let problem = form.problem {
                Text(problem).font(.system(size: 11.5)).foregroundStyle(KitHue.care.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("meetings.seats.problem")
            }
            if let failure {
                NoticePill(text: "Not saved: \(failure.sentence)", more: failure.detail, tone: .error)
            }
            HStack {
                if reviewing {
                    Button(initiallyUnset ? "Edit seats manually…" : "Back to current seats") {
                        if initiallyUnset, let choices { form = FormState(choices.seats(record: detail?.record.value)) }
                        reviewing = false
                    }
                } else if !initiallyUnset {
                    Button("Review suggestion…") { reviewing = true }
                }
                Spacer()
                if saving { ProgressView().controlSize(.small) }
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button(reviewing ? "Use suggestion" : "Save") {
                    if reviewing, let choices { submit(choices.seats(record: detail?.record.value)) }
                    else { submit(form.draft.parsed) }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(reviewing ? readFailure != nil || (choices?.count ?? 0) == 0 : form.problem != nil || emptyFirstSave)
                .accessibilityIdentifier(reviewing ? "meetings.seats.useSuggestion" : "meetings.seats.save")
            }
        }
        .disabled(saving || deviceActions.busy)
        .padding(20)
        .frame(width: 620, height: 560)
        .onAppear {
            if let detail, case .idle = detail.speakers { detail.loadSpeakers() }
        }
        .onDisappear { search?.cancel() }
        .task(id: readAttempt) {
            if readAttempt > 0 || (choices == nil && readFailure == nil) { await reloadSuggestion() }
        }
    }

    private var emptyFirstSave: Bool {
        initiallyUnset && form.draft.seats.roomRows.isEmpty && form.draft.seats.remote.isEmpty
    }

    private var suggestionReview: some View {
        VStack(alignment: .leading) {
            if let readFailure {
                suggestionFailure(readFailure)
                Spacer()
            } else if let choices {
                if choices.suggestion.people.isEmpty && (choices.suggestion.deviceOffers ?? []).isEmpty {
                    Text("No people to suggest. Add seats manually.").foregroundStyle(.secondary)
                    Spacer()
                } else {
                    List {
                        offerRows
                        ForEach(choices.suggestion.people) { person in
                            seatChoice(person, choices: choices)
                        }
                    }
                    .listStyle(.plain)
                }
                if !initiallyUnset {
                    Text("Using this suggestion replaces the saved seats and microphone groups.")
                        .font(.callout).foregroundStyle(.secondary)
                }
            } else {
                ProgressView("Reading seat suggestions…")
                Spacer()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func seatChoice(_ person: MeetingsAPI.SeatsSuggest.Person, choices: MeetingSeatChoices) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(verbatim: person.name)
                Text(verbatim: person.reason).font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            Picker("Seat for \(person.name)", selection: Binding(
                get: { choices.choices[person.name] ?? .unsure },
                set: { self.choices?.set($0, for: person.name) })) {
                Text("Unsure").tag(MeetingSeatChoices.Seat.unsure)
                Text("In the room").tag(MeetingSeatChoices.Seat.room)
                Text("Remote").tag(MeetingSeatChoices.Seat.remote)
            }
            .labelsHidden().frame(width: 110)
        }
        .padding(.vertical, 3)
    }

    private func suggestionFailure(_ failure: MeetingsCLI.Failure) -> some View {
        NoticePill(text: failure.sentence, more: failure.detail, tone: .error, fixes: [
            .button("Retry", symbol: "arrow.clockwise") { readAttempt += 1 }
        ])
    }

    private func reloadSuggestion() async {
        do {
            let fresh = try await load()
            try Task.checkCancellation()
            choices = choices?.refreshed(with: fresh) ?? MeetingSeatChoices(fresh)
            readFailure = nil
        } catch {
            if !Task.isCancelled { readFailure = asFailure(error) }
        }
    }

    @ViewBuilder private var offerRows: some View {
        if let detail {
            ForEach(choices?.suggestion.deviceOffers ?? []) { offer in
                RoomDeviceOfferRow(offer: offer, window: detail.window) { yes in
                    deviceActions.submit(.answer(offer, meeting: detail.id, yes: yes), service: detail.service,
                                         notices: detail.notices, refresh: reloadSuggestion)
                }
            }
        }
    }

    /// The help of each section stands in its header, above the rows it explains: as footers, the 500 pt sheet pushed
    /// them below the fold, and the empty time boxes said nothing (U5).
    private var manualForm: some View {
        let record = detail?.record.value
        let layout = record?.evidence?.channels?.layout
        return Form {
            if let readFailure {
                suggestionFailure(readFailure)
            } else if !(choices?.suggestion.deviceOffers ?? []).isEmpty {
                Section("Room devices") { offerRows }
            }
            Section {
                room(record)
            } header: {
                sectionHeader("In the room", "Times on the transcript clock, as 12:04 or 1:05:30. Add a person again for another stretch in the room.")
            }
            Section {
                ForEach(Array(form.draft.seats.remote.enumerated()), id: \.offset) { index, person in
                    remote(index, person, layout: layout, record: record)
                }
                addButton(.remote)
            } header: {
                sectionHeader("Remote", "People who joined from another place, on their own device. The line under a name says where its times come from.")
            }
            Section {
                ForEach(Array(form.groups.enumerated()), id: \.offset) { index, group in
                    microphone(index, group, layout: layout)
                }
                addMicrophone
            } header: {
                sectionHeader("Microphones", "This Mac's microphone carries the people in the room; a remote person's device carries remote people.")
            }
        }
        .formStyle(.grouped)
    }

    private func sectionHeader(_ title: String, _ help: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
            Text(help).font(.system(size: 11, weight: .regular)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// A time field after its word ("Joined"); empty, it shows what empty means ("At the start").
    private func clockField(_ title: String, prompt: String, text: Binding<String>, label: String, identifier: String) -> some View {
        HStack(spacing: 4) {
            Text(title).foregroundStyle(.secondary)
            TextField(title, text: text, prompt: Text(prompt))
                .labelsHidden()
                .frame(width: 84)
                .accessibilityLabel(label)
                .accessibilityIdentifier(identifier)
        }
    }

    /// The line under a seat: where its times come from ("From the call's attendee list: first seen 00:20.4, …").
    private func sourceLine(_ text: String, identifier: String) -> some View {
        Text(verbatim: text).font(.system(size: 11)).foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier(identifier)
    }

    /// The labels a remote person's own channel can be: the transcript's, and any the seats already name.
    static func labels(_ detail: MeetingDetailModel?, _ seats: MeetingSeats) -> [String] {
        let speakers = detail?.speakers.value?.speakers.map(\.label) ?? []
        let renamed = detail?.record.value?.speakers.labels.keys.map { $0 } ?? []
        let named = seats.remote.compactMap(\.label) + (seats.microphones ?? []).compactMap(\.label)
        return Array(Set(speakers + renamed + named)).sorted { $0.localizedStandardCompare($1) == .orderedAscending }
    }

    // MARK: Room

    @ViewBuilder private func room(_ record: MeetingRecordView?) -> some View {
        let rows = form.draft.seats.roomRows
        ForEach(rows.indices, id: \.self) { index in
            let person = rows[index]
            let times = form.draft.times(.room, at: index)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text(verbatim: person.name).font(.system(size: 12.5, weight: .medium)).lineLimit(1)
                        .frame(minWidth: 100, maxWidth: .infinity, alignment: .leading)
                    clockField("From", prompt: Self.startPrompt, text: clock(\.roomJoins, index),
                               label: "When \(person.name) entered the room", identifier: "meetings.seats.room.join.\(index)")
                    clockField("Until", prompt: Self.endPrompt, text: clock(\.roomLeaves, index),
                               label: "When \(person.name) left the room", identifier: "meetings.seats.room.leave.\(index)")
                    IconButton(systemName: "minus.circle", tooltip: "Remove this room interval for \(person.name)") {
                        form.draft.removeRoom(at: index)
                    }
                    .accessibilityIdentifier("meetings.seats.room.remove.\(index)")
                }
                sourceLine(MeetingSeatsDraft.timeWords(name: person.name, from: times.from, to: times.to, record: record),
                           identifier: "meetings.seats.room.source.\(index)")
            }
            .textFieldStyle(.roundedBorder)
            .font(.system(size: 12))
        }
        addButton(.room)
    }

    // MARK: Remote

    private func remote(_ index: Int, _ person: MeetingSeats.Remote, layout: String?, record: MeetingRecordView?) -> some View {
        let times = form.draft.times(.remote, at: index)
        return VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                Text(verbatim: person.name).font(.system(size: 12.5, weight: .medium)).lineLimit(1)
                    .frame(minWidth: 100, maxWidth: .infinity, alignment: .leading)
                if Self.showsLabel(layout: layout, current: person.label) {
                    labelMenu(person.label, tooltip: "The transcript label of \(person.name)'s own audio channel") {
                        form.draft.seats.remote[index].label = $0
                    }
                }
                clockField("Joined", prompt: Self.startPrompt, text: clock(\.joins, index),
                           label: "When \(person.name) joined", identifier: "meetings.seats.remote.join.\(index)")
                clockField("Left", prompt: Self.endPrompt, text: clock(\.leaves, index),
                           label: "When \(person.name) left", identifier: "meetings.seats.remote.leave.\(index)")
                IconButton(systemName: "minus.circle", tooltip: "Take \(person.name) off the remote seats") {
                    form.draft.removeRemote(at: index)
                }
                .accessibilityIdentifier("meetings.seats.remote.remove.\(index)")
            }
            sourceLine(MeetingSeatsDraft.timeWords(name: person.name, from: times.from, to: times.to, record: record),
                       identifier: "meetings.seats.remote.source.\(index)")
        }
        .textFieldStyle(.roundedBorder)
        .font(.system(size: 12))
    }

    /// "Label: Speaker 2 ▾": the transcript's labels and None, no typed label.
    private func labelMenu(_ current: String?, tooltip: String, set: @escaping (String?) -> Void) -> some View {
        MenuButton(style: .genHoverPlain(), items: {
            let labels = Self.labels(detail, form.draft.seats)
            var items: [MenuButtonItem] = [.action("No label", checked: current == nil) { set(nil) }]
            if !labels.isEmpty { items.append(.divider) }
            items += labels.map { label in MenuButtonItem.action(label, checked: label == current) { set(label) } }
            if labels.isEmpty { items.append(.note("The transcript names no labels yet")) }
            return items
        }) {
            HStack(spacing: 3) {
                Text("Label").foregroundStyle(.secondary)
                Text(verbatim: current ?? "none").lineLimit(1)
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 7, weight: .semibold)).foregroundStyle(.secondary)
            }
            .font(.system(size: 11.5))
            .frame(minHeight: 22).contentShape(Rectangle())
        }
        .instantTooltip(tooltip)
    }

    private func clock(_ list: WritableKeyPath<MeetingSeatsDraft, [String]>, _ index: Int) -> Binding<String> {
        Binding(get: { form.draft[keyPath: list].indices.contains(index) ? form.draft[keyPath: list][index] : "" },
                set: { if form.draft[keyPath: list].indices.contains(index) { form.draft[keyPath: list][index] = $0 } })
    }

    // MARK: Microphones

    private func microphone(_ index: Int, _ choices: FormState.Group, layout: String?) -> some View {
        let group = choices.microphone
        let device = MeetingSeatsDraft.Device(group)
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                MenuButton(style: .genHoverPlain(), items: { deviceItems(index, current: device) }) {
                    HStack(spacing: 3) {
                        Text(verbatim: device.title).font(.system(size: 12.5, weight: .medium)).lineLimit(1)
                        Image(systemName: "chevron.up.chevron.down").font(.system(size: 7, weight: .semibold)).foregroundStyle(.secondary)
                    }
                    .frame(minHeight: 22).contentShape(Rectangle())
                }
                .instantTooltip("Which device this is: this Mac's microphone, or a remote person's own device")
                .accessibilityIdentifier("meetings.seats.mic.device.\(index)")
                Spacer(minLength: 6)
                if Self.showsLabel(layout: layout, current: group.label) {
                    labelMenu(group.label, tooltip: "The transcript label of this device's own audio channel") {
                        form.draft.seats.microphones?[index].label = $0
                    }
                }
                IconButton(systemName: "minus.circle", tooltip: "Remove \(device.title)") { form.draft.removeMicrophone(at: index) }
                    .accessibilityIdentifier("meetings.seats.mic.remove.\(index)")
            }
            if choices.members.isEmpty {
                Text(choices.inRoom ? "Seat people in the room first." : "Seat remote people first.")
                    .font(.system(size: 11.5)).foregroundStyle(.secondary)
            } else {
                WrapLayout(spacing: 12, lineSpacing: 4) {
                    ForEach(choices.members, id: \.name) { member in
                        Toggle(member.name, isOn: Binding(get: { member.checked },
                                                          set: { _ in form.draft.toggle(member.name, inMicrophone: index) }))
                            .toggleStyle(.checkbox).font(.system(size: 12))
                            .accessibilityIdentifier("meetings.seats.mic.\(index).member.\(member.name)")
                    }
                }
            }
        }
        .padding(.vertical, 2)
    }

    /// Runs at the click: this Mac and each remote person's device; one another group already is stays greyed.
    private func deviceItems(_ index: Int, current: MeetingSeatsDraft.Device) -> [MenuButtonItem] {
        var items = form.draft.devices(for: index).map { choice in
            MenuButtonItem.action(choice.device.title, checked: choice.device == current, enabled: choice.free) {
                form.draft.setDevice(choice.device, at: index)
            }
        }
        if case .other = current { items.insert(.action(current.title, checked: true) {}, at: 0) }
        return items
    }

    private var addMicrophone: some View {
        let devices = form.newDevices
        return MenuButton(style: .genHoverPlain(), items: {
            devices.map { device in MenuButtonItem.action(device.title) { form.draft.addMicrophone(device) } }
        }) {
            Label("Add a microphone…", systemImage: "plus").font(.system(size: 12))
                .frame(minHeight: 22).contentShape(Rectangle())
        }
        .disabled(devices.isEmpty)
        .instantTooltip(devices.isEmpty ? "This Mac and every remote person already have a microphone"
                                        : "This Mac's microphone, or a remote person's own device")
        .accessibilityIdentifier("meetings.seats.mic.add")
    }

    // MARK: Adding a person

    private func addButton(_ kind: SeatKind) -> some View {
        Button {
            query = ""
            adding = kind
        } label: {
            Label(kind == .room ? "Add a person…" : "Add a remote person…", systemImage: "plus").font(.system(size: 12))
        }
        .buttonStyle(.genHoverPlain())
        .instantTooltip(kind == .room ? "Someone at this Mac's microphone or elsewhere in the room"
                                      : "Someone who joined from another place, with their own device")
        .accessibilityIdentifier("meetings.seats.\(kind.rawValue).add")
        .popover(item: Binding(get: { adding == kind ? kind : nil }, set: { if $0 == nil { adding = nil } }),
                 arrowEdge: .bottom) { kind in
            picker(kind)
        }
    }

    private func picker(_ kind: SeatKind) -> some View {
        PersonPicker(people: search?.people ?? [], query: $query, sources: search?.sources ?? [],
                     title: kind == .room ? "In the room" : "Remote", prompt: "Search people or type a new name",
                     addRule: MeetingsPreferences.People.offerNew.value(), visibleRows: 5,
                     pick: { seat($0.name, kind) }, addNew: { seat($0, kind) }, cancel: { adding = nil },
                     grantContacts: detail?.window.map { window in { window.people.grantContacts() } })
            .onAppear {
                guard let detail else { return }
                let next = detail.peopleSearch(atSec: nil)
                search = next
                next.ask(query, after: .zero)
            }
            .onChange(of: query) { _, now in search?.ask(now) }
            .onDisappear { search?.cancel(); search = nil }
    }

    private func seat(_ name: String, _ kind: SeatKind) {
        adding = nil
        switch kind {
        case .room: form.draft.seatInRoom(name, additionalInterval: true)
        case .remote: form.draft.seatRemote(name, additionalInterval: true)
        }
    }

    // MARK: Save

    /// The sheet stays open until the write lands: a refusal shows here and the draft stays to correct.
    private func submit(_ seats: MeetingSeats) {
        guard !saving else { return }
        let submittedDraft = form.draft
        let submittedChoices = choices?.choices
        saving = true
        failure = nil
        Task {
            do {
                try await save(seats, initiallyUnset)
                saving = false
                if form.draft == submittedDraft && choices?.choices == submittedChoices { saved() }
            } catch {
                saving = false
                failure = asFailure(error)
            }
        }
    }
}

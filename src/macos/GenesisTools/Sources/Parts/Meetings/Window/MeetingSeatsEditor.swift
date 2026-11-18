import SwiftUI

/// The seats as the sheet edits them (w_sbxfmxen): people are picked, never typed as comma lists; a microphone is
/// this Mac's or a remote person's device, never a typed id; its members are ticked from the seats of its kind. Each
/// remote person's join and leave is clock text in the person editor's format (`PersonStay.Clock`), parsed on Save so
/// "1:" keeps its colon while the minutes are typed. What Save writes keeps the engine's shape (`MeetingSeats`).
struct MeetingSeatsDraft: Equatable {
    var seats: MeetingSeats
    var joins: [String]
    var leaves: [String]

    init(_ seats: MeetingSeats) {
        self.seats = seats
        joins = seats.remote.map { $0.fromSec.map(ListenPresenceStrip.clock) ?? "" }
        leaves = seats.remote.map { $0.toSec.map(ListenPresenceStrip.clock) ?? "" }
    }

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

    /// Seats `name` in the room. A person has one seat, so a remote seat of theirs goes, and with it their place in a
    /// remote device's group.
    mutating func seatInRoom(_ name: String) {
        let name = name.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty, !Self.contains(seats.room, name) else { return }
        dropRemote(name)
        seats.room.append(name)
    }

    /// Seats `name` as a remote person, from the start to the end until times are typed.
    mutating func seatRemote(_ name: String) {
        let name = name.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty, !seats.remote.contains(where: { Self.same($0.name, name) }) else { return }
        dropRoom(name)
        seats.remote.append(.init(name: name))
        joins.append("")
        leaves.append("")
    }

    /// Takes `name` out of every seat and every microphone.
    mutating func unseat(_ name: String) {
        dropRoom(name)
        dropRemote(name)
    }

    mutating func removeRemote(at index: Int) {
        guard seats.remote.indices.contains(index) else { return }
        unseat(seats.remote[index].name)
    }

    /// A person who leaves a seat leaves every microphone too: a group holds people of one kind of seat only.
    private mutating func dropRoom(_ name: String) {
        seats.room.removeAll { Self.same($0, name) }
        dropMember(name)
    }

    private mutating func dropRemote(_ name: String) {
        if let index = seats.remote.firstIndex(where: { Self.same($0.name, name) }) {
            seats.remote.remove(at: index)
            if joins.indices.contains(index) { joins.remove(at: index) }
            if leaves.indices.contains(index) { leaves.remove(at: index) }
        }
        dropMember(name)
    }

    private mutating func dropMember(_ name: String) {
        guard var groups = seats.microphones else { return }
        for index in groups.indices { groups[index].people.removeAll { Self.same($0, name) } }
        seats.microphones = groups
    }

    // MARK: Microphones

    func device(at index: Int) -> Device {
        guard let groups = seats.microphones, groups.indices.contains(index) else { return .thisMac }
        return Device(groups[index])
    }

    /// Whether the group at `index` holds room people: this Mac's microphone, or an older group whose members sit in
    /// the room.
    func carriesRoom(_ index: Int) -> Bool {
        guard let groups = seats.microphones, groups.indices.contains(index) else { return false }
        switch Device(groups[index]) {
        case .thisMac: return true
        case .owner: return false
        case .other:
            return !groups[index].people.isEmpty && groups[index].people.allSatisfy { Self.contains(seats.room, $0) }
        }
    }

    /// The people a group may hold: the room for a room microphone, the remote people for a device.
    func eligible(_ index: Int) -> [String] {
        carriesRoom(index) ? seats.room : seats.remote.map(\.name)
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
        for person in seats.remote {
            let available = !owners.contains(PeopleText.personKey(person.name)) && !takenIDs.contains("device:\(person.name)")
            choices.append((.owner(person.name), available))
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

    /// An unchanged clock field still denotes the full stored time, even when its display rounded to a tenth.
    private func clock(_ fields: [String], at index: Int, stored: Double?) -> PersonStay.Clock {
        let text = fields.indices.contains(index) ? fields[index] : ""
        if let stored, text == ListenPresenceStrip.clock(stored) { return .seconds(stored) }
        return PersonStay.Clock(text)
    }

    /// The first thing Save cannot write, in words; nil when the seats are whole.
    var problem: String? {
        for (index, person) in seats.remote.enumerated() {
            let join = clock(joins, at: index, stored: person.fromSec)
            let leave = clock(leaves, at: index, stored: person.toSec)
            if let problem = PersonStay.problem(from: join, to: leave, duration: nil) { return "\(person.name): \(problem)" }
        }
        for (index, group) in (seats.microphones ?? []).enumerated() where group.people.isEmpty {
            return "\(device(at: index).title) carries nobody. Tick a person, or remove it."
        }
        return nil
    }

    /// The seats Save writes, with the typed times read.
    var parsed: MeetingSeats {
        var seats = seats
        for index in seats.remote.indices {
            let person = seats.remote[index]
            seats.remote[index].fromSec = clock(joins, at: index, stored: person.fromSec).value
            seats.remote[index].toSec = clock(leaves, at: index, stored: person.toSec).value
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
        count = suggestion.seats.room.count + suggestion.seats.remote.count
    }

    mutating func set(_ seat: Seat, for name: String) {
        guard let old = choices[name], old != seat else { return }
        if old == .unsure { count += 1 }
        if seat == .unsure { count -= 1 }
        choices[name] = seat
    }

    /// Built only when a button takes the choices. A remote person's original fractional times survive the review.
    func seats(record: MeetingRecordView?) -> MeetingSeats {
        let remote = Dictionary(uniqueKeysWithValues: suggestion.seats.remote.map { ($0.name, $0) })
        var seats = MeetingSeats()
        for person in suggestion.people {
            switch choices[person.name] ?? .unsure {
            case .room: seats.room.append(person.name)
            case .remote:
                if let original = remote[person.name] { seats.remote.append(original) }
                else {
                    let stay = PersonStay.of(person.name, in: record)
                    seats.remote.append(.init(name: person.name, fromSec: stay.fromSec, toSec: stay.toSec))
                }
            case .unsure: break
            }
        }
        return seats
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
                .disabled(reviewing ? (choices?.count ?? 0) == 0 : form.problem != nil || emptyFirstSave)
                .accessibilityIdentifier(reviewing ? "meetings.seats.useSuggestion" : "meetings.seats.save")
            }
        }
        .disabled(saving)
        .padding(20)
        .frame(width: 620, height: 500)
        .onAppear {
            if let detail, case .idle = detail.speakers { detail.loadSpeakers() }
        }
        .onDisappear { search?.cancel() }
    }

    private var emptyFirstSave: Bool {
        initiallyUnset && form.draft.seats.room.isEmpty && form.draft.seats.remote.isEmpty
    }

    private var suggestionReview: some View {
        VStack(alignment: .leading) {
            if let choices {
                if choices.suggestion.people.isEmpty {
                    Text("No people to suggest. Add seats manually.").foregroundStyle(.secondary)
                    Spacer()
                } else {
                    List(choices.suggestion.people) { person in
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
                    .listStyle(.plain)
                }
                if !initiallyUnset {
                    Text("Using this suggestion replaces the saved seats and microphone groups.")
                        .font(.callout).foregroundStyle(.secondary)
                }
            } else if let readFailure {
                NoticePill(text: readFailure.sentence, more: readFailure.detail, tone: .error, fixes: [
                    .button("Retry", symbol: "arrow.clockwise") { self.readFailure = nil; readAttempt += 1 }
                ])
                Spacer()
            } else {
                ProgressView("Reading seat suggestions…")
                Spacer()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .task(id: readAttempt) {
            guard choices == nil, readFailure == nil else { return }
            do {
                let fresh = try await load()
                try Task.checkCancellation()
                choices = MeetingSeatChoices(fresh)
            } catch {
                if !Task.isCancelled { readFailure = asFailure(error) }
            }
        }
    }

    private var manualForm: some View {
        Form {
            Section {
                room
            } header: {
                Text("In the room")
            }
            Section {
                ForEach(Array(form.draft.seats.remote.enumerated()), id: \.offset) { index, person in remote(index, person) }
                addButton(.remote)
            } header: {
                Text("Remote")
            } footer: {
                Text("Times on the transcript clock, as 12:04 or 1:05:30. Empty: from the start, or to the end.")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            }
            Section {
                ForEach(Array(form.groups.enumerated()), id: \.offset) { index, group in
                    microphone(index, group)
                }
                addMicrophone
            } header: {
                Text("Microphones")
            } footer: {
                Text("This Mac's microphone carries people in the room; a remote person's device carries remote people.")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }

    /// The labels a remote person's own channel can be: the transcript's, and any the seats already name.
    static func labels(_ detail: MeetingDetailModel?, _ seats: MeetingSeats) -> [String] {
        let speakers = detail?.speakers.value?.speakers.map(\.label) ?? []
        let renamed = detail?.record.value?.speakers.labels.keys.map { $0 } ?? []
        let named = seats.remote.compactMap(\.label) + (seats.microphones ?? []).compactMap(\.label)
        return Array(Set(speakers + renamed + named)).sorted { $0.localizedStandardCompare($1) == .orderedAscending }
    }

    // MARK: Room

    private var room: some View {
        VStack(alignment: .leading, spacing: 8) {
            if form.draft.seats.room.isEmpty {
                Text("Nobody yet.").font(.system(size: 12)).foregroundStyle(.secondary)
            } else {
                WrapLayout(spacing: 6, lineSpacing: 6) {
                    ForEach(form.draft.seats.room, id: \.self) { name in personChip(name) }
                }
            }
            addButton(.room)
        }
    }

    private func personChip(_ name: String) -> some View {
        HStack(spacing: 4) {
            Text(verbatim: name).font(.system(size: 12))
            IconButton(systemName: "xmark", tooltip: "Take \(name) out of the room", size: 9) {
                form.draft.unseat(name)
            }
            .accessibilityIdentifier("meetings.seats.room.remove.\(name)")
        }
        .padding(.leading, 8).padding(.trailing, 2).padding(.vertical, 2)
        .background(Capsule().fill(Color.primary.opacity(0.08)))
    }

    // MARK: Remote

    private func remote(_ index: Int, _ person: MeetingSeats.Remote) -> some View {
        HStack(spacing: 8) {
            Text(verbatim: person.name).font(.system(size: 12.5, weight: .medium)).lineLimit(1)
                .frame(minWidth: 120, maxWidth: .infinity, alignment: .leading)
            labelMenu(person.label, tooltip: "The label of \(person.name)'s own channel in the transcript, when the source gives one") {
                form.draft.seats.remote[index].label = $0
            }
            TextField("Joined", text: clock(\.joins, index)).frame(width: 72)
                .instantTooltip("When \(person.name) joined; empty: at the start")
                .accessibilityIdentifier("meetings.seats.remote.join.\(index)")
            TextField("Left", text: clock(\.leaves, index)).frame(width: 72)
                .instantTooltip("When \(person.name) left; empty: at the end")
                .accessibilityIdentifier("meetings.seats.remote.leave.\(index)")
            IconButton(systemName: "minus.circle", tooltip: "Take \(person.name) off the remote seats") {
                form.draft.removeRemote(at: index)
            }
            .accessibilityIdentifier("meetings.seats.remote.remove.\(index)")
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

    private func microphone(_ index: Int, _ choices: FormState.Group) -> some View {
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
                labelMenu(group.label, tooltip: "The transcript label of this device's channel, when the source gives one") {
                    form.draft.seats.microphones?[index].label = $0
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
        case .room: form.draft.seatInRoom(name)
        case .remote: form.draft.seatRemote(name)
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

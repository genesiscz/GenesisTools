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
        case .other(_, let owner):
            return owner == nil && !groups[index].people.isEmpty && groups[index].people.allSatisfy { Self.contains(seats.room, $0) }
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
        let held = seats.microphones.flatMap { $0.indices.contains(index) ? $0[index].people : nil } ?? []
        return eligible + held.filter { !Self.contains(eligible, $0) }
    }

    /// The devices the group at `index` can switch to: this Mac and each remote person's device that no other group is.
    func devices(for index: Int) -> [(device: Device, free: Bool)] {
        let groups = seats.microphones ?? []
        let taken = Set(groups.indices.filter { $0 != index }.map { Device(groups[$0]) })
        let devices: [Device] = [.thisMac] + seats.remote.map { Device.owner($0.name) }
        return devices.map { ($0, !taken.contains($0)) }
    }

    /// The devices a new microphone can be: this Mac's while it has no group, and each remote person's own device
    /// that has none yet.
    var newDevices: [Device] {
        let taken = Set((seats.microphones ?? []).map(Device.init))
        let devices: [Device] = [.thisMac] + seats.remote.map { .owner($0.name) }
        return devices.filter { !taken.contains($0) }
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

    /// The first thing Save cannot write, in words; nil when the seats are whole.
    var problem: String? {
        for (index, person) in seats.remote.enumerated() {
            let join = PersonStay.Clock(joins.indices.contains(index) ? joins[index] : "")
            let leave = PersonStay.Clock(leaves.indices.contains(index) ? leaves[index] : "")
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
            seats.remote[index].fromSec = PersonStay.Clock(joins.indices.contains(index) ? joins[index] : "").value
            seats.remote[index].toSec = PersonStay.Clock(leaves.indices.contains(index) ? leaves[index] : "").value
        }
        if seats.microphones?.isEmpty == true { seats.microphones = nil }
        return seats
    }

    /// The engine compares names with case and accents folded (`nameKey`).
    static func same(_ a: String, _ b: String) -> Bool { PeopleText.fold(a) == PeopleText.fold(b) }

    static func contains(_ names: [String], _ name: String) -> Bool { names.contains { same($0, name) } }
}

/// "Seats and microphones…" from the meeting header's "…" menu: who sat in the room, who joined from elsewhere and
/// when, and which microphone carried whom. People come from the person picker the person editor uses (the meeting's
/// people first, or a new name), microphones from this Mac and the remote people's devices.
struct MeetingSeatsEditor: View {
    @State private var draft: MeetingSeatsDraft
    let save: (MeetingSeats) async throws -> Void
    let saved: () -> Void
    @State private var saving = false
    @State private var failure: MeetingsCLI.Failure?
    /// The seat kind whose person picker is open.
    @State private var adding: SeatKind?
    @State private var query = ""
    @State private var search: PeopleSearch?
    /// The transcript's labels, read once when the sheet opens and again when the speakers arrive.
    @State private var labels: [String] = []
    @Environment(\.meetingDetail) private var detail
    @Environment(\.dismiss) private var dismiss

    enum SeatKind: String, Identifiable {
        case room, remote
        var id: String { rawValue }
    }

    init(seats: MeetingSeats, save: @escaping (MeetingSeats) async throws -> Void, saved: @escaping () -> Void) {
        _draft = State(initialValue: MeetingSeatsDraft(seats))
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
            Form {
                Section {
                    room
                } header: {
                    Text("In the room")
                }
                Section {
                    ForEach(Array(draft.seats.remote.enumerated()), id: \.offset) { index, person in remote(index, person) }
                    addButton(.remote)
                } header: {
                    Text("Remote")
                } footer: {
                    Text("Times on the transcript clock, as 12:04 or 1:05:30. Empty: from the start, or to the end.")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                }
                Section {
                    ForEach(Array((draft.seats.microphones ?? []).enumerated()), id: \.offset) { index, group in
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
            // Edits made while the write is in flight would be dismissed with the sheet unsaved.
            .disabled(saving)
            if let problem = draft.problem {
                Text(problem).font(.system(size: 11.5)).foregroundStyle(KitHue.care.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("meetings.seats.problem")
            }
            if let failure {
                NoticePill(text: "Not saved: \(failure.sentence)", more: failure.detail, tone: .error)
            }
            HStack {
                Spacer()
                if saving { ProgressView().controlSize(.small) }
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Save") { submit() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(saving || draft.problem != nil)
                    .accessibilityIdentifier("meetings.seats.save")
            }
        }
        .padding(20)
        .frame(width: 620, height: 500)
        .onAppear {
            if let detail, case .idle = detail.speakers { detail.loadSpeakers() }
        }
        .onChange(of: detail?.speakers.value?.speakers.count, initial: true) { _, _ in labels = Self.labels(detail, draft.seats) }
        .onDisappear { search?.cancel() }
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
            if draft.seats.room.isEmpty {
                Text("Nobody yet.").font(.system(size: 12)).foregroundStyle(.secondary)
            } else {
                WrapLayout(spacing: 6, lineSpacing: 6) {
                    ForEach(draft.seats.room, id: \.self) { name in personChip(name) }
                }
            }
            addButton(.room)
        }
    }

    private func personChip(_ name: String) -> some View {
        HStack(spacing: 4) {
            Text(verbatim: name).font(.system(size: 12))
            IconButton(systemName: "xmark", tooltip: "Take \(name) out of the room", size: 9) {
                draft.unseat(name)
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
                draft.seats.remote[index].label = $0
            }
            TextField("Joined", text: clock(\.joins, index)).frame(width: 72)
                .instantTooltip("When \(person.name) joined; empty: at the start")
                .accessibilityIdentifier("meetings.seats.remote.join.\(index)")
            TextField("Left", text: clock(\.leaves, index)).frame(width: 72)
                .instantTooltip("When \(person.name) left; empty: at the end")
                .accessibilityIdentifier("meetings.seats.remote.leave.\(index)")
            IconButton(systemName: "minus.circle", tooltip: "Take \(person.name) off the remote seats") {
                draft.removeRemote(at: index)
            }
            .accessibilityIdentifier("meetings.seats.remote.remove.\(index)")
        }
        .textFieldStyle(.roundedBorder)
        .font(.system(size: 12))
    }

    /// "Label: Speaker 2 ▾": the transcript's labels and None, no typed label.
    private func labelMenu(_ current: String?, tooltip: String, set: @escaping (String?) -> Void) -> some View {
        MenuButton(style: .genHoverPlain(), items: {
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
        Binding(get: { draft[keyPath: list].indices.contains(index) ? draft[keyPath: list][index] : "" },
                set: { if draft[keyPath: list].indices.contains(index) { draft[keyPath: list][index] = $0 } })
    }

    // MARK: Microphones

    private func microphone(_ index: Int, _ group: MeetingSeats.Microphone) -> some View {
        let device = draft.device(at: index)
        let members = draft.members(index)
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
                    draft.seats.microphones?[index].label = $0
                }
                IconButton(systemName: "minus.circle", tooltip: "Remove \(device.title)") { draft.removeMicrophone(at: index) }
                    .accessibilityIdentifier("meetings.seats.mic.remove.\(index)")
            }
            if members.isEmpty {
                Text(draft.carriesRoom(index) ? "Seat people in the room first." : "Seat remote people first.")
                    .font(.system(size: 11.5)).foregroundStyle(.secondary)
            } else {
                WrapLayout(spacing: 12, lineSpacing: 4) {
                    ForEach(members, id: \.self) { name in
                        Toggle(name, isOn: Binding(get: { MeetingSeatsDraft.contains(group.people, name) },
                                                   set: { _ in draft.toggle(name, inMicrophone: index) }))
                            .toggleStyle(.checkbox).font(.system(size: 12))
                            .accessibilityIdentifier("meetings.seats.mic.\(index).member.\(name)")
                    }
                }
            }
        }
        .padding(.vertical, 2)
    }

    /// Runs at the click: this Mac and each remote person's device; one another group already is stays greyed.
    private func deviceItems(_ index: Int, current: MeetingSeatsDraft.Device) -> [MenuButtonItem] {
        var items = draft.devices(for: index).map { choice in
            MenuButtonItem.action(choice.device.title, checked: choice.device == current, enabled: choice.free) {
                draft.setDevice(choice.device, at: index)
            }
        }
        if case .other = current { items.insert(.action(current.title, checked: true) {}, at: 0) }
        return items
    }

    private var addMicrophone: some View {
        let devices = draft.newDevices
        return MenuButton(style: .genHoverPlain(), items: {
            devices.map { device in MenuButtonItem.action(device.title) { draft.addMicrophone(device) } }
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
        case .room: draft.seatInRoom(name)
        case .remote: draft.seatRemote(name)
        }
        labels = Self.labels(detail, draft.seats)
    }

    // MARK: Save

    /// The sheet stays open until the write lands: a refusal shows here and the draft stays to correct.
    private func submit() {
        guard !saving, draft.problem == nil else { return }
        saving = true
        failure = nil
        let submitted = draft
        let seats = submitted.parsed
        Task {
            do {
                try await save(seats)
                saving = false
                // Keep the sheet open when the draft changed after the snapshot: closing would drop those edits.
                if draft == submitted { saved() }
            } catch {
                saving = false
                failure = asFailure(error)
            }
        }
    }
}

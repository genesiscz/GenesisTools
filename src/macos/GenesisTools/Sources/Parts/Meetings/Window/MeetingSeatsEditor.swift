import SwiftUI

struct MeetingSeatsButton: View {
    @Bindable var detail: MeetingDetailModel
    @State private var editing = false
    var body: some View {
        Button("Seats and microphones…") { editing = true }
            .accessibilityIdentifier("meetings.detail.seats")
            .disabled(detail.record.value == nil)
            .sheet(isPresented: $editing) {
                MeetingSeatsEditor(seats: detail.record.value?.seats ?? MeetingSeats(),
                                   save: { try await detail.saveSeats($0) }, saved: { editing = false })
            }
    }
}

/// The comma lists of the editor as typed: a list is parsed on Save, so "Alice," keeps its comma while Bob is typed.
struct MeetingSeatsDraft: Equatable {
    var seats: MeetingSeats
    var room: String
    var members: [String]

    init(_ seats: MeetingSeats) {
        self.seats = seats
        room = seats.room.joined(separator: ", ")
        members = (seats.microphones ?? []).map { $0.people.joined(separator: ", ") }
    }

    mutating func addMicrophone() {
        seats.microphones = (seats.microphones ?? []) + [.init()]
        members.append("")
    }

    mutating func removeMicrophone(at index: Int) {
        seats.microphones?.remove(at: index)
        if members.indices.contains(index) { members.remove(at: index) }
    }

    /// The seats Save writes: each comma list split into its names.
    var parsed: MeetingSeats {
        var seats = seats
        seats.room = Self.names(room)
        if var groups = seats.microphones {
            for index in groups.indices { groups[index].people = Self.names(members.indices.contains(index) ? members[index] : "") }
            seats.microphones = groups
        }
        return seats
    }

    static func names(_ text: String) -> [String] {
        text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }
}

private struct MeetingSeatsEditor: View {
    @State private var draft: MeetingSeatsDraft
    let save: (MeetingSeats) async throws -> Void
    let saved: () -> Void
    @State private var saving = false
    @State private var failure: MeetingsCLI.Failure?
    @Environment(\.dismiss) private var dismiss

    init(seats: MeetingSeats, save: @escaping (MeetingSeats) async throws -> Void, saved: @escaping () -> Void) {
        _draft = State(initialValue: MeetingSeatsDraft(seats))
        self.save = save
        self.saved = saved
    }

    private func optional(_ binding: Binding<String?>) -> Binding<String> {
        Binding(get: { binding.wrappedValue ?? "" }, set: { binding.wrappedValue = $0.isEmpty ? nil : $0 })
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Seats and microphones").font(.headline)
            Text("Use confirmed seating facts. A remote label and join/leave times narrow channel attribution.").foregroundStyle(.secondary)
            ScrollView {
                Form {
                    Section("At the room microphone") {
                        TextField("People, separated by commas", text: $draft.room)
                    }
                    Section("Remote people") {
                        ForEach(draft.seats.remote.indices, id: \.self) { index in
                            HStack {
                                TextField("Name", text: $draft.seats.remote[index].name)
                                TextField("Own transcript label", text: optional($draft.seats.remote[index].label))
                                TextField("Join seconds", value: $draft.seats.remote[index].fromSec, format: .number).frame(width: 90)
                                TextField("Leave seconds", value: $draft.seats.remote[index].toSec, format: .number).frame(width: 90)
                                Button("Remove") { draft.seats.remote.remove(at: index) }
                            }
                        }
                        Button("Add remote person") { draft.seats.remote.append(.init()) }
                    }
                    Section("Shared devices") {
                        ForEach((draft.seats.microphones ?? []).indices, id: \.self) { index in microphone(index) }
                        Button("Add microphone group") { draft.addMicrophone() }
                        Text("ID self denotes your microphone. Device owner identifies whose device carries the group. Members must all be room people or all remote people.").font(.caption).foregroundStyle(.secondary)
                    }
                }
                // Edits made while the write is in flight would be dismissed with the sheet unsaved.
                .disabled(saving)
            }
            if let failure {
                NoticePill(text: "Not saved: \(failure.sentence)", more: failure.detail, tone: .error)
            }
            HStack {
                Spacer()
                if saving { ProgressView().controlSize(.small) }
                Button("Cancel") { dismiss() }
                Button("Save") { submit() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(saving)
            }
        }.padding(20).frame(width: 780, height: 480)
    }

    /// The sheet stays open until the write lands: a refusal shows here and the draft stays to correct.
    private func submit() {
        guard !saving else { return }
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

    @ViewBuilder private func microphone(_ index: Int) -> some View {
        if let groups = draft.seats.microphones, groups.indices.contains(index) {
            let group = Binding<MeetingSeats.Microphone>(get: { draft.seats.microphones?[index] ?? .init() },
                                                        set: { draft.seats.microphones?[index] = $0 })
            let members = Binding<String>(get: { draft.members.indices.contains(index) ? draft.members[index] : "" },
                                          set: { if draft.members.indices.contains(index) { draft.members[index] = $0 } })
            HStack {
                TextField("ID", text: group.id).frame(width: 70)
                TextField("Label", text: optional(group.label))
                TextField("Device owner", text: optional(group.deviceId))
                TextField("Members, comma separated", text: members)
                Button("Remove") { draft.removeMicrophone(at: index) }
            }
        }
    }
}

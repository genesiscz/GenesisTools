import SwiftUI

struct MeetingSeatsButton: View {
    @Bindable var detail: MeetingDetailModel
    @State private var editing = false
    var body: some View {
        Button("Seats and microphones…") { editing = true }
            .accessibilityIdentifier("meetings.detail.seats")
            .disabled(detail.record.value == nil)
            .sheet(isPresented: $editing) {
                MeetingSeatsEditor(seats: detail.record.value?.seats ?? MeetingSeats()) { detail.setSeats($0); editing = false }
            }
    }
}

private struct MeetingSeatsEditor: View {
    @State var seats: MeetingSeats
    let save: (MeetingSeats) -> Void
    @Environment(\.dismiss) private var dismiss
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
                        TextField("People, separated by commas", text: Binding(get: { seats.room.joined(separator: ", ") }, set: { seats.room = names($0) }))
                    }
                    Section("Remote people") {
                        ForEach(seats.remote.indices, id: \.self) { index in
                            HStack {
                                TextField("Name", text: $seats.remote[index].name)
                                TextField("Own transcript label", text: optional($seats.remote[index].label))
                                TextField("Join seconds", value: $seats.remote[index].fromSec, format: .number).frame(width: 90)
                                TextField("Leave seconds", value: $seats.remote[index].toSec, format: .number).frame(width: 90)
                                Button("Remove") { seats.remote.remove(at: index) }
                            }
                        }
                        Button("Add remote person") { seats.remote.append(.init()) }
                    }
                    Section("Shared devices") {
                        ForEach((seats.microphones ?? []).indices, id: \.self) { index in microphone(index) }
                        Button("Add microphone group") { seats.microphones = (seats.microphones ?? []) + [.init()] }
                        Text("ID self denotes your microphone. Device owner identifies whose device carries the group. Members must all be room people or all remote people.").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            HStack { Spacer(); Button("Cancel") { dismiss() }; Button("Save") { save(seats) }.keyboardShortcut(.defaultAction) }
        }.padding(20).frame(width: 780, height: 480)
    }
    @ViewBuilder private func microphone(_ index: Int) -> some View {
        if let groups = seats.microphones, groups.indices.contains(index) {
            let group = Binding<MeetingSeats.Microphone>(get: { seats.microphones?[index] ?? .init() }, set: { seats.microphones?[index] = $0 })
            HStack {
                TextField("ID", text: group.id).frame(width: 70)
                TextField("Label", text: optional(group.label))
                TextField("Device owner", text: optional(group.deviceId))
                TextField("Members, comma separated", text: Binding(get: { group.wrappedValue.people.joined(separator: ", ") }, set: { group.wrappedValue.people = names($0) }))
                Button("Remove") { seats.microphones?.remove(at: index) }
            }
        }
    }
    private func names(_ text: String) -> [String] { text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }
}

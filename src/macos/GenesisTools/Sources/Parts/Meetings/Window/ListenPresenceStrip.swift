import SwiftUI

/// Roster windows and observed indicator intervals. Empty portions retain unknown coverage.
struct ListenPresenceStrip: View {
    @Bindable var detail: MeetingDetailModel
    let duration: Double
    @State private var selected: String?
    @State private var from = ""
    @State private var to = ""
    @State private var failure: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(detail.record.value?.participants ?? [], id: \.name) { person in
                let start = person.stays?.first?.fromSec ?? person.firstSeenSec ?? 0
                let end = person.stays?.last?.toSec ?? duration
                HStack(spacing: 6) {
                    Button(person.name) {
                        selected = person.name
                        from = String(start)
                        to = String(end)
                    }.buttonStyle(.borderless).frame(width: 140, alignment: .leading)
                    Text(person.stays?.last?.source ?? person.from?.first ?? "unknown").foregroundStyle(.secondary).frame(width: 90)
                    GeometryReader { geometry in
                        let scale = geometry.size.width / max(1, duration)
                        ZStack(alignment: .leading) {
                            Capsule().fill(Color.secondary.opacity(0.2)).frame(width: max(1, (end - start) * scale), height: 4).offset(x: start * scale)
                            ForEach(Array((detail.record.value?.evidence?.indicator ?? []).enumerated()), id: \.offset) { _, read in
                                if read.speakingUnknown != true && read.speaking.contains(person.name) {
                                    Rectangle().fill(Color.green).frame(width: max(1, ((read.validUntilSec ?? read.tSec) - read.tSec) * scale), height: 8).offset(x: read.tSec * scale)
                                }
                                if read.muted?.contains(person.name) == true {
                                    Rectangle().fill(Color.orange.opacity(0.6)).frame(width: max(1, ((read.validUntilSec ?? read.tSec) - read.tSec) * scale), height: 3).offset(x: read.tSec * scale)
                                }
                            }
                        }
                        .accessibilityLabel("\(person.name): \(start) to \(end) seconds. Green shows observed speaking; orange shows muted reads; gaps are unknown.")
                        .contentShape(Rectangle())
                        .gesture(DragGesture(minimumDistance: 3).onEnded { drag in
                            selected = person.name
                            from = String(start)
                            to = String(max(start, min(duration, Double(drag.location.x / geometry.size.width) * duration)))
                        })
                    }.frame(height: 10)
                }.font(.caption)
            }
        }.padding(.horizontal, 8)
        .sheet(isPresented: Binding(get: { selected != nil }, set: { if !$0 { selected = nil } })) {
            VStack(alignment: .leading, spacing: 8) {
                Text(selected ?? "")
                TextField("Join, seconds", text: $from)
                TextField("Leave, seconds", text: $to)
                if let failure { Text(failure).foregroundStyle(.red) }
                HStack {
                    Button("Cancel") { selected = nil }
                    Button("Save window") {
                        guard let name = selected, let start = Double(from), let end = Double(to), start >= 0, end >= start else { failure = "Enter a valid join and leave time"; return }
                        Task {
                            do {
                                let atMic = detail.record.value?.seats?.room.contains(name)
                                try await detail.editMeetingPerson(.init(meeting: detail.id, name: name, action: "add", fromSec: start, toSec: end, atMic: atMic))
                                selected = nil
                            } catch { failure = error.localizedDescription }
                        }
                    }
                }
            }.padding().frame(width: 360)
        }
    }
}

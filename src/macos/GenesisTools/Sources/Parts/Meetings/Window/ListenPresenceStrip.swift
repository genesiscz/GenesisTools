import SwiftUI

/// Roster windows and observed indicator intervals. Empty portions retain unknown coverage. A row's join and leave
/// handles show while the pointer is on it (window audit M6); a drag saves at the release with an Undo, and a click on
/// the name opens the editor with the times as clock text.
struct ListenPresenceStrip: View {
    @Bindable var detail: MeetingDetailModel
    let duration: Double
    @State private var groups: [PresenceGroup] = []
    @State private var selected: MeetingRecordView.Person?
    @State private var from = ""
    @State private var to = ""
    @State private var failure: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(groups) { group in
                Text(group.title).font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
                ForEach(group.people) { row in
                    PresencePersonRow(row: row, duration: duration, edit: { range in
                        selected = row.person; failure = nil
                        from = Self.clock(range.lowerBound); to = Self.clock(range.upperBound)
                    }, save: { range in save(row.person, range) })
                }
            }
        }.padding(.horizontal, 8)
        .onChange(of: detail.record.value, initial: true) { _, record in groups = PresenceGroup.make(record) }
        .sheet(isPresented: Binding(get: { selected != nil }, set: { if !$0 { selected = nil } })) {
            VStack(alignment: .leading, spacing: 8) {
                Text(selected?.name ?? "")
                if let count = selected?.stays?.count, count > 1 {
                    Text("Saving replaces their \(count) stays with this one window, from the join to the leave.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                TextField("Join (mm:ss or hh:mm:ss)", text: $from)
                TextField("Leave (mm:ss or hh:mm:ss)", text: $to)
                if let failure { Text(failure).foregroundStyle(.red) }
                HStack {
                    Button("Cancel") { selected = nil }.keyboardShortcut(.cancelAction)
                    Button("Save window") {
                        guard let person = selected, let range = Self.window(from: from, to: to, duration: duration) else {
                            failure = "Enter a join and leave within the meeting, as mm:ss or hh:mm:ss."; return
                        }
                        Task {
                            do {
                                let group = detail.record.value?.seats?.microphones?.first { $0.people.contains(person.name) }
                                let atMic = group?.id == "self" || detail.record.value?.seats?.room.contains(person.name) == true
                                try await detail.editMeetingPerson(.init(meeting: detail.id, name: person.name, action: "add", fromSec: range.lowerBound, toSec: range.upperBound, atMic: atMic, via: group?.id == "self" ? nil : group?.deviceId))
                                selected = nil
                            } catch { failure = asFailure(error).sentence }
                        }
                    }.keyboardShortcut(.defaultAction)
                }.buttonStyle(.genHoverPlain())
            }.padding().frame(width: 360)
        }
    }

    /// A dragged join or leave saves at once, with an Undo that puts the old window back. A person with several stays
    /// opens the editor instead, since saving replaces them all with one window and an Undo could not bring them back.
    private func save(_ person: MeetingRecordView.Person, _ range: ClosedRange<Double>) {
        guard (person.stays?.count ?? 0) == 1, let old = Self.spans(person, duration: duration).first else {
            selected = person; failure = nil
            from = Self.clock(range.lowerBound); to = Self.clock(range.upperBound)
            return
        }
        Task {
            do {
                try await write(person, range)
                let text = "\(person.name): \(MeetingsFormat.clock(range.lowerBound)) to \(MeetingsFormat.clock(range.upperBound))"
                detail.notices.push(StackedNotice(text: text, actions: [.undo { _ in
                    Task {
                        do { try await write(person, old) } catch { detail.notices.push(.meetingsFailure(error)) }
                    }
                }]))
            } catch {
                detail.notices.push(.meetingsFailure(error, retry: { save(person, range) }))
            }
        }
    }

    private func write(_ person: MeetingRecordView.Person, _ range: ClosedRange<Double>) async throws {
        let group = detail.record.value?.seats?.microphones?.first { $0.people.contains(person.name) }
        let atMic = group?.id == "self" || detail.record.value?.seats?.room.contains(person.name) == true
        try await detail.editMeetingPerson(.init(meeting: detail.id, name: person.name, action: "add", fromSec: range.lowerBound,
                                                 toSec: range.upperBound, atMic: atMic, via: group?.id == "self" ? nil : group?.deviceId))
    }

    static func clock(_ sec: Double) -> String {
        let fraction = sec.truncatingRemainder(dividingBy: 1)
        return MeetingsFormat.clock(sec) + (fraction > 0 ? String(String(fraction).dropFirst()) : "")
    }

    static func window(from: String, to: String, duration: Double) -> ClosedRange<Double>? {
        func seconds(_ text: String) -> Double? {
            let parts = text.trimmingCharacters(in: .whitespaces).split(separator: ":", omittingEmptySubsequences: false)
            guard (1...3).contains(parts.count) else { return nil }
            var result = 0.0
            for (index, part) in parts.enumerated() {
                guard let n = Double(part), n.isFinite, n >= 0, index == 0 || n < 60 else { return nil }
                result = result * 60 + n
            }
            return result
        }
        guard let start = seconds(from), let end = seconds(to), start <= end, end <= duration else { return nil }
        return start...end
    }

    static func spans(_ person: MeetingRecordView.Person, duration: Double) -> [ClosedRange<Double>] {
        let stays = (person.stays ?? []).map { stay in stay.fromSec...max(stay.fromSec, stay.toSec ?? duration) }
        return stays.isEmpty ? [(person.firstSeenSec ?? 0)...max(person.firstSeenSec ?? 0, duration)] : stays
    }

    /// How a join or a leave was found, in words: the engine sends a code ("platform-roster", "hand").
    static func sourceWords(_ source: String?) -> String {
        switch source {
        case "attendance", "platform-roster": return "from the call's attendee list"
        case "indicator": return "from the speaking indicator"
        case "greeting": return "said hello"
        case "goodbye": return "said goodbye"
        case "hand": return "set by hand"
        case "sole-remote": return "the only remote person"
        case "voice": return "heard by voice"
        case "phone": return "on the phone"
        case "silence": return "after a silence"
        default: return "source not known"
        }
    }

    static func sourceSymbol(_ source: String?) -> String {
        switch source {
        case "attendance", "platform-roster": return "person.crop.rectangle"
        case "indicator": return "waveform"
        case "greeting", "goodbye": return "hand.wave"
        case "hand": return "hand.draw"
        case "sole-remote": return "person.fill"
        case "voice": return "waveform.circle"
        case "phone": return "phone"
        case "silence": return "speaker.slash"
        default: return "questionmark.circle"
        }
    }
}

struct PresencePersonRow: View {
    let row: PresenceGroup.Person
    let duration: Double
    var edit: (ClosedRange<Double>) -> Void
    /// A drag's release; nil opens the editor as a click on the name does.
    var save: ((ClosedRange<Double>) -> Void)? = nil
    @State private var draft: ClosedRange<Double>?
    @State private var dragStart: ClosedRange<Double>?
    @State private var spans: [ClosedRange<Double>] = []
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 6) {
            LiveButton(tooltip: "Edit \(row.person.name)'s join and leave", pressable: true, action: { edit(window) }) {
                Text(row.person.name).lineLimit(1)
            }
            .frame(width: 130, alignment: .leading)
            GeometryReader { geometry in
                let scale = geometry.size.width / max(1, duration)
                ZStack(alignment: .leading) {
                    ForEach(Array(spans.enumerated()), id: \.offset) { index, span in
                        if draft == nil || index == 0 {
                        let shown = draft ?? span
                        Capsule().fill(Color.secondary.opacity(0.3))
                            .frame(width: max(1, (shown.upperBound - shown.lowerBound) * scale), height: 4).offset(x: shown.lowerBound * scale)
                        Image(systemName: ListenPresenceStrip.sourceSymbol(stay(index)?.source ?? row.person.from?.first))
                            .offset(x: max(0, shown.lowerBound * scale - 5))
                            .instantTooltip("Joined at \(MeetingsFormat.clock(shown.lowerBound)): \(ListenPresenceStrip.sourceWords(stay(index)?.source ?? row.person.from?.first))")
                        Image(systemName: ListenPresenceStrip.sourceSymbol(stay(index)?.leaveSource))
                            .offset(x: min(geometry.size.width - 10, shown.upperBound * scale - 5))
                            .instantTooltip("Left at \(MeetingsFormat.clock(shown.upperBound)): \(ListenPresenceStrip.sourceWords(stay(index)?.leaveSource))")
                        }
                    }
                    ForEach(Array(row.reads.enumerated()), id: \.offset) { _, read in
                        if read.speakingUnknown != true && read.speaking.contains(row.id) {
                            Rectangle().fill(KitHue.play.ink).frame(width: max(1, ((read.validUntilSec ?? read.tSec) - read.tSec) * scale), height: 3).offset(x: read.tSec * scale)
                        }
                        if read.muted?.contains(row.id) == true {
                            Rectangle().fill(KitHue.care.ink).frame(width: max(1, ((read.validUntilSec ?? read.tSec) - read.tSec) * scale), height: 2).offset(x: read.tSec * scale, y: 5)
                        }
                    }
                    if hovering || draft != nil {
                        handle(join: true, scale: scale)
                        handle(join: false, scale: scale)
                    }
                }
            }.frame(height: 22).accessibilityLabel("\(row.id), join \(MeetingsFormat.clock(window.lowerBound)), leave \(MeetingsFormat.clock(window.upperBound)). Blue shows observed speaking; orange shows muted reads; gaps are unknown.")
        }
        .font(.system(size: 11))
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .liveRow(selected: draft != nil || hovering)
        .onChange(of: row.person, initial: true) { _, person in spans = ListenPresenceStrip.spans(person, duration: duration); draft = nil }
        .onChange(of: duration) { _, _ in spans = ListenPresenceStrip.spans(row.person, duration: duration) }
    }
    private var window: ClosedRange<Double> { draft ?? (spans.first?.lowerBound ?? 0)...(spans.last?.upperBound ?? duration) }
    private func stay(_ index: Int) -> MeetingRecordView.Person.Stay? {
        guard let stays = row.person.stays, stays.indices.contains(index) else { return nil }; return stays[index]
    }
    /// A 7 by 16 pt grip in a 22 by 22 pt target (checklist Hit targets), shown on the hovered row only.
    private func handle(join: Bool, scale: Double) -> some View {
        RoundedRectangle(cornerRadius: 2).fill(KitHue.play.ink.opacity(0.85)).frame(width: 7, height: 16)
            .frame(width: 22, height: 22)
            .contentShape(Rectangle()).offset(x: (join ? window.lowerBound : window.upperBound) * scale - 11)
            .instantTooltip("Drag to move the \(join ? "join" : "leave"): \(MeetingsFormat.clock(join ? window.lowerBound : window.upperBound)). It saves when you let go, with an Undo")
            .accessibilityLabel("\(join ? "Join" : "Leave") handle")
            .gesture(DragGesture(minimumDistance: 2).onChanged { drag in
                if dragStart == nil { dragStart = window }
                let base = dragStart ?? window
                draft = Self.dragged(base, join: join, delta: drag.translation.width / max(0.001, scale), duration: duration)
            }.onEnded { _ in
                let released = window
                dragStart = nil
                // A save keeps the dragged window drawn until the record comes back with it (`onChange(of: row.person)`
                // clears the draft), so the bar does not jump back for the length of the write.
                if let save { save(released) } else { draft = nil; edit(released) }
            })
    }
    static func dragged(_ range: ClosedRange<Double>, join: Bool, delta: Double, duration: Double) -> ClosedRange<Double> {
        join ? min(range.upperBound, max(0, range.lowerBound + delta))...range.upperBound
            : range.lowerBound...max(range.lowerBound, min(duration, range.upperBound + delta))
    }
}

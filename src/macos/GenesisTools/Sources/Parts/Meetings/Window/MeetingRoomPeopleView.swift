import SwiftUI

struct MeetingRoomPeopleView: View {
    @Bindable var detail: MeetingDetailModel
    @State private var name = ""
    @State private var from = "0"
    @State private var to = ""
    @State private var atMic = true
    @State private var owner = ""
    @State private var failure: String?
    @State private var voiceStatus: String?
    @State private var busy = false
    @State private var voice: [MeetingsAPI.Voice.Line] = []
    @State private var count = 3
    @State private var channel = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let source = detail.record.value?.copySource {
                Text("Copy of \(source)").font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
            ForEach((detail.record.value?.items ?? []).filter { $0.departureText != nil }) { item in
                Text(item.departureText ?? "").font(.caption).foregroundStyle(.secondary)
            }
            ForEach(detail.suggestionWarnings, id: \.self) { warning in
                HStack {
                    Text(verbatim: warning).font(.caption).foregroundStyle(.orange)
                    Button("Add people by hand") { edit("") }
                }
            }
            ScrollView(.horizontal) {
                HStack {
                    ForEach(detail.record.value?.participants ?? [], id: \.name) { person in
                        Button(person.name) { edit(person.name) }.buttonStyle(.borderless)
                    }
                    Button("Add person", systemImage: "person.badge.plus") { edit("") }
                        .accessibilityIdentifier("meetings.people.add")
                    Stepper("\(count) voices", value: $count, in: 1...16).fixedSize()
                    Picker("Channel", selection: $channel) { Text("Left").tag(0); Text("Right").tag(1) }.fixedSize()
                    Button("Voice features") { readVoice() }.disabled(busy)
                    Button("Enrol remote voices") {
                        Task {
                            busy = true
                            defer { busy = false }
                            do {
                                let result = try await detail.enrolListenVoices()
                                voiceStatus = "\(result.matched) matched, \(result.unknown) unknown, \(result.samples) enrolment samples"
                            } catch { failure = error.localizedDescription }
                        }
                    }.disabled(busy)
                }.font(.caption)
            }
            ForEach(detail.record.value?.seats?.microphones ?? [], id: \.id) { group in
                Text("\(group.id == "self" ? "At microphone" : "Via " + (group.deviceId ?? group.id)): \(group.people.joined(separator: ", "))")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let failure { Text(failure).font(.caption).foregroundStyle(.red) }
            if let voiceStatus { Text(voiceStatus).font(.caption).foregroundStyle(.secondary) }
            if !voice.isEmpty {
                DisclosureGroup("Voice features, \(voice.count) lines, raw physical channels") {
                    ScrollView {
                        LazyVStack(alignment: .leading) {
                            ForEach(voice, id: \.index) { line in
                                Text(voiceText(line)).font(.caption.monospaced()).textSelection(.enabled)
                            }
                        }
                    }.frame(maxHeight: 180)
                }
            }
        }.padding(.horizontal, 16)
        .sheet(isPresented: $detail.showingMeetingPeopleEditor) { editor }
    }

    private func voiceText(_ line: MeetingsAPI.Voice.Line) -> String {
        let values = line.channels.enumerated().map { i, c in
            let pitch = c.pitchHz.map { String(Int($0)) + " Hz" } ?? "unvoiced"
            return "\(i == 0 ? "L" : "R") RMS \(c.rms.formatted(.number.precision(.fractionLength(3)))), low \(c.lowBandShare.formatted(.percent)), tilt \(c.tilt.formatted(.number.precision(.fractionLength(2)))), pitch \(pitch)"
        }.joined(separator: " | ")
        let cluster = line.cluster.map { " | voice \($0.id + 1), \($0.speaker ?? "unnamed"), \(Int($0.confidence * 100))%" } ?? ""
        return "Line \(line.index + 1): " + values + cluster
    }

    private func edit(_ person: String) {
        name = person
        let stay = detail.record.value?.attendance?.people.first { $0.name == person }
        let participant = detail.record.value?.participants?.first { $0.name == person }
        from = String(stay?.fromSec ?? participant?.stays?.first?.fromSec ?? participant?.firstSeenSec ?? 0)
        to = (stay?.toSec ?? participant?.stays?.last?.toSec).map { String($0) } ?? ""
        let group = detail.record.value?.seats?.microphones?.first { $0.people.contains(person) }
        atMic = group?.id == "self" || person.isEmpty
        owner = group?.deviceId ?? ""
        failure = nil
        detail.showingMeetingPeopleEditor = true
    }

    private var editor: some View {
        Form {
            TextField("Person name", text: $name)
            TextField("From, transcript seconds", text: $from)
            TextField("To, blank uses meeting end", text: $to)
            Toggle("At own microphone", isOn: $atMic)
            if !atMic { TextField("Device owner, blank for own device", text: $owner) }
            if let failure { Text(failure).foregroundStyle(.red) }
            HStack {
                Button("Cancel") { detail.showingMeetingPeopleEditor = false }.keyboardShortcut(.cancelAction)
                Button("Remove person", role: .destructive) { save(remove: true) }.disabled(busy || name.isEmpty)
                Button("Save") { save(remove: false) }.disabled(busy || name.isEmpty).keyboardShortcut(.defaultAction)
            }
        }.formStyle(.grouped).padding().frame(width: 460)
    }

    private func save(remove: Bool) {
        guard remove || (Double(from) != nil && (to.isEmpty || Double(to) != nil)) else {
            failure = "Use transcript seconds for join and leave times."; return
        }
        busy = true; failure = nil
        Task {
            defer { busy = false }
            do {
                try await detail.editMeetingPerson(.init(meeting: detail.id, name: name, action: remove ? "remove" : "add",
                    fromSec: Double(from), toSec: Double(to), atMic: atMic, via: !atMic && !owner.isEmpty ? owner : nil))
                detail.showingMeetingPeopleEditor = false
            } catch { failure = error.localizedDescription }
        }
    }

    private func readVoice() {
        busy = true; failure = nil
        Task {
            defer { busy = false }
            do {
                guard let service = detail.service else { throw NSError(domain: "Meetings", code: 1, userInfo: [NSLocalizedDescriptionKey: "Start the Meetings service to measure voice features."]) }
                voice = try await service.call(MeetingsAPI.Voice.self, .init(meeting: detail.id, voices: count, channel: channel), timeout: 190)
            } catch { failure = error.localizedDescription }
        }
    }
}

import SwiftUI

/// The meeting's people as one chip of the header's chip line (H1 of the 2026-11-18 window audit): "4 people", a menu
/// that edits each one or adds someone, and the attendance warnings in its hue and tooltip. Before, the names, a voice
/// count, a channel picker and two voice buttons stood in a strip of their own under the header and were cut at the
/// window's right edge; the voice tools are a sheet of the header's "…" menu now (`MeetingVoiceToolsSheet`), and who
/// was there when is the transcript's "Who was there" strip.
struct MeetingPeopleChip: View {
    @Bindable var detail: MeetingDetailModel
    @State private var name = ""
    @State private var from = "0"
    @State private var to = ""
    @State private var atMic = true
    @State private var owner = ""
    @State private var failure: String?
    @State private var busy = false
    @State private var warnings: [String] = []

    var body: some View {
        let people = detail.record.value?.participants ?? []
        MenuButton(style: .genHoverPlain(), items: { menu(people.map(\.name)) }) {
            MeetingDetailView.pickerLabel(symbol: warnings.isEmpty ? "person.2" : "person.fill.questionmark",
                                          text: people.isEmpty ? "No people" : Plural.count(people.count, "person", "people"),
                                          warn: !warnings.isEmpty)
        }
        .disabled(detail.record.value == nil)
        .instantTooltip(warnings.isEmpty ? "Who took part: edit someone's join and leave, or add a person"
                                         : warnings.joined(separator: " ") + " Add or edit the people here.")
        .accessibilityLabel(warnings.isEmpty ? "People, \(people.count)" : "People, \(people.count), needs a check")
        .accessibilityIdentifier("meetings.people.add")
        .task { if case .idle = detail.rows { detail.loadRows() } }
        .onChange(of: detail.rows.value?.attendanceWarning, initial: true) { _, _ in updateWarnings() }
        .onChange(of: detail.suggestionWarnings, initial: true) { _, _ in updateWarnings() }
        .sheet(isPresented: $detail.showingMeetingPeopleEditor) { editor }
    }

    /// Built at the click (`MenuButton`), so the body never walks the people.
    private func menu(_ names: [String]) -> [MenuButtonItem] {
        var items: [MenuButtonItem] = warnings.map { .note($0) }
        if !warnings.isEmpty { items.append(.divider) }
        items += names.map { person in .action("\(person)…") { edit(person) } }
        if !names.isEmpty { items.append(.divider) }
        items.append(.action("Add a person…") { edit("") })
        return items
    }

    private func updateWarnings() {
        warnings = Self.peopleWarnings(attendance: detail.rows.value?.attendanceWarning, suggested: detail.suggestionWarnings)
    }
    static func peopleWarnings(attendance: String?, suggested: [String]) -> [String] {
        Array(Set(suggested + (attendance.map { [$0] } ?? []))).sorted()
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
            } catch { failure = asFailure(error).sentence }
        }
    }
}

/// "Voice tools…" of the header's "…" menu: the voice features of the sound per line, and the enrolment of the remote
/// voices. They are tools for checking the voice pass, so they open on demand instead of standing in every meeting's
/// header. A failure stays here with its sentence, Retry and Details.
struct MeetingVoiceToolsSheet: View {
    @Bindable var detail: MeetingDetailModel
    let close: () -> Void
    @State private var count = 3
    @State private var channel = 0
    @State private var running: Job?
    @State private var failure: (job: Job, error: MeetingsCLI.Failure)?
    @State private var enrolled: String?
    @State private var voice: [MeetingsAPI.Voice.Line] = []
    @State private var linesOpen = false
    @State private var evidenceOpen: Bool

    enum Job: Equatable { case measure, enrol }

    /// `evidenceOpen`: Details starts open (a snapshot of it).
    init(detail: MeetingDetailModel, evidenceOpen: Bool = false, close: @escaping () -> Void) {
        self.detail = detail
        self.close = close
        _evidenceOpen = State(initialValue: evidenceOpen)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Voice tools").font(.headline)
                Text("Check what the voice pass hears in this meeting's sound.")
                    .font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            section(.measure, title: "Voice features",
                    text: "Splits one channel of the sound into voices and measures each line: loudness, low band, tilt and pitch.") {
                KitNumberField("Voices to split", value: $count, in: 1...16, suffix: .counted("voice"), size: .small,
                               identifier: "meetings.voice.count")
                MenuButton(style: .genHoverPlain(), items: {
                    [.action("Left channel", checked: channel == 0) { channel = 0 },
                     .action("Right channel", checked: channel == 1) { channel = 1 }]
                }) {
                    MeetingDetailView.pickerLabel(symbol: "speaker.wave.2", text: channel == 0 ? "Left channel" : "Right channel", warn: false)
                }
                .instantTooltip("The channel of the sound to measure")
                .accessibilityLabel("Channel, \(channel == 0 ? "left" : "right")")
            } result: {
                if !voice.isEmpty {
                    GenDisclosure(isExpanded: $linesOpen, minHeight: 22, identifier: "meetings.voice.lines") {
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 2) {
                                ForEach(voice, id: \.index) { line in
                                    Text(verbatim: Self.voiceText(line)).font(.system(size: 11, design: .monospaced)).textSelection(.enabled)
                                }
                            }
                        }
                        .frame(maxHeight: 180)
                    } label: {
                        Text(verbatim: "Measured \(Plural.count(voice.count, "line"))").font(.system(size: 12))
                    }
                }
            }
            Divider()
            section(.enrol, title: "Remote voices",
                    text: "Matches the remote voices to the people's saved voice samples and keeps the new samples.") {
                EmptyView()
            } result: {
                if let enrolled { Text(verbatim: enrolled).font(.system(size: 12)).foregroundStyle(.secondary) }
            }
            if let evidence = detail.speakers.value?.evidence {
                Divider()
                evidenceDetails(evidence)
            }
            HStack {
                Spacer()
                Button("Done", action: close).keyboardShortcut(.defaultAction)
            }
        }
        .padding(16)
        .frame(width: 460)
        // The evidence facts come with the speakers; the sheet opens from any tab.
        .onAppear { if case .idle = detail.speakers { detail.loadSpeakers() } }
    }

    /// The engine's evidence facts as it logs them (was a disclosure above the Speakers tab's lanes, audit L3).
    private func evidenceDetails(_ evidence: MeetingsAPI.MeetingSpeakers.Evidence) -> some View {
        GenDisclosure(isExpanded: $evidenceOpen, minHeight: 22, identifier: "meetings.speakers.evidence") {
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(evidence.summary.enumerated()), id: \.offset) { _, text in
                        Text(verbatim: text).font(.system(size: 12)).textSelection(.enabled)
                    }
                    Text(verbatim: evidence.lines).font(.system(size: 11, design: .monospaced)).textSelection(.enabled)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 220)
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text("Details").font(.system(size: 13, weight: .semibold))
                Text("The facts the engine read about the speakers, as it logs them.")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
            }
        }
    }

    private func section<Controls: View, Result: View>(_ job: Job, title: String, text: String,
                                                      @ViewBuilder controls: () -> Controls,
                                                      @ViewBuilder result: () -> Result) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.system(size: 13, weight: .semibold))
            Text(text).font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 10) {
                controls()
                Spacer(minLength: 8)
                if running == job { ProgressView().controlSize(.small) }
                GhostButton(job == .measure ? (running == job ? "Measuring…" : "Measure") : (running == job ? "Enrolling…" : "Enrol"),
                            symbol: job == .measure ? "waveform" : "person.wave.2",
                            tooltip: job == .measure ? "Measure the voice features of every line" : "Enrol the remote voices of this meeting",
                            identifier: job == .measure ? "meetings.voice.measure" : "meetings.voice.enrol") { run(job) }
                    .disabled(running != nil)
            }
            if failure?.job == job, let error = failure?.error {
                NoticePill(text: error.sentence, more: error.detail, tone: .error,
                           fixes: [.button("Retry", symbol: "arrow.clockwise") { run(job) }, error.detailsFix { run(job) }],
                           dismiss: { failure = nil })
            }
            result()
        }
    }

    private func run(_ job: Job) {
        guard running == nil else { return }
        running = job
        failure = nil
        Task {
            defer { running = nil }
            do {
                switch job {
                case .measure:
                    guard let service = detail.service else {
                        throw MeetingsCLI.Failure(sentence: "Start the Meetings service to measure voice features.", detail: "No Meetings service answers this window.")
                    }
                    voice = try await service.call(MeetingsAPI.Voice.self, .init(meeting: detail.id, voices: count, channel: channel), timeout: 190)
                    linesOpen = true
                case .enrol:
                    let result = try await detail.enrolListenVoices()
                    enrolled = "\(result.matched) matched, \(result.unknown) unknown, \(Plural.count(result.samples, "sample")) kept"
                }
            } catch {
                failure = (job, asFailure(error))
            }
        }
    }

    static func voiceText(_ line: MeetingsAPI.Voice.Line) -> String {
        let values = line.channels.enumerated().map { i, c in
            let pitch = c.pitchHz.map { String(Int($0)) + " Hz" } ?? "unvoiced"
            return "\(i == 0 ? "L" : "R") RMS \(c.rms.formatted(.number.precision(.fractionLength(3)))), low \(c.lowBandShare.formatted(.percent)), tilt \(c.tilt.formatted(.number.precision(.fractionLength(2)))), pitch \(pitch)"
        }.joined(separator: " | ")
        let cluster = line.cluster.map { " | voice \($0.id + 1), \($0.speaker ?? "unnamed"), \(Int($0.confidence * 100))%" } ?? ""
        return "Line \(line.index + 1): " + values + cluster
    }
}

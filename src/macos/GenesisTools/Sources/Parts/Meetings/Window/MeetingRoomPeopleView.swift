import SwiftUI

/// The meeting's people as one chip of the header's chip line (H1 of the 2026-11-18 window audit): "4 people", a menu
/// that edits each one or adds someone, and the attendance warnings in its hue and tooltip. Before, the names, a voice
/// count, a channel picker and two voice buttons stood in a strip of their own under the header and were cut at the
/// window's right edge; the voice tools are a sheet of the header's "…" menu now (`MeetingVoiceToolsSheet`), and who
/// was there when is the transcript's "Who was there" strip.
struct MeetingPeopleChip: View {
    @Bindable var detail: MeetingDetailModel
    /// The person the editor opened on; nil adds one.
    @State private var editing: PersonStay?
    @State private var warnings: [String] = []
    /// The attendance check's one sentence (`ReviewRows.attendanceWarning`) and its full text with the commands it
    /// tried (`attendanceDetail`); the notes of this window's last suggestion run.
    @State private var attendance: String?
    @State private var attendanceDetail: String?
    @State private var notes: [String] = []
    @State private var showingDetails = false

    var body: some View {
        let people = detail.record.value?.participants ?? []
        MenuButton(style: .genHoverPlain(), items: { menu(people.map(\.name)) }) {
            MeetingDetailView.pickerLabel(symbol: warnings.isEmpty ? "person.2" : "person.fill.questionmark",
                                          text: people.isEmpty ? "No people" : Plural.count(people.count, "person", "people"),
                                          warn: !warnings.isEmpty)
        }
        .disabled(detail.record.value == nil)
        .instantTooltip(Self.tooltip(attendance: attendance, notes: notes))
        .accessibilityLabel(warnings.isEmpty ? "People, \(people.count)" : "People, \(people.count), needs a check")
        .accessibilityIdentifier("meetings.people.add")
        .task { if case .idle = detail.rows { detail.loadRows() } }
        .onChange(of: detail.rows.value?.attendanceWarning, initial: true) { _, _ in updateWarnings() }
        .onChange(of: detail.rows.value?.attendanceDetail, initial: true) { _, _ in updateWarnings() }
        .onChange(of: detail.suggestionWarnings, initial: true) { _, _ in updateWarnings() }
        .sheet(isPresented: $detail.showingMeetingPeopleEditor) { editor }
        .sheet(isPresented: $showingDetails) {
            MeetingPeopleDetailsSheet(attendance: attendanceDetail ?? attendance, notes: notes) { showingDetails = false }
        }
    }

    /// Built at the click (`MenuButton`), so the body never walks the people. The attendance sentence stands first;
    /// the log with its commands opens from "Details…", never in the menu or the tooltip (U3).
    private func menu(_ names: [String]) -> [MenuButtonItem] {
        var items: [MenuButtonItem] = attendance.map { [MenuButtonItem.note($0)] } ?? []
        if !Self.detailsText(attendance: attendanceDetail ?? attendance, notes: notes).isEmpty {
            items.append(.action("Details…") { showingDetails = true })
        }
        if !items.isEmpty { items.append(.divider) }
        items += names.map { person in .action("\(person)…") { edit(person) } }
        if !names.isEmpty { items.append(.divider) }
        items.append(.action("Add a person…") { edit("") })
        return items
    }

    private func updateWarnings() {
        attendance = detail.rows.value?.attendanceWarning
        attendanceDetail = detail.rows.value?.attendanceDetail
        notes = detail.suggestionWarnings
        warnings = Self.peopleWarnings(attendance: attendance, suggested: notes)
    }
    static func peopleWarnings(attendance: String?, suggested: [String]) -> [String] {
        Array(Set(suggested + (attendance.map { [$0] } ?? []))).sorted()
    }

    /// The chip's tooltip: the attendance sentence and where to act. The notes of a suggestion run can carry a log with
    /// commands ("attendance unavailable; E2 skipped: tools ms-teams …"), so the tooltip only counts them.
    static func tooltip(attendance: String?, notes: [String]) -> String {
        if let attendance {
            let sentence = attendance.trimmingCharacters(in: .whitespacesAndNewlines)
            return (sentence.hasSuffix(".") ? sentence : sentence + ".") + " Add or edit the people here."
        }
        if !notes.isEmpty {
            let them = notes.count == 1 ? "it" : "them"
            return "The last suggestion run left \(Plural.count(notes.count, "note")); Details… in this menu shows \(them). Add or edit the people here."
        }
        return "Who took part: edit someone's join and leave, or add a person"
    }

    /// What Details… shows and copies: the attendance check's full text, then each note the suggestion run left that
    /// does not repeat it.
    static func detailsText(attendance: String?, notes: [String]) -> String {
        ((attendance.map { [$0] } ?? []) + notes.filter { $0 != attendance }).joined(separator: "\n\n")
    }

    /// The one editor of who was there (`PersonStayEditor`), on this person or on a new one.
    private func edit(_ person: String) {
        editing = person.isEmpty ? nil : PersonStay.of(person, in: detail.record.value)
        detail.showingMeetingPeopleEditor = true
    }

    private var editor: some View {
        PersonStayEditor(detail: detail, original: editing, duration: detail.window?.meeting(detail.id)?.durationSec) {
            detail.showingMeetingPeopleEditor = false
        }
    }
}

/// "Details…" of the people chip: the attendance check's full text, with the commands it tried, and the notes of the
/// last suggestion run, as the tools wrote them. Selectable, and Copy takes all of it (U3).
struct MeetingPeopleDetailsSheet: View {
    let attendance: String?
    let notes: [String]
    let close: () -> Void

    var body: some View {
        let others = notes.filter { $0 != attendance }
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text("People: details").font(.headline)
                Text("The full text of the attendance check and of the last suggestion run's notes, as the tools wrote them.")
                    .font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if let attendance { block("Attendance", [attendance]) }
                    if !others.isEmpty { block("Notes from the last suggestion run", others) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 320)
            HStack {
                Button("Copy") { Clipboard.copy(MeetingPeopleChip.detailsText(attendance: attendance, notes: notes), what: "details") }
                    .accessibilityIdentifier("meetings.people.details.copy")
                Spacer()
                Button("Done", action: close).keyboardShortcut(.defaultAction)
            }
        }
        .padding(16)
        .frame(width: 520)
        .accessibilityIdentifier("meetings.people.details")
    }

    private func block(_ title: String, _ texts: [String]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.system(size: 13, weight: .semibold))
            ForEach(Array(texts.enumerated()), id: \.offset) { _, text in
                Text(verbatim: text).font(.system(size: 11, design: .monospaced)).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
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

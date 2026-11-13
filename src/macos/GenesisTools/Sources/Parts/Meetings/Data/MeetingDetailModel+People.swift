import Foundation
import Observation

// MARK: - The people directory's calls (F10; R23, R24, R44)

/// The people directory's methods: through the Meetings service when it answers, else `tools meetings people` with the
/// same JSON (`people list|add|hide|merge|unmerge --json`), so the picker and the Contacts view work without a service.
enum PeopleCalls {
    /// `people.known`, or `people list [query] --json`.
    static func known(_ params: MeetingsAPI.PeopleKnown.Params) -> MeetingsRead<MeetingsAPI.PeopleKnown.Result> {
        .service(MeetingsAPI.PeopleKnown.self, params, orRun: knownArgs(params))
    }

    static func knownArgs(_ params: MeetingsAPI.PeopleKnown.Params) -> [String] {
        var args = ["people", "list", "--json"]
        if let meeting = params.meeting { args += ["--meeting", meeting] }
        if let at = params.atSec { args += ["--at", MeetingsCLI.jsonArgument(at)] }
        if let limit = params.limit { args += ["--limit", String(limit)] }
        if params.includeHidden == true { args.append("--hidden") }
        // After `--`, a query that starts with a dash is a query, not an option.
        if !params.query.isEmpty { args += ["--", params.query] }
        return args
    }

    static func addArgs(_ params: MeetingsAPI.PeopleAdd.Params) -> [String] {
        ["people", "add", "--json"] + (params.email.map { ["--email", $0] } ?? []) + (params.note.map { ["--note", $0] } ?? [])
            + ["--", params.name]
    }

    static func hideArgs(_ params: MeetingsAPI.PeopleHide.Params) -> [String] {
        ["people", "hide", "--json"] + (params.hidden == false ? ["--show"] : []) + ["--", params.person]
    }

    /// `people merge a b [--name] --json` prints the plan; `--yes` makes the merge.
    static func mergeArgs(_ params: MeetingsAPI.PeopleMergeParams, make: Bool) -> [String] {
        ["people", "merge", "--json"] + (params.name.map { ["--name", $0] } ?? []) + (make ? ["--yes"] : []) + ["--", params.a, params.b]
    }

    static func unmergeArgs(_ token: String) -> [String] { ["people", "unmerge", "--json", "--", token] }

    /// One write: the service's method, or the command when no service answers. A refusal of the service is the answer.
    @MainActor
    static func write<M: MeetingsServiceMethod>(_ method: M.Type, _ params: M.Params, orRun args: [String],
                                                service: MeetingsService?) async throws -> M.Result {
        try await MeetingsService.write(method, params, service: service, orRun: args)
    }


}

// MARK: - A picker's search

/// The people a picker lists for what was typed: `people.known` for the meeting and the moment, asked again a short
/// pause after each key. A failed read shows in the picker as a source that did not answer, never as an empty list.
@Observable
@MainActor
final class PeopleSearch {
    private(set) var people: [KnownPerson] = []
    private(set) var sources: [PersonSourceState] = []
    private(set) var total = 0
    /// The plan's warning for the typed name (G-PPL-4), when the search was made with a `warning` source.
    private(set) var warning: String?
    @ObservationIgnored let meeting: String?
    @ObservationIgnored var atSec: Double?
    @ObservationIgnored let limit: Int
    @ObservationIgnored private let service: MeetingsService?
    /// The warning for a typed name: a rename's plan. nil asks none.
    @ObservationIgnored private let warningFor: ((String) async -> String?)?
    @ObservationIgnored private var task: Task<Void, Never>?

    init(meeting: String?, atSec: Double? = nil, limit: Int = 20, service: MeetingsService?,
         warningFor: ((String) async -> String?)? = nil) {
        self.meeting = meeting
        self.atSec = atSec
        self.limit = limit
        self.service = service
        self.warningFor = warningFor
    }

    /// Asks for `query` after `delay` (a key typed); a newer ask cancels this one.
    func ask(_ query: String, after delay: Duration = .milliseconds(150)) {
        task?.cancel()
        let params = MeetingsAPI.PeopleKnown.Params(query: query.trimmingCharacters(in: .whitespaces), meeting: meeting,
                                                    atSec: atSec, limit: limit)
        task = Task { [weak self] in
            if delay > .zero {
                try? await Task.sleep(for: delay)
            }
            guard let self, !Task.isCancelled else { return }
            async let warned = self.warningFor?(query)
            do {
                let answer = try await PeopleCalls.known(params).run(service: self.service)
                guard !Task.isCancelled else { return }
                self.receive(answer)
            } catch {
                guard !Task.isCancelled else { return }
                // The picker names a source that did not answer; the add row still offers the typed name.
                self.sources = [PersonSourceState(kind: .meetings, state: .failed, reason: asFailure(error).sentence)]
            }
            let warning = await warned ?? nil
            guard !Task.isCancelled else { return }
            if self.warning != warning { self.warning = warning }
        }
    }

    func receive(_ answer: MeetingsAPI.PeopleKnown.Result) {
        if people != answer.people { people = answer.people }
        if sources != answer.sources { sources = answer.sources }
        total = answer.total
    }

    func cancel() { task?.cancel() }
}

// MARK: - The meeting's speakers and people

extension MeetingDetailModel {
    /// The seats editor's Save: one write the sheet waits for, so a draft the engine refuses (a blank remote name, a
    /// group of room and remote people) stays open with the reason, instead of a notice whose Retry sends it again.
    func saveSeats(_ seats: MeetingSeats) async throws {
        var action = DecisionAction(kind: "set")
        action.seats = seats
        let result = try await Self.applyDecision(meeting: id, action: action, reason: nil, service: service)
        readRecord(quiet: true)
        window?.loadOverview(quiet: true)
        guard let entry = result.entry else {
            if let skipped = result.skipped.first {
                throw MeetingsCLI.Failure(sentence: skipped.reason, detail: "set seats: \(skipped.id)")
            }
            return
        }
        ownTokens.insert(entry.token)
        notices.push(StackedNotice(text: "Updated seats and microphones", actions: [.undo { [weak self] notice in
            self?.revert(token: entry.token, items: nil, replacing: notice)
        }]))
    }

    func editMeetingPerson(_ params: MeetingsAPI.MeetingPeopleEdit.Params) async throws {
        var args = ["attendance", id, params.action == "remove" ? "--remove" : "--add", params.name, "--json"]
        if let from = params.fromSec { args += ["--from", String(from)] }
        if let to = params.toSec { args += ["--to", String(to)] }
        if params.atMic == true { args += ["--at-mic"] }
        if let owner = params.via { args += ["--via", owner] }
        _ = try await PeopleCalls.write(MeetingsAPI.MeetingPeopleEdit.self, params, orRun: args, service: service)
        reloadRecord()
        window?.loadOverview()
    }
    /// The source label a shown speaker name stands for: a transcript block shows the rename ("Dana Example") where the
    /// record renamed a label, and a rename or an assignment names the label ("Speaker 2").
    func speakerLabel(forShown name: String) -> String {
        speakerLabels(forShown: name).first ?? name
    }

    /// Every source label a shown speaker name stands for, sorted: two labels share a name after a rename made them
    /// one person. Sorted, because the order of a dictionary changes between runs.
    func speakerLabels(forShown name: String) -> [String] {
        let labels = record.value?.speakers.labels ?? [:]
        if labels[name] != nil { return [name] }
        return labels.filter { $0.value == name }.map(\.key).sorted()
    }

    /// True when `name` is a label of the transcript's source, not a name given to one.
    func isSourceLabel(_ name: String) -> Bool {
        if record.value?.speakers.labels[name] != nil { return true }
        if let stats = speakers.value, stats.speakers.contains(where: { $0.label == name }) { return true }
        return name.range(of: #"^(Speaker|S)\s?\d+$"#, options: .regularExpression) != nil
    }

    /// The stretch of a transcript block that starts at `startSec`: the speaker's lines from there until another
    /// speaker talks. Only the label's own lines when the shown name is a source label. A name that two labels share
    /// names no label: the block's lines carry the shown name only, so either label could own them.
    func blockStretch(speaker: String, startSec: Double) -> DecisionAction.Stretch {
        let lines = transcript.value?.entries ?? []
        var end = startSec
        if let first = lines.firstIndex(where: { ($0.startSec ?? -1) >= startSec - 0.01 && $0.speaker == speaker }) {
            for line in lines[first...] {
                guard line.speaker == speaker else { break }
                end = max(end, line.endSec ?? line.startSec ?? end)
            }
        }
        let held = speakerLabels(forShown: speaker)
        let label = held.count > 1 ? nil : (held.first ?? speaker)
        return DecisionAction.Stretch(label: label.flatMap { isSourceLabel($0) ? $0 : nil }, fromSec: startSec, toSec: end)
    }

    /// The plan's warning for renaming `label` to `typed` (G-PPL-4: "S2 is named Alex Example already: S3 and S2
    /// become one person"). nil without a service, for a name that changes nothing, or when the plan fails.
    func renameWarning(label: String, typed: String) async -> String? {
        guard let service, let name = Self.renameTarget(label: label, saved: record.value?.speakers.labels[label], typed: typed) else {
            return nil
        }
        let plan = try? await service.call(MeetingsAPI.PersonDecisionPlan.self, .init(meeting: id, action: .rename(label, to: name)))
        return plan?.warnings?.first
    }

    /// A picker for this meeting at `atSec`: its people first (G-PPL-3), with the rename warning for `label`.
    func peopleSearch(atSec: Double?, renaming label: String? = nil) -> PeopleSearch {
        PeopleSearch(meeting: id, atSec: atSec, service: service, warningFor: label.map { label in
            { [weak self] typed in await self?.renameWarning(label: label, typed: typed) }
        })
    }

    /// "Add 'X' as new speaker": the name goes into the people book (`people.add`), then renames the label. The rename
    /// runs even when the add fails: the name reaches the directory through the meeting record anyway.
    func addPersonAndRename(label: String, name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        Task {
            _ = try? await PeopleCalls.write(MeetingsAPI.PeopleAdd.self, .init(name: trimmed),
                                             orRun: PeopleCalls.addArgs(.init(name: trimmed)), service: service)
            rename(label: label, to: trimmed)
        }
    }

    /// The other stretches an `assign` may reach, through the service or CLI plan. A failed plan leaves the
    /// assignment scoped to this stretch.
    func assignReach(_ stretch: DecisionAction.Stretch, to person: String, email: String?) async -> [MeetingsAPI.AssignStretch]? {
        let action = DecisionAction.assign(person, email: email, stretches: [stretch])
        guard let args = Self.journalCommand(meeting: id, action: action, reason: nil) else { return nil }
        let read: MeetingsRead<MeetingsAPI.PersonDecisionPlan.Result> = .service(
            MeetingsAPI.PersonDecisionPlan.self, .init(meeting: id, action: action), orRun: args + ["--plan"])
        return (try? await read.run(service: service))?.reach?.stretches
    }

    /// "Assign this stretch" (R21, R22): the plan first; when it reaches more stretches of the same label and the window
    /// asks before a wide change (`meetings.rows.askReach`), the reach sheet asks "Just this" or which ones too.
    /// Otherwise the stretch goes to the person at once.
    func startAssign(_ stretch: DecisionAction.Stretch, to person: String, email: String?) {
        Task {
            let asks = MeetingsPreferences.Rows.askReach.value(window?.defaults ?? .standard) == .always
            let more = asks ? await assignReach(stretch, to: person, email: email) ?? [] : []
            if more.isEmpty || window == nil {
                assign([stretch], to: person, email: email)
            } else {
                window?.people.pendingAssign = PendingAssign(meeting: id, person: person, email: email, stretch: stretch, more: more)
            }
        }
    }

    /// Gives stretches of the meeting to a person (R21, R22, G-SPK-5) through the decision journal, as the window, with
    /// an Undo notice. Without a service each stretch runs as `people assign`.
    func assign(_ stretches: [DecisionAction.Stretch], to person: String, email: String?) {
        guard let first = stretches.first else { return }
        let key = "assign.\(first.fromSec)"
        guard !busy.contains(key) else { return }
        busy.insert(key)
        let done = stretches.count == 1
            ? "\(MeetingsFormat.clock(first.fromSec)) to \(MeetingsFormat.clock(first.toSec)) is \(person) now"
            : "\(Plural.count(stretches.count, "stretch", "stretches")) are \(person) now"
        Task {
            defer { busy.remove(key) }
            do {
                let result = try await Self.applyDecision(meeting: id, action: .assign(person, email: email, stretches: stretches),
                                                          reason: nil, service: service)
                afterAssign()
                guard let entry = result.entry else {
                    notices.push(StackedNotice(text: result.skipped.first?.reason ?? "Nothing changed"))
                    return
                }
                ownTokens.insert(entry.token)
                notices.push(StackedNotice(text: done, actions: [.undo { [weak self] id in
                    self?.revert(token: entry.token, items: nil, replacing: id) { self?.afterAssign() }
                }]))
            } catch {
                notices.push(.meetingsFailure(error) { [weak self] in self?.assign(stretches, to: person, email: email) })
            }
        }
    }

    /// An assignment changed who said what: the record, the corrected transcript and the speakers read again.
    private func afterAssign() {
        readRecord(quiet: true)
        transcriptChanged()
        if speakers != .idle { readSpeakers(quiet: true) }
        window?.loadOverview(quiet: true)
    }
}

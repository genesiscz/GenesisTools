import GenesisToolsHost
import SwiftUI

enum VoiceDestination: Hashable {
    case person(VoiceOwner, project: String?)
    case project(String)
    case inspector(meeting: String, project: String, meetingOnly: Bool)

    var scope: VoiceBrowseScope {
        switch self {
        case .person(_, let project): return project.map(VoiceBrowseScope.project) ?? .all
        case .project(let project): return .project(project)
        case .inspector(let meeting, let project, let only): return only ? .meeting(meeting) : .project(project)
        }
    }
    var owner: VoiceOwner? { if case .person(let owner, _) = self { return owner }; return nil }
    var meeting: String? { if case .inspector(let id, _, _) = self { return id }; return nil }
    var project: String? {
        if case .inspector(_, let project, _) = self { return project }
        return scope.project
    }
}

struct VoiceLibraryRows: Equatable {
    struct Row: Identifiable, Equatable {
        let sample: VoiceSample
        let quality: LearntVoice.Sample?
        var id: String { sample.id }
    }
    struct Person: Identifiable, Equatable {
        let person: VoicePerson
        let rows: [Row]
        let prints: [String]
        var id: String { person.id }
    }
    let people: [Person]
    let others: [Person]
    let projects: [String]
    let meetings: Set<String>
    let conflicts: [MeetingsAPI.VoicesList.Result.Conflict]

    init(_ response: MeetingsAPI.VoicesList.Result, destination: VoiceDestination, doubtfulFirst: Bool) {
        let learnt = response.learnt ?? []
        var quality: [String: LearntVoice.Sample] = [:]
        var summaries: [String: String] = [:]
        for group in learnt {
            let summary = "\(group.model) · \(group.track) · \(group.dimension) dimensions · "
                + "\(group.independent) independent of \(Plural.count(group.count, "sample"))"
                + (group.meanCosine.map { " · mean cosine \(VoiceScore.text($0))" } ?? "")
            for sample in group.samples {
                quality[sample.id] = sample
                summaries[sample.id] = summary
            }
        }
        var primary: [Person] = [], other: [Person] = []
        var projects = Set<String>(), meetings = Set<String>()
        let sameNameCount = response.people.count
        for person in response.people {
            if let owner = destination.owner {
                let address = person.owner?.email?.lowercased()
                if let address {
                    guard address == owner.email?.lowercased() else { continue }
                } else {
                    guard PeopleText.personKey(person.person) == PeopleText.personKey(owner.name),
                          owner.email == nil || sameNameCount == 1 else { continue }
                }
            }
            var rows = person.samples.map { Row(sample: $0, quality: quality[$0.id]) }
            if doubtfulFirst {
                rows = rows.filter { $0.quality?.outlier == true } + rows.filter { $0.quality?.outlier != true }
            }
            var seen = Set<String>()
            let prints = person.samples.compactMap { sample -> String? in
                guard let summary = summaries[sample.id], seen.insert(summary).inserted else { return nil }
                return summary
            }
            let group = Person(person: person, rows: rows, prints: prints)
            meetings.formUnion(person.meetings)
            projects.formUnion(person.projects ?? (person.project.isEmpty ? [] : [person.project]))
            if let meeting = destination.meeting, !person.meetings.contains(meeting) {
                if !rows.isEmpty { other.append(group) }
            } else {
                primary.append(group)
            }
        }
        func ordered(_ groups: [Person]) -> [Person] {
            guard doubtfulFirst else { return groups }
            return groups.filter { $0.rows.first?.quality?.outlier == true } + groups.filter { $0.rows.first?.quality?.outlier != true }
        }
        self.people = ordered(primary)
        self.others = ordered(other)
        self.projects = projects.sorted()
        self.meetings = meetings
        conflicts = response.conflicts ?? []
    }
}

enum LibraryCorrection: Equatable {
    case move(id: String, person: String, to: VoiceOwner)
    case reject(id: String, person: String, reason: String)
    case remove(id: String?, person: String, scope: VoiceBrowseScope)

    var title: String {
        switch self {
        case .move(_, _, let to): return "Move sample to \(to.name)\(to.email.map { " (\($0))" } ?? "")"
        case .reject(_, _, "bad-audio"): return "Reject unusable audio for everyone"
        case .reject(_, _, "several-voices"): return "Reject mixed voices for everyone"
        case .reject(_, let person, _): return "Mark as the wrong person for \(person)"
        case .remove(let id, let person, _): return id == nil ? "Remove these samples of \(person)" : "Remove sample of \(person)"
        }
    }
    var effect: String {
        switch self {
        case .move(_, let person, _): return "The sample keeps its source. Future learning skips this clip for \(person)."
        case .reject(_, _, "wrong-person"): return "Future learning skips this clip for this person."
        case .reject: return "Future learning skips this audio for every person."
        case .remove: return "A later backfill can learn this clip again."
        }
    }

    @MainActor
    func call(_ service: MeetingsService, preview: Bool, planToken: String?, token: String) async throws -> VoiceCorrectionReply {
        switch self {
        case .move(let id, let person, let to):
            return try await service.call(MeetingsAPI.VoicesMove.self, .init(id: id, person: person, to: to, preview: preview,
                                                                            planToken: planToken, token: token))
        case .reject(let id, let person, let reason):
            return try await service.call(MeetingsAPI.VoicesReject.self, .init(id: id, person: person, reason: reason, preview: preview,
                                                                               planToken: planToken, token: token))
        case .remove(let id, let person, let scope):
            let reply = try await service.call(MeetingsAPI.VoicesRemove.self, .init(person: person, scope: scope, id: id,
                                                                                   planToken: planToken, preview: preview))
            return .init(status: preview ? "preview" : "applied", token: reply.token, planToken: reply.planToken,
                         ids: reply.ids, affected: reply.affected)
        }
    }
}

@Observable @MainActor
final class VoiceLibraryModel {
    struct Confirmation: Identifiable {
        let id: String
        let action: LibraryCorrection
        let plan: String
        let message: String
    }
    @ObservationIgnored weak var window: MeetingsWindowModel?
    private(set) var destination: VoiceDestination?
    private(set) var rows: Loadable<VoiceLibraryRows> = .idle
    var confirmation: Confirmation?
    var busy = false
    @ObservationIgnored private var read: Task<Void, Never>?
    @ObservationIgnored private var response: MeetingsAPI.VoicesList.Result?
    private(set) var doubtfulFirst = true
    private(set) var jobs: [VoiceJob] = []
    private(set) var jobsFailure: MeetingsCLI.Failure?
    private(set) var cancelling: Set<String> = []
    @ObservationIgnored private var allJobs: [VoiceJob] = []
    @ObservationIgnored private var jobRead: Task<Void, Never>?
    @ObservationIgnored private var duringRead: [String: VoiceJob] = [:]
    /// Offscreen snapshots can replay one recorded service response at a specific point in the job.
    @ObservationIgnored var snapshotJobs: [VoiceJob]?

    init(window: MeetingsWindowModel) { self.window = window }

    func show(_ destination: VoiceDestination, doubtfulFirst: Bool) {
        if self.destination == destination {
            if self.doubtfulFirst != doubtfulFirst {
                self.doubtfulFirst = doubtfulFirst
                if let response { rows = .loaded(.init(response, destination: destination, doubtfulFirst: doubtfulFirst)) }
            }
            return
        }
        self.doubtfulFirst = doubtfulFirst
        self.destination = destination
        response = nil
        rows = .idle
        confirmation = nil
        allJobs = []; jobs = []; jobsFailure = nil
        refresh()
        loadJobs()
    }

    func hide(_ old: VoiceDestination) {
        guard destination == old else { return }
        read?.cancel()
        jobRead?.cancel()
        jobRead = nil
        destination = nil
        response = nil
        confirmation = nil
        rows = .idle
    }

    func refresh() {
        guard let destination else { return }
        guard let service = window?.service else { rows = .failed(VoicesModel.noService, previous: rows.value); return }
        read?.cancel()
        if rows.value == nil { rows = .loading(previous: nil) }
        read = Task {
            let span = HubPerf.begin("meetings.voices.list", destination.scope.kind)
            defer { span.end() }
            do {
                let result = try await service.call(MeetingsAPI.VoicesList.self, .init(scope: destination.scope, person: destination.owner?.name))
                guard !Task.isCancelled, self.destination == destination else { return }
                if response != result || rows.failure != nil {
                    response = result
                    rows = .loaded(.init(result, destination: destination, doubtfulFirst: doubtfulFirst))
                    prepareJobs()
                }
            } catch {
                guard !Task.isCancelled, self.destination == destination else { return }
                rows = .failed(asFailure(error), previous: rows.value)
            }
        }
    }

    func loadJobs() {
        guard let destination else { return }
        jobRead?.cancel()
        duringRead.removeAll()
        if let snapshotJobs {
            allJobs = snapshotJobs
            prepareJobs()
            return
        }
        guard let service = window?.service else { return }
        jobRead = Task {
            do {
                let listed = try await service.call(MeetingsAPI.VoicesJobs.self, .init(project: destination.project))
                guard !Task.isCancelled, self.destination == destination else { return }
                // An event after the read started wins over the snapshot. Keep arrival order for newly queued jobs.
                let ids = Set(listed.map(\.id))
                allJobs = listed.map { duringRead[$0.id] ?? $0 } + allJobs.filter { !ids.contains($0.id) && duringRead[$0.id] != nil }
                jobsFailure = nil
                prepareJobs()
            } catch {
                guard !Task.isCancelled, self.destination == destination else { return }
                jobsFailure = asFailure(error)
            }
            duringRead.removeAll()
            jobRead = nil
        }
    }

    func receive(_ job: VoiceJob) {
        guard snapshotJobs == nil, let destination,
              destination.project == nil || destination.project == job.project else { return }
        if jobRead != nil { duringRead[job.id] = job }
        if let index = allJobs.firstIndex(where: { $0.id == job.id }) {
            allJobs[index] = job
        } else {
            allJobs.append(job)
        }
        prepareJobs()
        if !job.canCancel, job.added > 0, destination.meeting == nil || destination.meeting == job.meeting || destination.scope.kind == "project" {
            refresh()
        }
    }

    private func prepareJobs() {
        guard let destination else { return }
        let matching = allJobs.reversed().filter { $0.matches(destination, meetings: rows.value?.meetings ?? []) }
        let next = matching.filter(\.canCancel) + Array(matching.filter { !$0.canCancel }.prefix(50))
        if jobs != next { jobs = next }
    }

    func cancel(_ job: VoiceJob) {
        guard job.canCancel, !cancelling.contains(job.id), let service = window?.service else { return }
        cancelling.insert(job.id)
        Task {
            defer { cancelling.remove(job.id) }
            do {
                if let current = try await service.call(MeetingsAPI.VoicesJobsCancel.self, .init(id: job.id)) {
                    receive(current)
                } else {
                    window?.notices.push(StackedNotice(text: "This job is no longer in the queue."))
                    loadJobs()
                }
            } catch { window?.notices.push(.meetingsFailure(error)) }
        }
    }

    func play(_ sample: VoiceSample, person: String, project: String) {
        guard let window, let service = window.service, let scope = destination?.scope else { return }
        guard sample.available else { return }
        let params: MeetingsAPI.VoicesSample.Params
        if let id = sample.stableID {
            params = .init(scope: scope, id: id)
        } else {
            guard !project.isEmpty, scope == .project(project) else { return }
            params = .init(project: project, person: person, sample: sample.sample)
        }
        window.player.playVoiceSample(sample, person: person) { try await service.call(MeetingsAPI.VoicesSample.self, params) }
    }

    func preview(_ action: LibraryCorrection) {
        guard !busy, let destination, let service = window?.service else { return }
        busy = true
        let token = UUID().uuidString
        Task {
            defer { busy = false }
            do {
                let reply = try await action.call(service, preview: true, planToken: nil, token: token)
                try reply.require("preview")
                guard self.destination == destination else { return }
                guard let plan = reply.planToken, let ids = reply.ids, !ids.isEmpty else {
                    throw MeetingsCLI.Failure(sentence: "There are no samples to correct in this selection.", detail: action.title)
                }
                let affected = reply.affected ?? []
                let impact = affected.isEmpty ? "No suggested names change."
                    : "\(Plural.count(affected.count, "suggested line")) will be reconsidered across \(Plural.count(Set(affected.map(\.meeting)).count, "meeting"))."
                confirmation = .init(id: token, action: action, plan: plan,
                                     message: "\(Plural.count(ids.count, "sample")) affected. \(impact) \(action.effect)")
            } catch { window?.notices.push(.meetingsFailure(error)) }
        }
    }

    func apply(_ choice: Confirmation) {
        guard !busy, let window, let service = window.service else { return }
        confirmation = nil
        busy = true
        Task {
            defer { busy = false }
            do {
                let result = try await choice.action.call(service, preview: false, planToken: choice.plan, token: choice.id)
                try result.require("applied")
                guard let receipt = result.token else {
                    throw MeetingsCLI.Failure(sentence: "The service returned no correction receipt. Read the library again.", detail: choice.action.title)
                }
                let undoRequest = UUID().uuidString
                window.notices.push(StackedNotice(text: "Voice library updated", detail: choice.action.title, actions: [.undo { [weak self] notice in
                    window.notices.settleUndo(notice, done: "Voice correction undone") {
                        let reply = try await service.call(MeetingsAPI.VoicesUndo.self, .init(token: receipt, requestToken: undoRequest))
                        try reply.require("applied")
                        self?.refresh()
                    }
                }]))
            } catch { window.notices.push(.meetingsFailure(error)) }
            refresh()
        }
    }
}

/// The three destinations use this same list and the window's playback and correction context.
struct VoiceSampleRows: View {
    let model: VoiceLibraryModel
    let destination: VoiceDestination
    var focus: String?
    var reveal: (String) -> Void = { _ in }
    var waiting: VoicesPreviewSummary?
    @AppStorage(MeetingsVoiceCompute.doubtfulFirstKey) private var doubtfulFirst = true
    @State private var expanded: Set<String> = []
    @State private var full: Set<String> = []
    @State private var othersOpen = false
    @State private var moving: VoiceLibraryRows.Row?
    @State private var search: PeopleSearch?
    @State private var query = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                Text(destination.meeting != nil ? "People in this meeting" : "Voice samples").font(.headline)
                Spacer()
                IconButton(systemName: "gearshape", tooltip: "Voice library settings") {
                    FeatureSettingsLaunch.open(pageID: MeetingsSettingsPages.speakersPage + "#voiceLibrary")
                }
                IconButton(systemName: "arrow.clockwise", tooltip: "Read the voice library again") { model.refresh() }
            }
            if model.destination == destination {
                VoiceJobRows(model: model)
            }
            if model.destination == destination, let failure = model.rows.failure {
                FailureInline(failure.report(outcome: "Voice samples did not load", action: "Read voice samples"), form: .compact) { model.refresh() }
            }
            if model.destination == destination, let rows = model.rows.value {
                ForEach(rows.conflicts, id: \.file) { conflict in
                    Text(conflict.message).font(.caption)
                    PathLabel(path: conflict.file, font: .caption, showIcons: false)
                }
                if rows.people.isEmpty {
                    Text(destination.owner == nil ? "No voice samples in this scope yet." : "No samples for this person in this scope.")
                        .foregroundStyle(.secondary)
                }
                ForEach(rows.people) { group in groupRow(group).id(group.id) }
                if !rows.others.isEmpty {
                    GenDisclosure("Other people of the project (\(rows.others.count))", isExpanded: $othersOpen) {
                        ForEach(rows.others) { group in groupRow(group).id(group.id) }
                    }
                }
            } else if model.rows.failure == nil {
                HStack { ProgressView().controlSize(.small); Text("Reading voice samples…") }
            }
        }
        .onChange(of: destination, initial: true) { _, next in
            expanded = []; full = []; othersOpen = false
            model.show(next, doubtfulFirst: doubtfulFirst)
        }
        .onChange(of: doubtfulFirst) { _, first in model.show(destination, doubtfulFirst: first) }
        .onChange(of: model.rows.value?.people.first?.id, initial: true) { _, _ in revealFocus() }
        .onChange(of: focus) { _, _ in revealFocus() }
        .onDisappear { model.hide(destination); search?.cancel() }
        .sheet(item: $moving, onDismiss: { search?.cancel(); search = nil }) { row in
            PersonPicker(people: search?.people ?? [], query: $query, sources: search?.sources ?? [],
                         title: "Move this sample to", prompt: "Search people", pick: { person in
                moving = nil
                guard let id = row.sample.stableID, let owner = row.sample.owner else { return }
                model.preview(.move(id: id, person: owner.name, to: .init(name: person.name, email: person.email)))
            }, cancel: { moving = nil })
            .onChange(of: query) { _, value in search?.ask(value) }
            .padding()
        }
        .alert(item: Bindable(model).confirmation) { choice in
            Alert(title: Text(choice.action.title + "?"), message: Text(choice.message),
                  primaryButton: .destructive(Text("Confirm")) { model.apply(choice) }, secondaryButton: .cancel())
        }
    }

    private func revealFocus() {
        guard model.destination == destination, let rows = model.rows.value else { return }
        guard let name = focus ?? destination.owner?.name else { return }
        let primary = rows.people.first { $0.person.person == name }
        guard let group = primary ?? rows.others.first(where: { $0.person.person == name }) else { return }
        if primary == nil { othersOpen = true }
        expanded.insert(group.id)
        reveal(group.id)
    }

    @ViewBuilder private func groupRow(_ group: VoiceLibraryRows.Person) -> some View {
        let person = group.person
        if group.rows.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                Text(person.person).fontWeight(.medium)
                Text("No sample yet").foregroundStyle(.secondary)
                if let waiting { Text(VoicesPane.waitingText(person.person, preview: waiting)).font(.caption) }
            }
        } else {
            GenDisclosure(isExpanded: Binding(get: { expanded.contains(group.id) }, set: { open in
                if open { expanded.insert(group.id) } else { expanded.remove(group.id) }
            }), identifier: "meetings.voices.person", accessibilityTitle: person.person) {
                ForEach(group.prints, id: \.self) { Text($0).font(.caption).foregroundStyle(.secondary) }
                ForEach(group.rows.prefix(full.contains(group.id) ? group.rows.count : VoicesPane.shownRows)) { row in
                    VoiceClipRow(row: row, person: person.person, project: person.project,
                                 model: model, scope: destination.scope, move: {
                        query = ""
                        let lookup = PeopleSearch(meeting: nil, limit: 50, service: model.window?.service)
                        search = lookup
                        lookup.ask("", after: .zero)
                        moving = row
                    })
                    Divider()
                }
                if group.rows.count > VoicesPane.shownRows, !full.contains(group.id) {
                    Button("Show all \(group.rows.count) samples") { full.insert(group.id) }.buttonStyle(.genHoverPlain())
                }
                if destination.scope.kind == "project", group.rows.first?.sample.stableID != nil {
                    Button("Remove all of this person’s samples in this project…") {
                        model.preview(.remove(id: nil, person: person.person, scope: destination.scope))
                    }
                    .buttonStyle(.genHoverPlain()).disabled(model.busy)
                }
            } label: {
                VStack(alignment: .leading) {
                    Text(person.person).fontWeight(.medium)
                    if let email = person.owner?.email { Text(email).font(.caption).foregroundStyle(.secondary) }
                }
                Text(Plural.count(group.rows.count, "sample")).font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

private struct VoiceClipRow: View {
    let row: VoiceLibraryRows.Row
    let person: String
    let project: String
    let model: VoiceLibraryModel
    let scope: VoiceBrowseScope
    let move: () -> Void

    var body: some View {
        let sample = row.sample
        let canPlay = sample.available && (sample.stableID != nil || (!project.isEmpty && scope == .project(project)))
        let player = model.window?.player
        let active = player?.top?.voiceSampleID == sample.id && player?.phase == .playing
        HStack(alignment: .top, spacing: 8) {
            IconButton(systemName: active ? "pause.fill" : "play.fill",
                       tooltip: canPlay ? (active ? "Pause this sample" : "Play this sample’s recorded track") : "Original audio unavailable") {
                model.play(sample, person: person, project: project)
            }
            .disabled(!canPlay).accessibilityLabel(active ? "Pause sample of \(person)" : "Play sample of \(person)")
            VStack(alignment: .leading, spacing: 3) {
                Text(sample.title ?? sample.meeting).fontWeight(.medium)
                Text([sample.project ?? project, sample.seat == "mic" ? "Microphone" : "Call", sample.track,
                      "\(MeetingsFormat.clock(sample.fromSec))–\(MeetingsFormat.clock(sample.toSec))"]
                    .filter { !$0.isEmpty }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                if !sample.words.isEmpty { Text(sample.words).textSelection(.enabled) }
                Text(provenance(sample)).font(.caption).foregroundStyle(.secondary)
                if let date = PeopleDates.date(sample.confirmedAt) {
                    LiveAgo(date: date, style: .brief) { "Confirmed \($0)" }.font(.caption).foregroundStyle(.secondary)
                }
                if !canPlay { Label("Original audio unavailable", systemImage: "speaker.slash").font(.caption) }
                Label(row.quality?.explanation ?? "No compatible comparison",
                      systemImage: row.quality?.outlier == true ? "exclamationmark.triangle" : "waveform")
                    .font(.caption).foregroundStyle(row.quality?.outlier == true ? Color.orange : Color.secondary)
                if let neighbor = row.quality?.neighbor {
                    Text("Closest other voice: \(neighbor.owner.name) · cosine \(VoiceScore.text(neighbor.score))").font(.caption)
                } else if row.quality?.neighborReason != nil {
                    Text("No independent sample of another person on this track").font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
            if let id = sample.stableID {
                MenuButton(items: { menu(id, owner: sample.owner?.name ?? person) }) {
                    Image(systemName: "ellipsis.circle")
                }.instantTooltip("Correct this sample").accessibilityLabel("Correct sample of \(person)")
                    .disabled(model.busy)
            }
        }
        .font(.callout).padding(.vertical, 4).liveRow()
    }

    private func provenance(_ sample: VoiceSample) -> String {
        let origin: String
        switch sample.origin {
        case "confirm": origin = "Confirmed by ear"
        case "answer": origin = "Speaker answer"
        case "enrol": origin = "Manual enrolment"
        default: origin = "Legacy sample"
        }
        let acquisition: String?
        switch sample.acquiredBy {
        case "live": acquisition = "Learned live"
        case "backfill": acquisition = "Recovered by backfill"
        case "migration": acquisition = "Imported"
        case "manual": acquisition = "Added manually"
        default: acquisition = nil
        }
        return [origin, acquisition, sample.transferred == true ? "Reassigned" : nil].compactMap { $0 }.joined(separator: " · ")
    }

    private func menu(_ id: String, owner: String) -> [MenuButtonItem] {
        [.action("Move to another person…", run: move),
         .action("Wrong person…") { model.preview(.reject(id: id, person: owner, reason: "wrong-person")) },
         .action("Unusable audio…") { model.preview(.reject(id: id, person: owner, reason: "bad-audio")) },
         .action("Several voices…") { model.preview(.reject(id: id, person: owner, reason: "several-voices")) },
         .divider,
         .action("Remove sample…") { model.preview(.remove(id: id, person: owner, scope: scope)) }]
    }
}

private struct VoiceJobRows: View {
    let model: VoiceLibraryModel
    @State private var olderOpen = false

    var body: some View {
        if let failure = model.jobsFailure {
            FailureInline(failure.report(outcome: "Voice jobs did not load", action: "Read voice jobs"), form: .compact) { model.loadJobs() }
        }
        if let first = model.jobs.first {
            jobRow(first)
            if model.jobs.count > 1 {
                GenDisclosure("Other jobs (\(model.jobs.count - 1))", isExpanded: $olderOpen) {
                    ForEach(model.jobs.dropFirst()) { jobRow($0) }
                }
            }
            Divider()
        }
    }

    private func jobRow(_ job: VoiceJob) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Label(job.kind == "backfill" ? "Recovering voice samples" : "Learning voices", systemImage: "waveform")
                    .fontWeight(.medium)
                Text(job.state.rawValue.capitalized).font(.caption).foregroundStyle(.secondary)
                Spacer()
                if job.canCancel {
                    Button("Cancel") { model.cancel(job) }.buttonStyle(.genHoverPlain())
                        .disabled(model.cancelling.contains(job.id))
                        .instantTooltip("Stop this job. Samples already saved stay in the library.")
                }
            }
            if job.state == .running, job.progress.total > 0 {
                ProgressView(value: Double(job.progress.done), total: Double(job.progress.total))
            }
            Text(job.progress.step).font(.callout)
            Text("\(job.progress.done) of \(Plural.count(job.progress.total, "line")) · \(job.added) added · \(job.skipped) skipped")
                .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            if let error = job.error { NoticePill(text: "Voice learning failed", more: error, tone: .error) }
            if let meeting = job.meeting, model.destination?.meeting == nil {
                Text(meeting).font(.caption).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("meetings.voices.job.\(job.id)")
    }
}

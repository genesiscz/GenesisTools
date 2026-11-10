import Foundation
import Observation

/// A stretch given to a person that may reach more of the same label (R22's speaker version): the sheet asks "Just
/// this", or which of the other stretches go to the person too, each playable first.
struct PendingAssign: Identifiable, Equatable {
    let id = UUID()
    let meeting: String
    let person: String
    let email: String?
    let stretch: DecisionAction.Stretch
    let more: [MeetingsAPI.AssignStretch]

    static func == (lhs: PendingAssign, rhs: PendingAssign) -> Bool { lhs.id == rhs.id }
}

/// The window's people: the Contacts view (R24, G-PPL-5) and the assignment that waits for its sheet. One per window;
/// the open meeting's speaker pickers search through `PeopleSearch` instead.
@Observable
@MainActor
final class MeetingsPeopleModel {
    /// The Contacts view's search: a short pause after each key asks again.
    var query = "" {
        didSet { if oldValue != query { load(after: .milliseconds(200)) } }
    }
    /// The Contacts view lists the hidden people too.
    var showHidden = false {
        didSet { if oldValue != showHidden { load() } }
    }
    private(set) var known: Loadable<MeetingsAPI.PeopleKnown.Result> = .idle
    /// The merge to confirm (`people.planMerge`); nil closes the sheet.
    var mergePlan: PeopleMergePlan?
    /// The merge just made, for its Undo line; cleared by the next action or after the notice time.
    private(set) var lastMerge: PeopleMergeRecord?
    /// An assignment that may reach more stretches: the reach sheet shows while it is set.
    var pendingAssign: PendingAssign?
    /// The most people the Contacts view lists at once.
    static let contactsLimit = 500
    @ObservationIgnored private weak var window: MeetingsWindowModel?
    @ObservationIgnored private var loadTask: Task<Void, Never>?
    @ObservationIgnored private var mergeClear: Task<Void, Never>?

    init(window: MeetingsWindowModel?) {
        self.window = window
    }

    private var service: MeetingsService? { window?.service }

    /// The directory's source switches as the config holds them (`global.people.sources`, both on by default).
    var switches: PeopleSourceSwitches {
        let raw = window?.settingsRaw
        func on(_ name: String) -> Bool {
            if case .bool(let value) = raw?.at(["global", "people", "sources", name]) { return value }
            return true
        }
        return PeopleSourceSwitches(contacts: on("contacts"), calendar: on("calendar"))
    }

    /// Every person for the query (`people.known`, or `people list --json`).
    func load(after delay: Duration = .zero) {
        loadTask?.cancel()
        let params = MeetingsAPI.PeopleKnown.Params(query: query.trimmingCharacters(in: .whitespaces), limit: Self.contactsLimit,
                                                    includeHidden: showHidden ? true : nil)
        if known.value == nil { known = .loading(previous: nil) }
        loadTask = Task { [weak self] in
            if delay > .zero {
                try? await Task.sleep(for: delay)
            }
            guard let self, !Task.isCancelled else { return }
            do {
                let answer = try await PeopleCalls.known(params).run(service: self.service)
                guard !Task.isCancelled else { return }
                if self.known != .loaded(answer) { self.known = .loaded(answer) }
            } catch {
                guard !Task.isCancelled else { return }
                self.known = .failed(asFailure(error), previous: self.known.value)
            }
        }
    }

    /// The view opened: the first read, and the config for the source switches.
    func ensure() {
        if known == .idle { load() }
        window?.loadSettings(quiet: true)
    }

    // MARK: Writes

    func add(name: String, email: String?) {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        let address = email?.trimmingCharacters(in: .whitespaces).nilIfEmpty
        let params = MeetingsAPI.PeopleAdd.Params(name: trimmed, email: address)
        perform({ [service] in
            let added = try await PeopleCalls.write(MeetingsAPI.PeopleAdd.self, params, orRun: PeopleCalls.addArgs(params), service: service)
            return added.added ? "Added \(added.person.name)" : (added.shown ? "\(added.person.name) shows again" : "\(added.person.name) was known already")
        }, retry: { [weak self] in self?.add(name: name, email: email) })
    }

    func setHidden(_ person: KnownPerson, hidden: Bool) {
        let params = MeetingsAPI.PeopleHide.Params(person: person.id, hidden: hidden)
        perform({ [service] in
            _ = try await PeopleCalls.write(MeetingsAPI.PeopleHide.self, params, orRun: PeopleCalls.hideArgs(params), service: service)
            return hidden ? "\(person.name) is hidden" : "\(person.name) shows again"
        }, undo: { [weak self] in self?.setHidden(person, hidden: !hidden) },
           retry: { [weak self] in self?.setHidden(person, hidden: hidden) })
    }

    /// "Merge with…" picked a second person: the plan names the meetings it changes before anything is written.
    func requestMerge(_ a: KnownPerson, _ b: KnownPerson) {
        let params = MeetingsAPI.PeopleMergeParams(a: a.id, b: b.id)
        Task {
            do {
                mergePlan = try await PeopleCalls.write(MeetingsAPI.PeoplePlanMerge.self, params,
                                                        orRun: PeopleCalls.mergeArgs(params, make: false), service: service)
            } catch {
                window?.notices.push(.meetingsFailure(error) { [weak self] in self?.requestMerge(a, b) })
            }
        }
    }

    /// The confirmation's Merge: an alias in the people book (no meeting record changes), with an Undo.
    func confirmMerge(_ plan: PeopleMergePlan, name: String) {
        guard plan.people.count == 2 else { return }
        mergePlan = nil
        let params = MeetingsAPI.PeopleMergeParams(a: plan.people[0].id, b: plan.people[1].id, name: name)
        Task {
            do {
                let made = try await PeopleCalls.write(MeetingsAPI.PeopleMerge.self, params,
                                                       orRun: PeopleCalls.mergeArgs(params, make: true), service: service)
                showMerge(made.merge)
                load()
            } catch {
                window?.notices.push(.meetingsFailure(error) { [weak self] in self?.confirmMerge(plan, name: name) })
            }
        }
    }

    /// Undo of a merge, or Split of a merged person.
    func unmerge(_ token: String) {
        lastMerge = nil
        perform({ [service] in
            let split = try await PeopleCalls.write(MeetingsAPI.PeopleUnmerge.self, .init(token: token),
                                                    orRun: PeopleCalls.unmergeArgs(token), service: service)
            return "\(split.merge.name) is \(Plural.count(split.merge.people.count, "person", "people")) again"
        }, retry: { [weak self] in self?.unmerge(token) })
    }

    /// A source switch (`global.people.sources.<name>`), then the list again.
    func setSource(_ source: PeopleSourceSwitches.Switch, on: Bool) {
        window?.setConfig(SidePanelCatalog.segments(source.configPath), .bool(on))
        load(after: .milliseconds(400))
    }

    /// The Contacts grant: the shared permission dialog; the list reads again when it arrives. The service reads
    /// Contacts in a process of its own, so a grant this process cannot see yet still counts.
    func grantContacts() {
        PermissionCenter.shared.require(PermissionNeed(
            .contacts, reason: "The Contacts view and the speaker picker list your contacts beside the people of your meetings.",
            grantWorksInNewProcess: true, onGranted: { [weak self] in self?.load() }))
    }

    private func showMerge(_ merge: PeopleMergeRecord) {
        lastMerge = merge
        mergeClear?.cancel()
        let seconds = MeetingsPreferences.noticeSeconds(window?.defaults ?? .standard)
        mergeClear = Task { [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            guard let self, !Task.isCancelled, self.lastMerge == merge else { return }
            self.lastMerge = nil
        }
    }

    /// Runs one write, says what it did in the window's notices (with an Undo when given), and reads the list again.
    private func perform(_ write: @escaping @MainActor () async throws -> String, undo: (@MainActor () -> Void)? = nil,
                         retry: @escaping @MainActor () -> Void) {
        lastMerge = nil
        Task {
            do {
                let done = try await write()
                let actions = undo.map { undo in [StackedNotice.Action.undo { _ in undo() }] } ?? []
                window?.notices.push(StackedNotice(text: done, actions: actions))
            } catch {
                window?.notices.push(.meetingsFailure(error, retry: retry))
            }
            load()
        }
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

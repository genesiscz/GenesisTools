import Foundation

/// The people of a project's meetings who are not paired with it yet, and pairing them (`projects.meetingPeople`,
/// `projects.pairFromMeetings`). Opening the page only reads; a click pairs, and its notice has an Undo that unpairs
/// exactly the people it paired.
extension MeetingsSettingsModel {
    func setPersonDetails(project: String, person: PairedPerson, role: String, aliases: [String]) {
        let path = ["projects", project, "match", "people"]
        guard var people = settingsRaw?.at(path).foundation as? [[String: Any]],
              let index = people.firstIndex(where: { ($0["name"] as? String) == person.name }) else { return }
        people[index]["role"] = role.trimmingCharacters(in: .whitespaces).isEmpty ? nil : role
        people[index]["aliases"] = aliases
        set(path, people, done: "Updated role and aliases for \(person.name)")
    }

    typealias MeetingPerson = MeetingsAPI.ProjectsMeetingPeople.Person

    static let meetingPeopleUnavailable =
        "The Meetings service does not answer yet, so the people of these meetings cannot be read. Try again in a moment."

    /// Calls a service-only method. The first call to a service that is not running starts it in the background, so
    /// one more call after a short wait answers instead of a failure the reader must retry.
    func callStartingService<M: MeetingsServiceMethod>(_ method: M.Type, _ params: M.Params) async throws -> M.Result {
        guard let service else { throw MeetingsService.Unavailable(reason: "no Meetings service in this build") }
        do {
            return try await service.call(method, params)
        } catch let failure as MeetingsService.Unavailable where failure.safeToRetry {
            try await Task.sleep(for: .seconds(3))
            return try await service.call(method, params)
        }
    }

    /// Reads the people once for a card that shows them.
    func ensureMeetingPeople(_ project: String) {
        if meetingPeople[project] == nil { loadMeetingPeople(project) }
    }

    func loadMeetingPeople(_ project: String) {
        meetingPeople[project] = .loading(previous: meetingPeople[project]?.value)
        Task {
            do {
                let people = try await callStartingService(MeetingsAPI.ProjectsMeetingPeople.self, .init(project: project))
                meetingPeople[project] = .loaded(people)
            } catch is MeetingsService.Unavailable {
                meetingPeople[project] = .failed(MeetingsCLI.Failure(sentence: Self.meetingPeopleUnavailable, detail: "projects.meetingPeople: no Meetings service"),
                                                 previous: meetingPeople[project]?.value)
            } catch {
                meetingPeople[project] = .failed(asFailure(error), previous: meetingPeople[project]?.value)
            }
        }
    }

    /// "Paired Alice Example with acme", or "Paired 4 people with acme".
    static func pairedNote(_ paired: [MeetingsAPI.ProjectsPairFromMeetings.Paired], project: String) -> String {
        paired.count == 1
            ? "Paired \(paired[0].name) with \(project)"
            : "Paired \(Plural.count(paired.count, "person", "people")) with \(project)"
    }

    /// Pairs `people` (nil: everyone the list shows) with the project.
    func pairFromMeetings(_ project: String, people: [MeetingPerson]?) {
        let key = "pair.\(project).\(people?.map(\.id).joined(separator: ",") ?? "*")"
        guard writes, !writing.contains(key), let service else { return }
        writing.insert(key)
        Task {
            defer { writing.remove(key) }
            do {
                let refs = people?.map { MeetingsAPI.ProjectsUnpair.Person(name: $0.name, email: $0.email) }
                let result = try await service.call(MeetingsAPI.ProjectsPairFromMeetings.self, .init(project: project, people: refs))
                let undo = StackedNotice.Action.undo { [weak self] id in
                    self?.unpairPaired(result.paired, from: project, replacing: id)
                }
                notices.push(StackedNotice(text: Self.pairedNote(result.paired, project: project), actions: result.paired.isEmpty ? [] : [undo]))
            } catch {
                notices.push(.meetingsFailure(error) { [weak self] in self?.pairFromMeetings(project, people: people) })
            }
            loadSettings()
        }
    }

    /// The Undo of a pairing from the meetings removes only the sources that operation added.
    private func unpairPaired(_ paired: [MeetingsAPI.ProjectsPairFromMeetings.Paired], from project: String,
                              replacing notice: StackedNotice.ID) {
        guard let service else { notices.release(notice); return }
        Task {
            do {
                for person in paired {
                    _ = try await service.call(MeetingsAPI.ProjectsUnpair.self,
                                               .init(project: project, person: .init(name: person.name, email: person.email), by: person.by))
                }
                notices.push(StackedNotice(text: "New pairings with \(project) undone"), replacing: notice)
            } catch {
                notices.push(.meetingsFailure(error) { [weak self] in
                    self?.unpairPaired(paired, from: project, replacing: notice)
                }, replacing: notice)
            }
            loadSettings()
        }
    }
}

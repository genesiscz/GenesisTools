import Foundation

/// One manual-assignment flow for the meeting window and the Settings preview. Its notices own it while an action
/// can still run; the flow holds the notice model weakly, so dismissing the result releases the flow.
@MainActor
final class MeetingProjectPairing {
    private let meeting: String
    private let project: String
    private let service: MeetingsService?
    private weak var notices: NoticeStackModel?
    private let reload: (() -> Void)?
    private var running = false

    private init(meeting: String, project: String, service: MeetingsService?, notices: NoticeStackModel,
                 reload: (() -> Void)?) {
        self.meeting = meeting
        self.project = project
        self.service = service
        self.notices = notices
        self.reload = reload
    }

    static func offer(meeting: String, project: String, service: MeetingsService?, notices: NoticeStackModel,
                      defaults: UserDefaults = .standard, reload: (() -> Void)? = nil) {
        let policy = MeetingsPreferences.Projects.pairOnAssignment.value(defaults)
        guard policy != .never else { return }
        let flow = MeetingProjectPairing(meeting: meeting, project: project, service: service, notices: notices, reload: reload)
        if policy == .always {
            flow.pair()
        } else {
            notices.push(StackedNotice(text: "Pair this meeting's people with \(project)?",
                detail: "Existing project links are kept. You can undo the new pairings.", actions: [
                    .init("Pair people", symbol: "person.2", afterPress: .wait("Pairing…")) { id in flow.pair(replacing: id) },
                    .init("Not now") { _ in },
                ]))
        }
    }

    private func pair(replacing notice: StackedNotice.ID? = nil) {
        guard let notices else { return }
        guard !running else { if let notice { notices.release(notice) }; return }
        guard let service else {
            notices.push(.meetingsFailure(MeetingsService.Unavailable(reason: "The Meetings service is needed to pair people.")) {
                self.pair(replacing: notice)
            }, replacing: notice)
            return
        }
        running = true
        Task {
            defer { running = false }
            do {
                let result = try await service.call(MeetingsAPI.ProjectsPairFromMeetings.self,
                                                    .init(project: project, people: nil, meeting: meeting))
                let text = result.paired.isEmpty ? "No new people to pair with \(project)" : MeetingsSettingsModel.pairedNote(result.paired, project: project)
                let actions: [StackedNotice.Action] = result.paired.isEmpty ? [] : [.undo { id in
                    self.undo(result.paired, replacing: id)
                }]
                notices.push(StackedNotice(text: text, actions: actions), replacing: notice)
                reload?()
            } catch {
                notices.push(.meetingsFailure(error) { self.pair(replacing: notice) }, replacing: notice)
            }
        }
    }

    private func undo(_ people: [MeetingsAPI.ProjectsPairFromMeetings.Paired], replacing notice: StackedNotice.ID) {
        guard let notices else { return }
        guard !running else { notices.release(notice); return }
        guard let service else { notices.release(notice); return }
        running = true
        Task {
            defer { running = false }
            do {
                for person in people {
                    _ = try await service.call(MeetingsAPI.ProjectsUnpair.self,
                                               .init(project: project, person: .init(name: person.name, email: person.email), by: person.by))
                }
                notices.push(StackedNotice(text: "New pairings with \(project) undone"), replacing: notice)
                reload?()
            } catch {
                notices.push(.meetingsFailure(error) { self.undo(people, replacing: notice) }, replacing: notice)
            }
        }
    }
}

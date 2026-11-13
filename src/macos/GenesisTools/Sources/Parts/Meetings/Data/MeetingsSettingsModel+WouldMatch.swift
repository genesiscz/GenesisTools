import Foundation

/// What a "Would match" row offers for its meeting: the rules' project put in place, or a project picked by hand. The
/// change goes through `decision.apply` with `set`, as the window's project picker does ("No project" through
/// `assign apply --none`, as the picker does too); the row changes in place and the list reads again behind it.
enum WouldMatchAction: Equatable {
    /// The rules match nothing: only the project menu.
    case none
    /// The meeting has the project the rules match.
    case matches(String)
    /// The meeting has no project and the rules match one.
    case confirm(String)
    /// The meeting has another project than the one the rules match.
    case update(from: String, to: String)
    /// The rules match several projects.
    case choose([String])

    /// The rules' projects are the draft's (equal to the saved rules' when nothing is edited).
    static func of(_ row: MatchPreviewRow) -> WouldMatchAction {
        let matched = row.draft
        guard let first = matched.first else { return .none }
        if let current = row.project, matched.contains(current) { return .matches(current) }
        if matched.count > 1 { return .choose(matched) }
        guard let current = row.project else { return .confirm(first) }
        return .update(from: current, to: first)
    }
}

extension MatchPreviewRow {
    /// The same row with another project, drawn at once while the list reads again.
    func with(project: String?) -> MatchPreviewRow {
        MatchPreviewRow(id: id, title: title, start: start, project: project, now: now, draft: draft, changed: changed)
    }
}

extension MeetingsSettingsModel {
    static func projectNote(_ title: String, to project: String?) -> String {
        let name = title.isEmpty ? "Untitled meeting" : title
        return project.map { "“\(name)” is in \($0) now" } ?? "“\(name)” has no project now"
    }

    func isSettingProject(_ row: MatchPreviewRow) -> Bool { isWriting("meeting.project.\(row.id)") }

    /// Puts the row's meeting in `project` (nil: no project). Its notice has an Undo that puts the old project back.
    func setMeetingProject(_ row: MatchPreviewRow, to project: String?, undoable: Bool = true) {
        let key = "meeting.project.\(row.id)"
        guard writes, !writing.contains(key), row.project != project else { return }
        writing.insert(key)
        let before = row.project
        Task {
            defer { writing.remove(key) }
            do {
                if let project {
                    try await applySet(meeting: row.id, project: project)
                } else {
                    _ = try await MeetingsCLI.run(["assign", "apply", row.id, "--none"])
                }
                if let rows = preview.value {
                    preview = .loaded(rows.map { $0.id == row.id ? $0.with(project: project) : $0 })
                }
                let actions = undoable ? [StackedNotice.Action("Undo", symbol: "arrow.uturn.backward") { [weak self] _ in
                    self?.setMeetingProject(row.with(project: project), to: before, undoable: false)
                }] : []
                notices.push(StackedNotice(text: undoable ? Self.projectNote(row.title, to: project) : "Undone: \(Self.projectNote(row.title, to: project))",
                                           actions: actions))
                if undoable, let project {
                    MeetingProjectPairing.offer(meeting: row.id, project: project, service: service, notices: notices) { [weak self] in
                        self?.loadSettings()
                    }
                }
            } catch {
                notices.push(.meetingsFailure(error) { [weak self] in self?.setMeetingProject(row, to: project, undoable: undoable) })
            }
            // The rows stay on screen while they read again: the list neither jumps nor blinks.
            loadPreview()
        }
    }

    /// The window's picker's write: `decision.apply` with `set`, or the command when no service answers.
    private func applySet(meeting: String, project: String) async throws {
        if let service {
            do {
                _ = try await service.call(MeetingsAPI.DecisionApply.self,
                                           .init(meeting: meeting, action: .set(project: project), reason: nil, onDecided: nil))
                return
            } catch let failure as MeetingsService.Unavailable where failure.safeToRetry {
                // Only a write the service never took: a lost reply may have applied it, and the command would
                // journal the assignment twice (`writeLibrary` keeps the same rule).
                try Task.checkCancellation()
            }
        }
        _ = try await MeetingsCLI.run(["set", meeting, "--project", project])
    }
}

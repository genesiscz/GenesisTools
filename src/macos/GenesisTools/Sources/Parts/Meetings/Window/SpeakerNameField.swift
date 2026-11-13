import SwiftUI

/// The rename field of a speaker row: the label's name for this meeting, with the person picker under it (R23, R44).
/// A click in the picker picks a person or adds the typed name, and never saves the half-typed text; focus lost
/// elsewhere keeps the draft with Save (`meetings.people.renameBlur`, G-PPL-1); Esc puts the saved name back. A name
/// another label already holds shows the plan's warning first (G-PPL-4).
struct SpeakerNameField: View {
    let label: String
    /// The saved rename; nil: the label's own name.
    let rename: String?
    /// The label's first spoken time: the picker ranks the people in the call then first (G-PPL-3).
    var atSec: Double? = nil
    let commit: (String) -> Void
    @Environment(\.meetingDetail) private var detail
    @State private var search: PeopleSearch?
    @AppStorage(MeetingsPreferences.People.renameBlur.key) private var blur = MeetingsPreferences.People.renameBlur.defaultValue.rawValue
    @AppStorage(MeetingsPreferences.People.offerNew.key) private var offerNew = MeetingsPreferences.People.offerNew.defaultValue.rawValue

    var body: some View {
        PersonNameField(
            label: label, saved: rename, people: search?.people ?? [], sources: search?.sources ?? [], warning: search?.warning,
            blur: PersonNameBlur(rawValue: blur) ?? .keepDraft,
            addRule: PersonPickerAddRule(rawValue: offerNew) ?? .noExactMatch,
            draftChanged: { search?.ask($0) },
            commitName: commit,
            pickPerson: { commit($0.name) },
            addPerson: { name in
                if let detail { detail.addPersonAndRename(label: label, name: name) } else { commit(name) }
            },
            grantContacts: detail?.window.map { window in { window.people.grantContacts() } })
            .accessibilityLabel("Rename \(label)")
            .onAppear {
                guard search == nil, let detail else { return }
                let next = detail.peopleSearch(atSec: atSec, renaming: label)
                search = next
                next.ask("", after: .zero)
            }
            .onDisappear { search?.cancel() }
    }
}

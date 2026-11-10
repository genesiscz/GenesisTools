import SwiftUI

/// The voice of a speaker range that no candidate names: the person picker (R23, R44) confirms the range as the person
/// picked or the name typed. The name stays in the field until the confirm lands (the range then leaves the
/// suggestions), so a refused name is not lost.
struct SpeakerNamePopover: View {
    @Binding var name: String
    /// When the range starts: the picker ranks the people in the call then first.
    var atSec: Double? = nil
    let confirm: (String) -> Void
    @Environment(\.meetingDetail) private var detail
    @State private var search: PeopleSearch?

    var body: some View {
        PersonPicker(
            people: search?.people ?? [], query: $name, sources: search?.sources ?? [],
            title: "Whose voice is this", addRule: MeetingsPreferences.People.offerNew.value(),
            pick: { confirm($0.name) },
            addNew: { typed in
                let trimmed = typed.trimmingCharacters(in: .whitespaces)
                if !trimmed.isEmpty { confirm(trimmed) }
            },
            grantContacts: detail?.window.map { window in { window.people.grantContacts() } })
            .onAppear {
                guard search == nil else { return }
                let next = detail?.peopleSearch(atSec: atSec)
                search = next
                next?.ask(name, after: .zero)
            }
            .onChange(of: name) { _, now in search?.ask(now) }
    }
}

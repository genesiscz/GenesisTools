import SwiftUI

/// A speaker's name, and the time when one is given, on a transcript block. Inside a meeting (`meetingDetail` in the
/// environment) the name is a menu (R44, Amie's "Jamie ▾ · 00:03"): Rename the label for this meeting, Assign this
/// stretch to someone, Play. Both picks open the person picker (`PersonPicker`).
struct SpeakerChip: View {
    let speaker: String
    /// When the block starts; nil shows the name alone.
    var startSec: Double? = nil
    /// Plays from `startSec`; nil shows the time as text.
    var play: ((Double) -> Void)? = nil
    @Environment(\.meetingDetail) private var detail
    @State private var picking: PickerMode?
    @State private var query = ""
    @State private var search: PeopleSearch?

    /// What the person picker does with its pick.
    enum PickerMode: String, Identifiable {
        case rename, assign
        var id: String { rawValue }
    }

    var body: some View {
        HStack(spacing: 6) {
            nameView
            if let startSec {
                if let play {
                    LiveButton(tooltip: "Play from \(MeetingsFormat.clock(startSec))", action: { play(startSec) }) {
                        time(startSec)
                    }
                    .accessibilityLabel("Play from \(MeetingsFormat.clock(startSec))")
                } else {
                    time(startSec)
                }
            }
        }
    }

    /// An empty label is a voice the source did not name.
    var name: String { speaker.isEmpty ? "Unknown voice" : speaker }

    @ViewBuilder
    private var nameView: some View {
        if let detail, !speaker.isEmpty {
            MenuButton(items: { menuItems(detail) }) {
                HStack(spacing: 3) {
                    Text(verbatim: name).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(.secondary)
                    Image(systemName: "chevron.down").font(.system(size: 7.5, weight: .bold)).foregroundStyle(.tertiary)
                        .accessibilityHidden(true)
                }
            }
            .instantTooltip("Rename \(name), give this stretch to someone, or play it")
            .accessibilityLabel("\(name), speaker menu")
            .popover(item: $picking, arrowEdge: .bottom) { mode in picker(mode, detail: detail) }
        } else {
            Text(verbatim: name)
                .font(.system(size: 11.5, weight: .semibold)).foregroundStyle(.secondary)
        }
    }

    private func menuItems(_ detail: MeetingDetailModel) -> [MenuButtonItem] {
        var items: [MenuButtonItem] = [
            .action("Rename \(detail.speakerLabel(forShown: speaker)) for this meeting…") { open(.rename, detail: detail) },
        ]
        if startSec != nil {
            items.append(.action("Assign this stretch…") { open(.assign, detail: detail) })
        }
        if let startSec, let play {
            items.append(.divider)
            items.append(.action("Play from \(MeetingsFormat.clock(startSec))") { play(startSec) })
        }
        return items
    }

    private func open(_ mode: PickerMode, detail: MeetingDetailModel) {
        let label = detail.speakerLabel(forShown: speaker)
        let next = detail.peopleSearch(atSec: startSec, renaming: mode == .rename ? label : nil)
        search?.cancel()
        search = next
        query = ""
        next.ask("", after: .zero)
        picking = mode
    }

    private func picker(_ mode: PickerMode, detail: MeetingDetailModel) -> some View {
        let label = detail.speakerLabel(forShown: speaker)
        return PersonPicker(
            people: search?.people ?? [], query: $query, sources: search?.sources ?? [],
            warning: mode == .rename ? search?.warning : nil,
            title: mode == .rename ? "Rename \(label)" : "Give this stretch to",
            addRule: MeetingsPreferences.People.offerNew.value(),
            pick: { person in
                picking = nil
                switch mode {
                case .rename: detail.rename(label: label, to: person.name)
                case .assign: assign(person.name, email: person.email, detail: detail)
                }
            },
            addNew: { typed in
                picking = nil
                switch mode {
                case .rename: detail.addPersonAndRename(label: label, name: typed)
                case .assign: assign(typed, email: nil, detail: detail)
                }
            },
            cancel: { picking = nil },
            grantContacts: detail.window.map { window in { window.people.grantContacts() } })
            .onChange(of: query) { _, now in search?.ask(now) }
    }

    private func assign(_ person: String, email: String?, detail: MeetingDetailModel) {
        guard let startSec else { return }
        detail.startAssign(detail.blockStretch(speaker: speaker, startSec: startSec), to: person, email: email)
    }

    private func time(_ seconds: Double) -> some View {
        Text(verbatim: MeetingsFormat.clock(seconds)).font(.system(size: 11, design: .monospaced))
            .foregroundStyle(KitPalette.renamed)
    }
}

private struct MeetingDetailKey: EnvironmentKey {
    static let defaultValue: MeetingDetailModel? = nil
}

extension EnvironmentValues {
    /// The open meeting, for the speaker views that act on it (the chip's menu, the rename field's picker). nil outside
    /// a meeting: the views then show only the name.
    var meetingDetail: MeetingDetailModel? {
        get { self[MeetingDetailKey.self] }
        set { self[MeetingDetailKey.self] = newValue }
    }
}

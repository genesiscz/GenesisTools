import SwiftUI

/// The one editor of who was there and when (audit M5): the person (picked from the people the window knows when one is
/// added), the join and the leave as clock text on the transcript clock, and the seat. The people chip's menu and the
/// "Who was there" strip open it; Save and Remove close it and leave a notice with Undo, so no step asks for
/// confirmation.
struct PersonStayEditor: View {
    @Bindable var detail: MeetingDetailModel
    /// The person as the record had them when the editor opened; nil adds a person.
    let original: PersonStay?
    /// The meeting's length, for the check that a time is inside it; nil when not known.
    let duration: Double?
    let close: () -> Void
    @State private var name: String
    @State private var from: String
    @State private var to: String
    @State private var atMic: Bool
    @State private var via: String
    @State private var busy = false
    @State private var failure: MeetingsCLI.Failure?
    @State private var search: PeopleSearch?
    /// The join and the leave the editor opened with, as seconds and as the text the fields showed: an untouched field
    /// saves the exact seconds, not its text rounded to a tenth.
    private let opened: (from: Double?, fromText: String, to: Double?, toText: String)

    /// `window`: a join and leave to start from (a dragged handle of a person with several stays).
    init(detail: MeetingDetailModel, original: PersonStay?, window: ClosedRange<Double>? = nil, duration: Double?,
         close: @escaping () -> Void) {
        self.detail = detail
        self.original = original
        self.duration = duration
        self.close = close
        let start = original ?? PersonStay(name: "", fromSec: nil, toSec: nil, atMic: true, via: nil, stays: 0)
        let from = window?.lowerBound ?? start.fromSec, to = window?.upperBound ?? start.toSec
        opened = (from, from.map(ListenPresenceStrip.clock) ?? "", to, to.map(ListenPresenceStrip.clock) ?? "")
        _name = State(initialValue: start.name)
        _from = State(initialValue: opened.fromText)
        _to = State(initialValue: opened.toText)
        _atMic = State(initialValue: start.atMic)
        _via = State(initialValue: start.via ?? "")
    }

    private var problem: String? {
        PersonStay.problem(from: .init(from), to: .init(to), duration: duration)
    }

    private var draft: PersonStay {
        PersonStay(name: name.trimmingCharacters(in: .whitespaces),
                   fromSec: from == opened.fromText ? opened.from : PersonStay.Clock(from).value,
                   toSec: to == opened.toText ? opened.to : PersonStay.Clock(to).value, atMic: atMic,
                   via: via.trimmingCharacters(in: .whitespaces).isEmpty ? nil : via.trimmingCharacters(in: .whitespaces),
                   stays: original?.stays ?? 0)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(original.map { "Who was there: \($0.name)" } ?? "Add a person").font(.headline)
            if original == nil { person }
            Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 10, verticalSpacing: 8) {
                GridRow {
                    Text("Joined").foregroundStyle(.secondary)
                    TextField("At the start", text: $from)
                        .accessibilityIdentifier("meetings.stay.from")
                }
                GridRow {
                    Text("Left").foregroundStyle(.secondary)
                    TextField("At the end", text: $to)
                        .accessibilityIdentifier("meetings.stay.to")
                }
                GridRow {
                    Text("Seat").foregroundStyle(.secondary)
                    GenSegmentedTabs("Seat", items: [.init(true, "This Mac's microphone"), .init(false, "Another device")],
                                     selection: $atMic, minSegmentWidth: 0, identifier: "meetings.stay.seat", size: .small)
                        .fixedSize()
                }
                if !atMic {
                    GridRow {
                        Text("Device").foregroundStyle(.secondary)
                        TextField("Their own", text: $via)
                            .accessibilityIdentifier("meetings.stay.via")
                    }
                }
            }
            .textFieldStyle(.roundedBorder)
            .font(.system(size: 12))
            Text(problem ?? "On the transcript clock, as 12:04 or 1:05:30. Empty: from the start, or to the end.")
                .font(.system(size: 11.5)).foregroundStyle(problem == nil ? Color.secondary : KitHue.care.ink)
                .fixedSize(horizontal: false, vertical: true)
            if let stays = original?.stays, stays > 1 {
                Text("Save replaces their \(stays) stays with this one, from the join to the leave.")
                    .font(.system(size: 11.5)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if let failure {
                NoticePill(text: failure.sentence, more: failure.detail, tone: .error,
                           fixes: [failure.detailsFix { save() }], dismiss: { self.failure = nil })
            }
            HStack {
                if original != nil {
                    // A routine removal: quiet, apart from Save, and undone from its notice.
                    Button("Remove from the meeting") { remove() }
                        .buttonStyle(.genHoverPlain())
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                        .disabled(busy)
                        .instantTooltip("Takes them out of this meeting; the notice offers Undo")
                        .accessibilityIdentifier("meetings.stay.remove")
                }
                Spacer()
                if busy { ProgressView().controlSize(.small) }
                Button("Cancel", action: close).keyboardShortcut(.cancelAction)
                Button("Save") { save() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy || problem != nil || draft.name.isEmpty)
                    .accessibilityIdentifier("meetings.stay.save")
            }
        }
        .padding(16)
        .frame(width: 440)
    }

    /// Adding: the people the window knows for this meeting, or a typed new name.
    @ViewBuilder
    private var person: some View {
        if name.isEmpty || search != nil {
            PersonPicker(people: search?.people ?? [], query: $name, sources: search?.sources ?? [], title: "Who",
                         prompt: "Search people or type a new name",
                         addRule: MeetingsPreferences.People.offerNew.value(), visibleRows: 4,
                         pick: { picked in name = picked.name; search?.cancel(); search = nil },
                         addNew: { typed in name = typed; search?.cancel(); search = nil },
                         grantContacts: detail.window.map { window in { window.people.grantContacts() } })
                .frame(height: 210)
                .onAppear {
                    let next = detail.peopleSearch(atSec: nil)
                    search = next
                    next.ask(name, after: .zero)
                }
                .onChange(of: name) { _, now in search?.ask(now) }
                .onDisappear { search?.cancel() }
        } else {
            HStack(spacing: 8) {
                Text("Who").foregroundStyle(.secondary).font(.system(size: 12))
                Text(verbatim: name).font(.system(size: 13, weight: .medium))
                Button("Change") { name = ""; search = nil }
                    .buttonStyle(.genHoverPlain()).font(.system(size: 12))
                    .accessibilityIdentifier("meetings.stay.changePerson")
            }
        }
    }

    private func save() {
        guard !busy, problem == nil, !draft.name.isEmpty else { return }
        run { try await detail.savePersonStay(draft, before: original) }
    }

    private func remove() {
        guard !busy, let original else { return }
        run { try await detail.removePersonStay(original) }
    }

    private func run(_ work: @escaping () async throws -> Void) {
        busy = true
        failure = nil
        Task {
            defer { busy = false }
            do {
                try await work()
                close()
            } catch {
                failure = asFailure(error)
            }
        }
    }
}

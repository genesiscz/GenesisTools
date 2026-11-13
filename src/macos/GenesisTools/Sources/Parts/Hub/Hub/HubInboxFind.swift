import SwiftUI

// ⌘F in the Inbox, wired from outside InboxMain (Hub/HubInbox.swift owns the cards). The cards and
// the session headers already carry `.findRow`, draw their texts with `FindText` under the keys of
// `InboxItem.findFields` / `InboxSession.findFields`, and InboxMain holds a `PanelFindBarSlot()`
// under its header; this view adds the find itself over the sessions InboxMain shows.

struct InboxFindHost: View {
    var model: HubModel
    @ObservedObject var inbox: HubInboxModel
    @AppStorage("hub.inbox.sort") private var sortKey = InboxSort.recent.rawValue
    @State private var find = PanelFindModel(scope: "inbox", title: "the inbox")

    /// What the rows are built from: the sessions, the sidebar filter (the variants filter each question by it) and
    /// the layout.
    private struct Revision: Equatable {
        let sessions: [InboxSession]
        let filter: String
        let option: String?
    }

    static func cardFields(session: InboxSession, item: InboxItem) -> [PanelFindField] {
        session.findFields.map { PanelFindField("session.\($0.key)", $0.text, markdown: $0.markdown) } + item.findFields
    }

    /// One row per question a redesign layout can show: option A's queue, option B's entries before its section and
    /// project filters (a reveal clears them). Every item of each session was indexed before, so a match could sit in
    /// a closed question or a sibling the sidebar filter hides, and the reveal then showed another card.
    static func variantRows(_ sessions: [InboxSession], filter: String, option: String) -> [PanelFindRow] {
        let questions: [(session: InboxSession, item: InboxItem)] = option == "a"
            ? ListsSketchA.queue(sessions, filter: filter).map { ($0.session, $0.item) }
            : ListsSketchB.entries(sessions, filter: filter).map { ($0.session, $0.item) }
        return questions.map { PanelFindRow(id: $0.item.id, fields: cardFields(session: $0.session, item: $0.item)) }
    }

    var body: some View {
        // The same sessions, order and sidebar filter as InboxMain, so no hit points at a hidden card:
        // InboxMain shows the queued-only sessions after the others, under their own heading.
        let sorted = inbox.sorted(InboxSort(rawValue: sortKey) ?? .recent, filter: model.filter)
        let sessions = sorted.filter { !$0.isQueuedOnly } + sorted.filter(\.isQueuedOnly)
        let option = HubLayout.option("lists")
        Group {
            switch option {
            case "a": ListsSketchA.InboxFocus(model: model, inbox: inbox)
            case "b": ListsSketchB.InboxTable(model: model, inbox: inbox)
            default: InboxMain(model: model, inbox: inbox)
            }
        }
            .panelFind(find, revision: Revision(sessions: sessions, filter: model.filter, option: option),
                       prepare: { match in prepareVariant(match, option: option) }) {
                if let option {
                    return Self.variantRows(inbox.sessions, filter: model.filter, option: option)
                }
                return sessions.flatMap { session in
                    [PanelFindRow(id: "session:\(session.id)", fields: session.findFields, container: session.id)]
                        + session.items.map { PanelFindRow(id: $0.id, fields: $0.findFields, container: session.id) }
                }
            }
    }

    /// A redesign layout builds a question's card only once it is the shown one (A) or the open line (B). The find
    /// selects it first and answers true, so the scroll waits for the layout that builds the card; selecting it from
    /// a separate subscriber raced the find's own scroll, which aimed at a card not built yet.
    private func prepareVariant(_ match: PanelFindMatch, option: String?) -> Bool {
        switch option {
        case "a":
            guard inbox.keyCardID != match.row,
                  let entry = ListsSketchA.queue(inbox, filter: model.filter).first(where: { $0.id == match.row }) else { return false }
            ListsSketchA.pick(entry, inbox: inbox)
            return true
        case "b":
            let pick = ListsSketchB.InboxPick.shared
            guard pick.open != match.row || pick.bucket != nil || pick.project != nil,
                  let entry = ListsSketchB.entries(inbox, filter: model.filter).first(where: { $0.id == match.row }) else { return false }
            inbox.selectedID = entry.session.id
            inbox.keyCardID = entry.item.id
            pick.bucket = nil
            pick.project = nil
            pick.open = entry.item.id
            return true
        default:
            return false
        }
    }
}

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

    var body: some View {
        // The same sessions, order and sidebar filter as InboxMain, so no hit points at a hidden card:
        // InboxMain shows the queued-only sessions after the others, under their own heading.
        let sorted = inbox.sorted(InboxSort(rawValue: sortKey) ?? .recent, filter: model.filter)
        let sessions = sorted.filter { !$0.isQueuedOnly } + sorted.filter(\.isQueuedOnly)
        Group {
            switch HubLayout.option("lists") {
            case "a": ListsSketchA.InboxFocus(model: model, inbox: inbox)
            case "b": ListsSketchB.InboxTable(model: model, inbox: inbox)
            default: InboxMain(model: model, inbox: inbox)
            }
        }
            .onReceive(find.$revealToken) { _ in
                guard let hit = find.current,
                      let session = sessions.first(where: { $0.items.contains(where: { $0.id == hit.row }) }) else { return }
                inbox.selectedID = session.id
                inbox.keyCardID = hit.row
                ListsSketchB.InboxPick.shared.bucket = nil
                ListsSketchB.InboxPick.shared.project = nil
                ListsSketchB.InboxPick.shared.open = hit.row
            }
            .panelFind(find, revision: sessions) {
                sessions.flatMap { session in
                    [PanelFindRow(id: "session:\(session.id)", fields: session.findFields, container: session.id)]
                        + session.items.map { PanelFindRow(id: $0.id, fields: $0.findFields, container: session.id) }
                }
            }
    }
}

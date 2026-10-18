import SwiftUI

// ⌘F in the Inbox, wired from outside InboxMain (Hub/HubInbox.swift owns the cards). The cards and
// the session headers already carry `.findRow`, draw their texts with `FindText` under the keys of
// `InboxItem.findFields` / `InboxSession.findFields`, and InboxMain holds a `PanelFindBarSlot()`
// under its header; this view adds the find itself over the sessions InboxMain shows.

struct InboxFindHost: View {
    @ObservedObject var model: HubModel
    @ObservedObject var inbox: HubInboxModel
    @AppStorage("hub.inbox.sort") private var sortKey = InboxSort.recent.rawValue
    @State private var find = PanelFindModel(scope: "inbox", title: "the inbox")

    var body: some View {
        // The same sessions, order and sidebar filter as InboxMain, so no hit points at a hidden card:
        // InboxMain shows the queued-only sessions after the others, under their own heading.
        let sorted = inbox.sorted(InboxSort(rawValue: sortKey) ?? .recent, filter: model.filter)
        let sessions = sorted.filter { !$0.isQueuedOnly } + sorted.filter(\.isQueuedOnly)
        InboxMain(model: model, inbox: inbox)
            .panelFind(find, revision: sessions) {
                sessions.flatMap { session in
                    [PanelFindRow(id: "session:\(session.id)", fields: session.findFields, container: session.id)]
                        + session.items.map { PanelFindRow(id: $0.id, fields: $0.findFields, container: session.id) }
                }
            }
    }
}

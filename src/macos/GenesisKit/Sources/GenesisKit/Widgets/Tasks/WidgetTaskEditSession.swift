import Combine
import Foundation

/// One task row's open editor. Save sends the version the editor opened on, so a ledger refresh during the edit makes
/// the save a conflict instead of overwriting newer text. The fields and Cancel stay live while a save is in flight,
/// so the ledger's confirmation closes the editor only when nothing was typed or reopened since the Save: text the
/// user wrote meanwhile is never dropped, and an editor opened after a Cancel is never closed by the old save.
@MainActor
final class WidgetTaskEditSession: ObservableObject {
    /// The task as it was when Edit opened; nil while the editor is closed.
    @Published private(set) var opened: WidgetTask?
    @Published var title = ""
    @Published var details = ""
    private var generation = 0

    var isOpen: Bool { opened != nil }

    func begin(_ task: WidgetTask) {
        generation += 1
        opened = task
        title = task.title
        details = task.summary == task.title ? "" : task.summary
    }

    func cancel() {
        generation += 1
        opened = nil
    }

    /// A refusal or a failure leaves the editor open with its text.
    func save(in store: WidgetTasksStore) {
        guard let opened else { return }
        let generation = generation
        let submitted = (title: title, details: details)
        store.edit(opened, title: title, details: details) { [weak self] saved in
            guard let self, self.generation == generation else { return }
            if self.title == submitted.title, self.details == submitted.details {
                self.opened = nil
            } else {
                // The ledger now holds the saved text at a newer revision; the next Save must carry that one.
                self.opened = saved
            }
        }
    }
}

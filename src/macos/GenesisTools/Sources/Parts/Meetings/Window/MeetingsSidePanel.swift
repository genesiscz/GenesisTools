import SwiftUI

/// The settings side panel, an inspector in the meeting's trailing pane slot that replaces the transcript pane while
/// it is open (`MeetingsWindowModel.sidePanelOpen`). Empty here: b-swift-settings-contacts (F8) builds its sections from
/// `MeetingsPreferences` and the engine keys.
struct MeetingsSidePanel: View {
    let window: MeetingsWindowModel
    let detail: MeetingDetailModel

    var body: some View {
        Color.clear
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Settings")
    }
}

import SwiftUI

/// The look of the window's tabs, buttons and chips (`meetings.window.look`), set once on the window's root. Every
/// kit control under it reads the look from the environment, so the setting changes the whole window at once.
struct MeetingsLookModifier: ViewModifier {
    @AppStorage(MeetingsPreferences.lookKey) private var look = MeetingsPreferences.defaultLook.rawValue

    func body(content: Content) -> some View {
        content.kitLook(KitLook(rawValue: look) ?? MeetingsPreferences.defaultLook)
    }
}

extension View {
    func meetingsLook() -> some View {
        modifier(MeetingsLookModifier())
    }
}

private struct MeetingSpeakerNamesKey: EnvironmentKey {
    static let defaultValue: [String] = []
}

extension EnvironmentValues {
    /// The shown names of the speakers of the meeting on screen: an avatar and a lane take a colour that no other
    /// speaker of the same meeting has (`KitPersonColor.color(for:among:)`).
    var meetingSpeakerNames: [String] {
        get { self[MeetingSpeakerNamesKey.self] }
        set { self[MeetingSpeakerNamesKey.self] = newValue }
    }
}

extension MeetingDetailModel.Tab {
    /// The tab's glyph beside its title (a wide header only).
    var symbol: String {
        switch self {
        case .transcript: "text.alignleft"
        case .screen: "rectangle.inset.filled"
        case .items: "checklist"
        case .speakers: "person.2"
        case .context: "paperclip"
        }
    }
}

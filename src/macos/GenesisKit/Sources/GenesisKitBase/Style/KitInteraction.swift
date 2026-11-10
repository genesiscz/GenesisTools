import SwiftUI

/// What the pointer does to a control: nothing, over it, or pressing it.
public enum KitInteraction: Sendable, Equatable {
    case rest, hover, pressed
}

private struct KitForcedInteractionKey: EnvironmentKey {
    static let defaultValue: KitInteraction? = nil
}

public extension EnvironmentValues {
    /// A state the kit's button styles draw whatever the pointer does. The component catalog sets it to draw a
    /// control under the pointer or pressed in a picture, where no pointer exists. Nil everywhere else.
    var kitForcedInteraction: KitInteraction? {
        get { self[KitForcedInteractionKey.self] }
        set { self[KitForcedInteractionKey.self] = newValue }
    }
}

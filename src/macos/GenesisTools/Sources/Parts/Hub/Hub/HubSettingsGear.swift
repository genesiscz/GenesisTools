import SwiftUI

/// The gear in the band under the hub's title bar. It opens the settings window; where the Preview app has the
/// widget and Clicky faces (`NativeStaging.facesEnabled`), it is a menu that also opens their settings. Those two
/// sat as rows at the top of the Agents list, where settings shortcuts read as list entries (hub UX C43).
struct HubSettingsGear: View {
    private var tooltip: String { HubKeymap.hint("Settings", "hub.app.settings") }

    var body: some View {
        if NativeStaging.facesEnabled {
            MenuButton(style: .genHoverIcon(), items: Self.items) {
                Image(systemName: "gearshape")
                    .font(.system(size: 12))
                    .frame(width: 16, height: 16)
            }
            .fixedSize()
            .foregroundColor(ReviewPalette.dim)
            .instantTooltip("\(tooltip), the widget and Clicky")
            .accessibilityLabel(Text("Settings, the widget and Clicky"))
        } else {
            // A gear is the settings glyph; the shield read as a security warning (H19).
            IconButton(systemName: "gearshape", tooltip: tooltip) {
                AppMenuTarget.shared.openSettings(nil)
            }
            .foregroundColor(ReviewPalette.dim)
        }
    }

    private static func items() -> [MenuButtonItem] {
        [
            .action("Settings…") { AppMenuTarget.shared.openSettings(nil) },
            .divider,
            // Each says what it opens: two bare names read as entries nobody could place (H22).
            .action("Widget: modules, edges and pinned sessions…") { WidgetLaunch.start() },
            .action("Clicky: key sounds…") {
                guard AppParts.requirePart("clicky", for: "open Clicky's settings") else { return }
                FeatureSettingsLaunch.open(pageID: "clicky.sound")
            },
        ]
    }
}

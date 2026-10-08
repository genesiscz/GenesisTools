import AppKit
import SwiftUI

@MainActor
public final class ClickyWindowController {
    public let model: ClickyModel
    public let settings: FeatureSettingsWindowController
    public var window: NSWindow? { settings.window }
    public init(model: ClickyModel) {
        self.model = model
        settings = FeatureSettingsWindowController(
            sections: ClickySettingsPages.sections(model: model),
            defaults: model.settingsDefaults, appearance: model.appearance)
    }

    @discardableResult
    public func prepare(page: ClickyPage = .sound) -> NSWindow {
        settings.prepare(pageID: ClickySettingsPages.pageID(page))
    }

    @discardableResult
    public func register(section: NativeSettingsSection) -> Bool { settings.register(section: section) }

    public func show(pageID: String? = nil) { settings.show(pageID: pageID) }

    public func close() { settings.close() }
}

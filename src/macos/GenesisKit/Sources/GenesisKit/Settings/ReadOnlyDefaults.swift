import Foundation

/// A defaults domain that reads like `UserDefaults(suiteName:)` and drops every write, for a run that must leave the
/// user's settings as it found them: a settings `--snapshot` draws the saved state, and building its models (Clicky's
/// recovery copy, the appearance migration) writes nothing.
public final class ReadOnlyDefaults: UserDefaults {
    public init?(reading suiteName: String? = nil) {
        super.init(suiteName: suiteName)
    }

    override public func set(_ value: Any?, forKey defaultName: String) {}
    override public func set(_ value: Bool, forKey defaultName: String) {}
    override public func set(_ value: Int, forKey defaultName: String) {}
    override public func set(_ value: Float, forKey defaultName: String) {}
    override public func set(_ value: Double, forKey defaultName: String) {}
    override public func set(_ url: URL?, forKey defaultName: String) {}
    override public func removeObject(forKey defaultName: String) {}
}

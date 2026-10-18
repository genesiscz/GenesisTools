import XCTest

@testable import GenesisKitBase
@testable import GenesisKit

/// The rule store is a keyed archive; these fixtures are XML archives, which PropertyListSerialization reads with the
/// same object references (`CF$UID`) as the binary store. No test reads the real store or reaches the network.
final class LocalNetworkPrivacyTests: XCTestCase {
    private static let app = "com.example.lan-fixture"
    private static let oldCopy = "/Users/example/.genesis-tools/app/retired.noindex/1/GenesisTools.app/Contents/MacOS/GenesisTools"

    /// Objects: 1 "$null"-path allowed rule, 2 path rule allowed, 3 path rule denied for another app, 4 an unanswered
    /// default, then the strings they reference.
    private static func store(appRuleAnswered: Bool = true, appRuleDenied: Bool = false) -> Data {
        func rule(id: Int, path: Int, answered: Bool, denied: Bool) -> String {
            """
            <dict><key>$class</key><dict><key>CF$UID</key><integer>9</integer></dict>
            <key>SigningIdentifier</key><dict><key>CF$UID</key><integer>\(id)</integer></dict>
            <key>Path</key><dict><key>CF$UID</key><integer>\(path)</integer></dict>
            <key>MulticastPreferenceSet</key><\(answered)/><key>DenyMulticast</key><\(denied)/></dict>
            """
        }
        let xml = """
        <?xml version="1.0" encoding="UTF-8"?>
        <plist version="1.0"><dict><key>$archiver</key><string>NSKeyedArchiver</string><key>$objects</key><array>
        <string>$null</string>
        \(rule(id: 5, path: 0, answered: appRuleAnswered, denied: appRuleDenied))
        \(rule(id: 5, path: 7, answered: true, denied: false))
        \(rule(id: 6, path: 0, answered: true, denied: true))
        \(rule(id: 5, path: 0, answered: false, denied: true))
        <string>\(app)</string>
        <string>com.example.other</string>
        <string>\(oldCopy)</string>
        <string>unused</string>
        <dict><key>$classname</key><string>NEPathRule</string></dict>
        </array></dict></plist>
        """
        return Data(xml.utf8)
    }

    func testReadsOnlyTheAnsweredRulesOfOneApp() throws {
        let rules = try XCTUnwrap(LocalNetworkPrivacy.answeredRules(for: Self.app, in: Self.store()))
        XCTAssertEqual(rules, [
            .init(signingIdentifier: Self.app, path: nil, allowed: true),
            .init(signingIdentifier: Self.app, path: Self.oldCopy, allowed: true),
        ])
        XCTAssertEqual(LocalNetworkPrivacy.answeredRules(for: "com.example.other", in: Self.store())?.map(\.allowed), [false])
        XCTAssertEqual(LocalNetworkPrivacy.answeredRules(for: "com.example.never-asked", in: Self.store()), [])
    }

    func testStatusPerExecutablePath() throws {
        let rules = try XCTUnwrap(LocalNetworkPrivacy.answeredRules(for: Self.app, in: Self.store()))
        XCTAssertEqual(LocalNetworkPrivacy.status(of: rules), .granted)
        XCTAssertEqual(LocalNetworkPrivacy.status(of: rules, path: Self.oldCopy), .granted)
        XCTAssertEqual(LocalNetworkPrivacy.status(of: rules, path: "/elsewhere/GenesisTools"), .notDetermined)

        let denied = try XCTUnwrap(LocalNetworkPrivacy.answeredRules(for: Self.app, in: Self.store(appRuleDenied: true)))
        XCTAssertEqual(LocalNetworkPrivacy.status(of: denied), .denied)

        let unanswered = try XCTUnwrap(
            LocalNetworkPrivacy.answeredRules(for: Self.app, in: Self.store(appRuleAnswered: false)))
        XCTAssertEqual(LocalNetworkPrivacy.status(of: unanswered), .notDetermined, "an unanswered default is no answer")
    }

    func testDataThatIsNotAKeyedArchiveReadsAsUnreadable() {
        XCTAssertNil(LocalNetworkPrivacy.answeredRules(for: Self.app, in: Data("not a plist".utf8)))
        XCTAssertNil(LocalNetworkPrivacy.uidValue("{value = 3}"), "only a real archive reference has a value")
        XCTAssertNil(LocalNetworkPrivacy.uidValue(3))
    }
}

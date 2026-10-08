import Foundation

func bugToTestHTTPURL(_ value: String) -> Bool {
    guard value.count <= 4000, let url = URL(string: value),
          let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme),
          url.host?.isEmpty == false,
          (url.user ?? "").isEmpty, (url.password ?? "").isEmpty else { return false }
    return true
}

struct BugToTestFingerprint: Codable, Equatable {
    var tag: String
    var role: String
    var name: String
}
struct BugToTestLocator: Codable, Equatable {
    var kind: String
    var value: String
    var name: String?
    var fingerprint: BugToTestFingerprint?
    var label: String { kind == "role" ? value + " “" + (name ?? "") + "”" : kind + ": " + value }
    var valid: Bool {
        guard ["testId", "role", "css"].contains(kind), !value.isEmpty, value.count < 1000 else { return false }
        if let fingerprint, [fingerprint.tag, fingerprint.role, fingerprint.name].contains(where: { $0.count >= 1000 }) { return false }
        return true
    }
}
struct BugToTestAction: Codable, Identifiable, Equatable {
    var id: String
    var kind: String
    var locator: BugToTestLocator?
    var value: String?
    var url: String?
    var sourceUrl: String?
    var excluded: Bool
    var at: Double
    var label: String { kind + " · " + (locator?.label ?? url ?? "") }
    var valid: Bool {
        guard ["click", "fill", "select", "press", "navigate"].contains(kind), id.count <= 100, at.isFinite else { return false }
        if let sourceUrl, !bugToTestHTTPURL(sourceUrl) { return false }
        if kind == "navigate" { return url.map(bugToTestHTTPURL) == true }
        guard locator?.valid == true else { return false }
        if ["fill", "select", "press"].contains(kind) { return value.map { $0.count <= 4000 } == true }
        return value.map { $0.count <= 4000 } ?? true
    }
}
struct BugToTestEvidence: Codable, Identifiable, Equatable {
    var id: String
    var kind: String
    var text: String
    var excluded: Bool
    var at: Double
}
struct BugToTestExpectation: Codable, Equatable {
    var description: String
    var kind: String
    var locator: BugToTestLocator?
    var expected: String
    var valid: Bool {
        guard description.count <= 4000, expected.count <= 4000,
              !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !expected.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              ["text", "value", "visible", "url"].contains(kind) else { return false }
        if kind == "visible" && !["true", "false"].contains(expected) { return false }
        if kind != "url" && locator?.valid != true { return false }
        if kind == "url" && !bugToTestHTTPURL(expected) { return false }
        return true
    }
}
struct BugToTestRecording: Codable, Equatable {
    var version: Int
    var id: String
    var title: String
    var initialUrl: String
    var actions: [BugToTestAction]
    var evidence: [BugToTestEvidence]
    var expectation: BugToTestExpectation?
    var workspace: String?
    var removedActionIds: [String]?
    var triggerActionId: String?
    var validForGeneration: Bool {
        version == 1 && id.count <= 100 && title.count <= 200 && actions.count <= 200 && evidence.count <= 500
            && expectation?.valid == true && bugToTestHTTPURL(initialUrl) && actions.allSatisfy(\.valid)
    }
}
struct BugToTestBrowser: Decodable, Identifiable {
    var id: String
    var name: String
}
struct BugToTestOpenedBrowser: Decodable {
    var browserId: String
    var pid: Int
    var port: Int
    var userDataDir: String
}
struct BugToTestTab: Decodable, Identifiable {
    var port: Int
    var id: String
    var title: String
    var url: String
}
struct BugToTestResult: Codable, Equatable {
    var status: String
    var message: String
    var testHash: String
    var trace: String?
    var report: String
    var durationMs: Double
    var exitCode: Int
    var label: String {
        switch status {
        case "intended-failure": return "Bug reproduced"
        case "passed": return "Assertion passed"
        case "cancelled": return "Cancelled"
        case "timed-out": return "Execution timed out"
        default: return "Setup or selector failed"
        }
    }
}
struct BugToTestWorkspace: Decodable {
    var source: String
    var result: BugToTestResult?
}
struct BugToTestGeneration: Decodable {
    var directory: String
    var recording: BugToTestRecording
}
struct BugToTestMinimized: Decodable {
    var directory: String
    var recording: BugToTestRecording
    var result: BugToTestResult
}
func bugToTestError(_ message: String) -> NSError { NSError(domain: "BugToTest", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }

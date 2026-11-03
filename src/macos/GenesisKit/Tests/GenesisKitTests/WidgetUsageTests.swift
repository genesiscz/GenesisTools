import SwiftUI
import Vision
import XCTest
@testable import GenesisKit

/// The widget's Usage module from canned doors (invented accounts): the rings collapsed, the rows and alerts expanded.
/// `USAGE_SNAPSHOT_DIR=<folder>` also writes both pictures there.
@MainActor
final class WidgetUsageTests: XCTestCase {
    static let limitsJSON = """
    {"schema":"usage.limits@1","generatedAt":"2026-03-02T15:00:00.000Z","selector":{"accounts":[]},"warnings":[],
     "data":{"accounts":[
      {"provider":"anthropic-sub","accountId":"acc_work","accountName":"work","label":"max",
       "limits":[{"key":"seven_day","label":"Weekly","kind":"weekly","percentUsed":82,"severity":"warning","resetsAt":"2099-03-05T10:00:00.000Z"}],
       "absentLimits":[{"key":"five_hour","kind":"session"}]},
      {"provider":"openai-sub","accountId":"acc_side","accountName":"side","label":"pro",
       "limits":[{"key":"primary","label":"5h","kind":"session","percentUsed":41,"severity":"ok","resetsAt":"2099-03-02T18:00:00.000Z"},
                 {"key":"secondary","label":"Weekly","kind":"weekly","percentUsed":20,"severity":"ok","resetsAt":"2099-03-07T10:00:00.000Z"}]}]}}
    """
    static let alertsJSON = """
    {"schema":"usage.alerts@1","generatedAt":"2026-03-02T15:00:00.000Z","selector":{"accounts":[]},"warnings":[],
     "data":{"unacked":1,"alerts":[{"id":7,"rule":"exhaust","provider":"anthropic-sub","accountId":"acc_work","accountName":"work",
       "windowKind":"weekly","windowKey":"seven_day","level":"critical","title":"work runs out Tuesday",
       "message":"Weekly 82% at 3.1%/h: at the limit Tue 16:20, before the reset","firedAt":"2026-03-02T14:00:00.000Z","channels":["macos"],"ackAt":null}]}}
    """
    static let seriesJSON = """
    {"schema":"usage.limits.series@1","generatedAt":"2026-03-02T15:00:00.000Z","selector":{"accounts":[]},"warnings":[],
     "data":{"agg":"raw","stepMs":0,"series":[],"coverage":[],"events":[]}}
    """

    private func store(opened: @escaping ([String]) -> Void = { _ in }) -> WidgetUsageStore {
        WidgetUsageStore(client: UsageClient { argv in
            if argv.contains("alerts") { return Data(Self.alertsJSON.utf8) }
            if argv.contains("series") { return Data(Self.seriesJSON.utf8) }
            return Data(Self.limitsJSON.utf8)
        }, watchFolder: NSTemporaryDirectory(), openHub: opened)
    }

    func testTheModuleReadsAccountsAndAlertsAndRingsTheChosenWindow() async throws {
        let store = store()
        store.load()
        for _ in 0..<200 where store.rows.isEmpty { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertEqual(store.rows.map(\.account.accountName), ["work", "side"])
        XCTAssertEqual(store.openAlerts.map(\.id), [7])
        XCTAssertTrue(store.hasCritical)
        let work = try XCTUnwrap(store.rows.first)
        // `work` has no 5h window: a 5h ring falls back to its week and says the 5h is absent.
        let ring = WidgetUsageStore.ring(work, window: .session)
        XCTAssertEqual(ring.percent, 82)
        XCTAssertTrue(ring.absent)
        XCTAssertEqual(WidgetUsageStore.ring(try XCTUnwrap(store.rows.last), window: .session).percent, 41)

        let collapsed = try render(WidgetUsageModuleView(store: store, presentation: .compact, ringWindow: .weekly), name: "widget-usage-compact")
        // Text recognition reads the small ring numbers unreliably against the orange arc; one of them is enough.
        XCTAssertTrue(collapsed.contains("82") || collapsed.contains("20"), collapsed)
        let expanded = try render(WidgetUsageModuleView(store: store, presentation: .expanded, ringWindow: .weekly)
            .frame(width: 432), name: "widget-usage-expanded")
        XCTAssertTrue(expanded.contains("work runs out Tuesday"), expanded)
        XCTAssertTrue(expanded.contains("no 5h"), expanded)
    }

    func testPreferencesDecodeWithoutTheUsageKey() throws {
        struct Holder: Decodable { let usage: WidgetUsagePreferences? }
        XCTAssertNil(try JSONDecoder().decode(Holder.self, from: Data("{}".utf8)).usage)
        XCTAssertEqual(try JSONDecoder().decode(Holder.self, from: Data(#"{"usage":{"ringWindow":"session"}}"#.utf8)).usage?.ringWindow, .session)
    }

    private func render<V: View>(_ view: V, name: String) throws -> String {
        let renderer = ImageRenderer(content: view.padding(10).background(Color.black).environment(\.colorScheme, .dark))
        renderer.scale = 2
        let image = try XCTUnwrap(renderer.cgImage)
        if let folder = ProcessInfo.processInfo.environment["USAGE_SNAPSHOT_DIR"] {
            let url = URL(fileURLWithPath: folder).appendingPathComponent("\(name).png")
            let destination = try XCTUnwrap(CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil))
            CGImageDestinationAddImage(destination, image, nil)
            XCTAssertTrue(CGImageDestinationFinalize(destination))
        }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image).perform([request])
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    }
}

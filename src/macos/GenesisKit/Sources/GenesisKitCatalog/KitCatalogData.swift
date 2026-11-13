import GenesisKit
import SwiftUI

@MainActor
extension KitCatalog {
    static var dataEntries: [CatalogEntry] { [paths, liveTime, sparklines, timeSeries, heatmap, categories] }

    static var paths: CatalogEntry {
        CatalogEntry(id: "paths", group: "Paths", name: "Paths and file actions", summary: "A shared path label provides copy, reveal and open actions. Long paths keep both their beginning and filename visible.",
            source: "GenesisKit/Paths/PathLabel.swift · GenesisKit/Paths/PathActions.swift · GenesisKit/Paths/PathMenu.swift", critique: ["A shortened label must retain the full path for actions.", "Do not lose the filename when a parent path is long."],
            sections: [CatalogSection("Path length and actions", flow: .column, [
                CatalogVariant("Folder") { PathLabel(path: "/Applications").frame(width: 500, alignment: .leading) },
                CatalogVariant("File with line") { PathLabel(path: "/example/project/Sources/RecordingReview.swift", line: 42).frame(width: 500, alignment: .leading) },
                CatalogVariant("Narrow label") { PathLabel(path: "/example/project/recordings/design-review/frames/display-01/frame-00250.jpg").frame(width: 240, alignment: .leading) },
                CatalogVariant("Named path, icons hidden") { PathLabel(path: "/example/project", showIcons: false, title: "Recording workspace").frame(width: 500, alignment: .leading) },
            ])])
    }

    static var liveTime: CatalogEntry {
        let now = Date()
        return CatalogEntry(id: "live-time", group: "Time", name: "Live time labels", summary: "Each label owns its clock and changes only when its text can change. Monospaced digits avoid shifting nearby content.",
            source: "GenesisKit/Time/LiveTime.swift · GenesisKit/Time/LiveAgo.swift", critique: ["Elapsed and relative time need different wording.", "An absent date should have an explicit fallback instead of a misleading age."],
            sections: [CatalogSection("Meaning and duration", flow: .column, [
                CatalogVariant("Recent") { LiveTime(date: now.addingTimeInterval(-25), style: .ago) },
                CatalogVariant("Elapsed") { LiveTime(date: now.addingTimeInterval(-252), style: .elapsed) },
                CatalogVariant("Upcoming") { LiveTime(date: now.addingTimeInterval(720), style: .until) },
                CatalogVariant("Compact") { LiveTime(date: now.addingTimeInterval(-7500), style: .briefCompact) },
                CatalogVariant("Age in context") { LiveAgo(date: now.addingTimeInterval(-300), format: { "Last read \($0)" }) },
                CatalogVariant("Missing date") { LiveAgo(date: nil, fallback: "Not read yet") },
            ])])
    }

    static var sparklines: CatalogEntry {
        CatalogEntry(id: "sparklines", group: "Charts", name: "Sparklines", summary: "A small trend keeps its scale and meaning explicit. Missing and constant series must remain readable.",
            source: "GenesisKit/Charts/Sparkline.swift", critique: ["A sparkline should not imply a large change from tiny differences.", "Keep an accessible value beside a shape that cannot explain itself."],
            sections: [CatalogSection("Series and scale", [
                CatalogVariant("Trend") { Sparkline(values: [2, 4, 3, 8, 6, 9], fill: true, showsExtrema: true, label: "Activity").frame(width: 160, height: 45) },
                CatalogVariant("Constant") { Sparkline(values: [4, 4, 4, 4], label: "Stable activity").frame(width: 160, height: 45) },
                CatalogVariant("Empty") { Sparkline(values: [], label: "No activity").frame(width: 160, height: 45) },
                CatalogVariant("Fixed range") { Sparkline(values: [0.3, 0.35, 0.32, 0.4], range: 0...1, label: "Share").frame(width: 160, height: 45) },
            ])])
    }

    static var timeSeries: CatalogEntry {
        let end = Date(timeIntervalSince1970: 1_800_000_000)
        let values: [NativeTimePoint] = (0..<24).map { (index: Int) in
            let date = end.addingTimeInterval(Double(index - 24) * 3600)
            let value = Double((index * 7) % 19 + 1)
            return NativeTimePoint(date: date, value: value)
        }
        return CatalogEntry(id: "time-series", group: "Charts", name: "Time series", summary: "A pannable, zoomable series combines samples consistently as the visible interval changes.",
            source: "GenesisKit/Charts/NativeCharts.swift", critique: ["Show the same scale when comparing the same values across styles.", "Empty data should keep the time axis meaningful."],
            sections: [CatalogSection("Chart style", flow: .column, [
                CatalogVariant("Area") { NativeTimeSeriesChart(points: values, interval: 3600, initialWindow: 86400, end: end, style: .constant(.area)).frame(width: 620, height: 230) },
                CatalogVariant("Bars") { NativeTimeSeriesChart(points: values, interval: 3600, initialWindow: 86400, end: end, style: .constant(.bars)).frame(width: 620, height: 230) },
                CatalogVariant("Line") { NativeTimeSeriesChart(points: values, interval: 3600, initialWindow: 86400, end: end, style: .constant(.line)).frame(width: 620, height: 230) },
                CatalogVariant("Empty") { NativeTimeSeriesChart(points: [], interval: 3600, initialWindow: 86400, end: end).frame(width: 620, height: 230) },
            ])])
    }

    static var heatmap: CatalogEntry {
        let cells = (0..<21).map { NativeHeatmapCell(row: $0 / 7, column: $0 % 7, value: Double(($0 * 3) % 11)) }
        return CatalogEntry(id: "heatmap", group: "Charts", name: "Matrix heatmap", summary: "A grid compares intensity while every cell retains its row, column and exact value for accessibility.",
            source: "GenesisKit/Charts/NativeCharts.swift", critique: ["Colour intensity alone cannot carry the exact value.", "Zero must remain distinct from missing cells."],
            sections: [CatalogSection("Data and empty grid", flow: .column, [
                CatalogVariant("Activity") { NativeMatrixHeatmap(rows: ["Mon", "Tue", "Wed"], columns: (9...15).map(String.init), cells: cells).frame(width: 560) },
                CatalogVariant("Empty") { NativeMatrixHeatmap(rows: ["Mon", "Tue", "Wed"], columns: (9...15).map(String.init), cells: []).frame(width: 560) },
            ])])
    }

    static var categories: CatalogEntry {
        CatalogEntry(id: "category-chart", group: "Charts", name: "Category chart", summary: "Horizontal bars leave room for names and show their exact values beside the bars.",
            source: "GenesisKit/Charts/NativeCharts.swift", critique: ["Keep labels readable for long category names.", "A zero value must not disappear from the comparison."],
            sections: [CatalogSection("Values and label length", flow: .column, [
                CatalogVariant("Categories") { NativeCategoryChart(values: [.init(label: "Playback", value: 42), .init(label: "Transcript review", value: 18), .init(label: "Longer category name", value: 6), .init(label: "No activity", value: 0)]).frame(width: 560) },
                CatalogVariant("Empty") { NativeCategoryChart(values: []).frame(width: 560) },
            ])])
    }
}

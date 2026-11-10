import Foundation

/// A redesign shown as real views before anyone picks it (hub UX wave 2, 2026-11-10). Each area of the hub that is being
/// redesigned asks `DesignSketch.option("<area>")` and draws option "a" or "b" instead of its current view when the run
/// was started with `--sketch <area>=<a|b>`; `--sketch` may repeat for several areas. Without the flag every area draws
/// its current view.
///
/// The choice lives in the command line of one run and nothing is stored, so a snapshot run
/// (`GenesisTools --hub … --snapshot out.png --sketch prDetail=a`, or `--features --page … --sketch …`) never changes the
/// user's settings, and the hub they have open never shows a sketch.
public enum DesignSketch {
    private static let options: [String: String] = parse(ProcessInfo.processInfo.arguments)

    /// The option the run picked for `area` ("a", "b"), or nil for the current view.
    public static func option(_ area: String) -> String? {
        options[area]
    }

    /// Every `--sketch <area>=<option>` pair in `arguments`; a later pair for the same area wins.
    static func parse(_ arguments: [String]) -> [String: String] {
        var picked: [String: String] = [:]
        for (index, argument) in arguments.enumerated() where argument == "--sketch" && arguments.indices.contains(index + 1) {
            let pair = arguments[index + 1].split(separator: "=", maxSplits: 1).map(String.init)
            if pair.count == 2, !pair[0].isEmpty, !pair[1].isEmpty {
                picked[pair[0]] = pair[1]
            }
        }
        return picked
    }
}

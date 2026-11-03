import Foundation

/// Line-based two-way diff and three-way (diff3) merge for the markdown
/// editors. Pure Swift on a hand-written Myers diff (`edits(from:to:)`),
/// no dependency, no shell. `/usr/bin/diff3 -m` is the oracle in the tests.
///
/// The merge follows "A formal investigation of diff3" (Khanna, Kunal,
/// Pierce): align the base with each side, walk the three in lockstep, emit
/// stable runs where all three agree, and resolve each unstable run by whichever
/// side changed. Both sides changed differently = conflict.
enum TextMerge {
    // MARK: - Lines

    /// Splits keeping the information whether the text ended with a newline,
    /// so a merge never adds or drops the trailing newline by accident.
    struct Lines: Equatable {
        var lines: [Substring]
        var trailingNewline: Bool

        init(_ text: String) {
            var parts = text.split(separator: "\n", omittingEmptySubsequences: false)
            trailingNewline = text.hasSuffix("\n")
            if trailingNewline { parts.removeLast() }
            if text.isEmpty { parts = [] }
            lines = parts
        }

        static func join(_ lines: [Substring], trailingNewline: Bool) -> String {
            let body = lines.joined(separator: "\n")
            return trailingNewline && !lines.isEmpty ? body + "\n" : body
        }
    }

    // MARK: - Two-way diff (for the compare view)

    enum DiffLine: Equatable {
        case equal(Substring)
        case removed(Substring)
        case inserted(Substring)
    }

    /// Old on the left, new on the right, in one interleaved stream: removals
    /// come before the insertions that replace them.
    static func diff(old: String, new: String) -> [DiffLine] {
        let a = Lines(old).lines
        let b = Lines(new).lines
        let (removed, inserted) = edits(from: a, to: b)
        var out: [DiffLine] = []
        var i = 0, j = 0
        while i < a.count || j < b.count {
            if i < a.count, removed.contains(i) {
                out.append(.removed(a[i])); i += 1
            } else if j < b.count, inserted.contains(j) {
                out.append(.inserted(b[j])); j += 1
            } else {
                out.append(.equal(a[i])); i += 1; j += 1
            }
        }
        return out
    }

    // MARK: - Three-way merge

    enum Region: Equatable {
        /// Lines all three sides agree on, or a change from exactly one side.
        case clean([Substring])
        /// Both sides changed the same base lines differently.
        case conflict(base: [Substring], ours: [Substring], theirs: [Substring])
    }

    struct Result: Equatable {
        var regions: [Region]
        var conflictCount: Int { regions.reduce(0) { $0 + ($1.isConflict ? 1 : 0) } }
        var isClean: Bool { conflictCount == 0 }

        /// The merged text. Conflicts are written with git-style markers,
        /// labelled so the reader knows which side is which.
        func text(trailingNewline: Bool, oursLabel: String = "mine", theirsLabel: String = "on disk") -> String {
            var lines: [Substring] = []
            for region in regions {
                switch region {
                case .clean(let l):
                    lines += l
                case .conflict(_, let o, let t):
                    lines.append(Substring("<<<<<<< \(oursLabel)"))
                    lines += o
                    lines.append(Substring("======="))
                    lines += t
                    lines.append(Substring(">>>>>>> \(theirsLabel)"))
                }
            }
            return Lines.join(lines, trailingNewline: trailingNewline)
        }
    }

    /// `base` is what both sides started from (the text as last loaded or
    /// saved), `ours` the editor buffer, `theirs` the file on disk now.
    static func merge(base: String, ours: String, theirs: String) -> Result {
        let b = Lines(base).lines, o = Lines(ours).lines, t = Lines(theirs).lines
        let mo = matching(base: b, other: o)
        let mt = matching(base: b, other: t)

        var regions: [Region] = []
        var stable: [Substring] = []
        var i = 0, j = 0, k = 0
        func flushStable() {
            if !stable.isEmpty { regions.append(.clean(stable)); stable = [] }
        }
        while i < b.count || j < o.count || k < t.count {
            if i < b.count, mo[i] == j, mt[i] == k {
                stable.append(b[i]); i += 1; j += 1; k += 1
                continue
            }
            // Unstable run: up to the next base line matched on both sides.
            var end = i
            while end < b.count, !(mo[end] != nil && mt[end] != nil) { end += 1 }
            let jEnd = end < b.count ? mo[end]! : o.count
            let kEnd = end < b.count ? mt[end]! : t.count
            let bs = Array(b[i..<end]), os = Array(o[j..<jEnd]), ts = Array(t[k..<kEnd])
            flushStable()
            if os == ts {
                regions.append(.clean(os))
            } else if os == bs {
                regions.append(.clean(ts))
            } else if ts == bs {
                regions.append(.clean(os))
            } else {
                regions.append(.conflict(base: bs, ours: os, theirs: ts))
            }
            i = end; j = jEnd; k = kEnd
        }
        flushStable()
        return Result(regions: regions.mergedClean())
    }

    /// The shortest edit script from `a` to `b` by Myers' greedy forward search (1986): the old indexes it removes
    /// and the new indexes it inserts. Where several scripts are equally short, the textbook rule picks one; it keeps
    /// the blank line after a changed paragraph matched, so "one paragraph changed, the next one removed" stays two
    /// hunks and the rendered diff can pair the changed paragraph word by word. Not the standard library's
    /// `difference(from:)`: its pick among equally short scripts is unspecified, and it changed with the Xcode 27.2
    /// toolchain to merge both paragraphs into one changed hunk.
    static func edits<T: Equatable>(from a: [T], to b: [T]) -> (removed: Set<Int>, inserted: Set<Int>) {
        let n = a.count, m = b.count
        if n == 0 || m == 0 { return (Set(0..<n), Set(0..<m)) }
        let mid = n + m + 1
        var v = [Int](repeating: 0, count: 2 * mid + 1)
        // trace[d] is v[k] for k in -d...d after round d, at index k + d.
        var trace: [[Int]] = []
        search: for d in 0...(n + m) {
            for k in stride(from: -d, through: d, by: 2) {
                var x = k == -d || (k != d && v[mid + k - 1] < v[mid + k + 1]) ? v[mid + k + 1] : v[mid + k - 1] + 1
                var y = x - k
                while x < n, y < m, a[x] == b[y] {
                    x += 1
                    y += 1
                }
                v[mid + k] = x
                if x >= n, y >= m {
                    trace.append(Array(v[(mid - d)...(mid + d)]))
                    break search
                }
            }
            trace.append(Array(v[(mid - d)...(mid + d)]))
        }
        var removed = Set<Int>(), inserted = Set<Int>()
        var x = n, y = m
        for d in stride(from: trace.count - 1, to: 0, by: -1) {
            let k = x - y, prev = trace[d - 1]
            let down = k == -d || (k != d && prev[k - 1 + d - 1] < prev[k + 1 + d - 1])
            let pk = down ? k + 1 : k - 1
            let px = prev[pk + d - 1], py = px - pk
            if down { inserted.insert(py) } else { removed.insert(px) }
            x = px
            y = py
        }
        return (removed, inserted)
    }

    /// base index → other index for every line the two-way diff kept.
    private static func matching(base: [Substring], other: [Substring]) -> [Int?] {
        let (removed, inserted) = edits(from: base, to: other)
        var map = [Int?](repeating: nil, count: base.count)
        var j = 0
        for i in 0..<base.count {
            if removed.contains(i) { continue }
            while j < other.count, inserted.contains(j) { j += 1 }
            map[i] = j
            j += 1
        }
        return map
    }
}

private extension TextMerge.Region {
    var isConflict: Bool {
        if case .conflict = self { return true }
        return false
    }
}

private extension Array where Element == TextMerge.Region {
    /// Adjacent clean regions are one region; only conflicts split the text.
    func mergedClean() -> [TextMerge.Region] {
        var out: [TextMerge.Region] = []
        for r in self {
            if case .clean(let l) = r, case .clean(let prev)? = out.last {
                out[out.count - 1] = .clean(prev + l)
            } else if case .clean(let l) = r, l.isEmpty {
                continue
            } else {
                out.append(r)
            }
        }
        return out
    }
}

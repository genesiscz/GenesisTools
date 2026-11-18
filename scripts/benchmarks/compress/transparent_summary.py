#!/usr/bin/env python3
"""Summarize a fresh transparent benchmark using only observations in its JSON files."""
import argparse
from collections import defaultdict
import json
from pathlib import Path

from _run import KINDS, require_corpus


def distribution(values):
    ordered = sorted(values)
    quantiles = []
    for fraction in (0.1, 0.5, 0.9):
        position = fraction * (len(ordered) - 1)
        lower = int(position)
        upper = min(lower + 1, len(ordered) - 1)
        quantiles.append(ordered[lower] + (position - lower) * (ordered[upper] - ordered[lower]))
    return f"{len(ordered)}: " + " / ".join(f"{number:.2f}" for number in quantiles)


def report(root):
    for filename in ('results.json', 'writers.json'):
        source = root / filename
        if filename == 'writers.json' and not source.exists():
            print('No supplementary writer results.')
            continue
        data = json.loads(source.read_text())
        if not data.get('complete'):
            raise ValueError(f'Incomplete benchmark: {filename}')
        groups = defaultdict(list)
        for row in data['rows']:
            groups[row.get('algorithm', 'ditto')].append(row)
        for writer, rows in groups.items():
            by_kind = {kind: [r for r in rows if r['kind'] == kind] for kind in KINDS}
            require_corpus(by_kind)
            print(f'\n{writer} (n: p10 / p50 / p90). Times in ms, allocation in bytes.')
            print('kind\tlogical\ton disk\tafter\tretained %\tcompress\tcmp\tcat plain\tcat compressed\tappend+fsync')
            for kind, sample in [('all', rows), *by_kind.items()]:
                plain = [r['plain']['allocated'] for r in sample]
                packed = [r['compressed']['allocated'] for r in sample]
                def timings(key, arm=None):
                    return distribution([v['elapsed_ms'] for r in sample for v in r[key]
                                         if arm is None or v['arm'] == arm])
                print(kind, sum(r['plain']['size'] for r in sample), sum(plain), sum(packed),
                      distribution([100 * after / before for after, before in zip(packed, plain)]),
                      timings('compression'), timings('cmp'), timings('reads', 'plain'),
                      timings('reads', 'compressed'), timings('append'), sep='\t')
            for arm in ('plain', 'compressed'):
                timings = [v['elapsed_ms'] for v in data['search']
                           if v.get('algorithm', 'ditto') == writer and v['arm'] == arm]
                print(f'rg {arm} (whole corpus, ms): {distribution(timings)}')
            clones = [trial for row in rows for trial in row['append']]
            print(f'Verified append bytes: {len(clones)}; clones compressed before append: '
                  f'{sum(bool(trial["before"]["flags"] & 32) for trial in clones)}.')
        for row in data['boundaries']:
            print('boundary', row.get('algorithm', 'ditto'), row['size'], 'bytes, flag',
                  row['after']['flags'], 'allocated', row['after']['allocated'],
                  'exit', row['operation']['exit'], row['operation']['stderr'].strip())


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--scratch', required=True, type=Path)
    report(parser.parse_args().scratch)

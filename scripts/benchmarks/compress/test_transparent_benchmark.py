import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

from _run import APPEND, KINDS, append_trial, digest, require_corpus, search_trials
from transparent_summary import distribution, report


class BenchmarkTest(unittest.TestCase):
    def test_requires_five_files_in_every_kind(self):
        selected = {kind: list(range(5)) for kind in KINDS}
        require_corpus(selected)
        selected['grok'].pop()
        with self.assertRaisesRegex(ValueError, "'grok': 4"):
            require_corpus(selected)

    def test_reports_sample_counts_and_interpolated_percentiles(self):
        self.assertEqual(distribution([10, 1, 4]), '3: 1.60 / 4.00 / 8.80')
        self.assertEqual(distribution([7]), '1: 7.00 / 7.00 / 7.00')

    def test_directory_search_pairs_the_same_names_and_alternates_arms(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            source = root / 'fixture'
            source.write_bytes(b'fixture')
            with patch('_run.run', return_value=dict(elapsed_ms=1)) as rg:
                trials = search_trials(root / 'rg', [('one', source, source)])
            self.assertEqual([t['arm'] for t in trials], ['plain', 'compressed', 'compressed', 'plain', 'plain', 'compressed'])
            for call in rg.call_args_list:
                directory = call.args[0][-1]
                self.assertTrue(os.path.samefile(directory / 'one', source))
                self.assertEqual(call.kwargs['ok'], (1,))

    def test_append_checks_the_entire_clone_and_original(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            original = root / 'source'
            original.write_bytes(b'original')
            clone = root / 'clone'
            def copy(_):
                clone.write_bytes(original.read_bytes())
            with patch('_run.run', side_effect=copy):
                result = append_trial(original, clone, digest(original, APPEND), lambda _: {'flags': 0})
                self.assertEqual(clone.read_bytes(), b'original' + APPEND)
                self.assertEqual(original.read_bytes(), b'original')
                self.assertEqual(result['after']['flags'], 0)
                with self.assertRaisesRegex(ValueError, 'byte verification'):
                    append_trial(original, clone, 'wrong', lambda _: {'flags': 0})

    def test_report_refuses_partial_checkpoint(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            (root / 'results.json').write_text(json.dumps({'rows': []}))
            with self.assertRaisesRegex(ValueError, 'Incomplete benchmark'):
                report(root)

    def test_report_uses_only_the_supplied_writer_rows(self):
        row = dict(plain=dict(size=20, allocated=16), compressed=dict(allocated=4),
                   compression=[dict(elapsed_ms=2)], cmp=[dict(elapsed_ms=1)],
                   append=[dict(elapsed_ms=4, before=dict(flags=32))],
                   reads=[dict(arm=arm, elapsed_ms=7) for arm in ('plain', 'compressed')])
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            rows = [dict(row, kind=kind) for kind in KINDS for _ in range(5)]
            (root / 'results.json').write_text(json.dumps(dict(
                complete=True, rows=rows, search=row['reads'], boundaries=[])))
            result = io.StringIO()
            with redirect_stdout(result):
                report(root)
            self.assertIn('all\t700\t560\t140\t35: 25.00 / 25.00 / 25.00', result.getvalue())
            self.assertIn('Verified append bytes: 35', result.getvalue())
            self.assertIn('No supplementary writer results.', result.getvalue())

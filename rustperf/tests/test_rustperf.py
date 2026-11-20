import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from rustperf import Config, RunError, assess, criterion_results, main, read_history


CONFIG_TEXT = '''
bench = "vowels"
editable = ["src/count.rs"]
primary = "typical"
protected = ["small"]
max_trials = 3
'''


def timing(mean, uncertainty=0):
    return {"low": mean - uncertainty, "mean": mean, "high": mean + uncertainty}


def estimates(primary, guard, uncertainty=0):
    return {"typical": timing(primary, uncertainty), "small": timing(guard, uncertainty)}


class DecisionTests(unittest.TestCase):
    def test_decision_uses_fixed_baseline_and_incumbent(self):
        config = Config.parse(CONFIG_TEXT)
        baseline = estimates(100, 100)
        incumbent = estimates(85, 101)
        for label, candidate, expected_status, expected_target in (
            ("win", estimates(75, 101), "accepted", True),
            ("smaller win", estimates(84, 100), "accepted", False),
            ("beats baseline only", estimates(90, 100), "no-win", False),
            ("clear slowdown", estimates(70, 105), "regression", False),
            ("noisy slowdown", estimates(70, 103, 1), "inconclusive", False),
            ("noisy gain", estimates(84, 100, 1), "inconclusive", False),
        ):
            with self.subTest(label=label):
                result = assess(config, baseline, incumbent, candidate)
                self.assertEqual(result["status"], expected_status)
                self.assertEqual(result["target_met"], expected_target)

    def test_config_rejects_bad_inputs(self):
        for text in (
            CONFIG_TEXT.replace("src/count.rs", "../count.rs"),
            CONFIG_TEXT.replace('protected = ["small"]', 'protected = ["typical"]'),
            CONFIG_TEXT.replace('bench = "vowels"', 'bench = "--help"'),
            CONFIG_TEXT + '\nmin_speedup = nan',
        ):
            with self.subTest(text=text), self.assertRaises(RunError):
                Config.parse(text)

    def test_criterion_uses_full_id_and_rejects_invalid_data(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "group" / "sanitized_name" / "new"
            output.mkdir(parents=True)
            (output / "benchmark.json").write_text(json.dumps({"full_id": "group/name with spaces"}))
            report = output / "estimates.json"
            report.write_text(json.dumps({"mean": {"point_estimate": 100, "confidence_interval": {"lower_bound": 99, "upper_bound": 101}}}))
            self.assertEqual(criterion_results(Path(directory)), {"group/name with spaces": timing(100, 1)})
            report.write_text('{"mean":{}}')
            with self.assertRaisesRegex(RunError, "invalid Criterion output"):
                criterion_results(Path(directory))


class RunnerTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        (self.root / "src").mkdir()
        self.source = self.root / "src/count.rs"
        self.source.write_text("baseline\n")
        (self.root / "rustperf.toml").write_text(CONFIG_TEXT)
        self.fixture = self.root / "fixture.txt"
        self.fixture.write_text("trusted\n")
        (self.root / ".gitignore").write_text("ignored.txt\n")
        self.git("init", "-q")
        self.git("add", ".")
        self.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "baseline")
        self.session = self.root / ".git/rustperf/test"

    def git(self, *args):
        subprocess.run(["git", *args], cwd=self.root, check=True, capture_output=True)

    def command(self, *args):
        output = io.StringIO()
        errors = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            result = main(["--repo", str(self.root), "--session", "test", *args])
        return result, output.getvalue() + errors.getvalue()

    def test_lifecycle_with_isolated_source_and_locked_inputs(self):
        (self.root / "ignored.txt").write_text("local\n")
        (self.root / "src/count.rs").write_text("dirty\n")
        self.assertIn("commit or stash", self.command("baseline")[1])
        self.source.write_text("baseline\n")
        with patch("rustperf.measure", side_effect=self.fake_measure) as measure:
            self.assertEqual(self.command("baseline")[0], 0)
            self.assertEqual(self.command("baseline")[0], 1)
            self.source.write_text("candidate\n")
            self.assertEqual(self.command("trial", "--hypothesis", "remove wasted work")[0], 0)

            self.fixture.write_text("tampered\n")
            self.git("add", "fixture.txt")
            self.fixture.write_text("trusted\n")
            result, output = self.command("trial", "--hypothesis", "try changing a staged fixture")
            self.assertEqual(result, 1)
            self.assertIn("fixture.txt", output)
            self.git("reset", "--", "fixture.txt")

            self.source.write_text("broken\n")
            self.assertEqual(self.command("trial", "--hypothesis", "a broken candidate")[0], 1)

            result, output = self.command("trial", "--hypothesis", "over budget")
            self.assertEqual(result, 1)
            self.assertIn("budget exhausted", output)
            self.assertEqual(measure.call_count, 3)
        history = read_history(self.session)
        self.assertEqual([event["status"] for event in history], ["baseline", "accepted", "failed", "failed"])
        self.assertTrue(history[1]["target_met"])
        saved_patch = self.session / history[1]["artifacts"] / "candidate.patch"
        self.assertIn("+candidate", saved_patch.read_text())
        self.assertIn("Best: trial 1", self.command("status")[1])
        self.assertEqual(self.source.read_text(), "broken\n")

    def fake_measure(self, checkout, session, artifacts, config, expected_stamp=None):
        self.assertNotEqual(self.root, checkout)
        self.assertFalse((checkout / "ignored.txt").exists())
        self.assertEqual((checkout / "fixture.txt").read_text(), "trusted\n")
        source = (checkout / "src/count.rs").read_text().strip()
        stamp = {"toolchain": "test"}
        if source == "baseline":
            self.assertIsNone(expected_stamp)
            return stamp, estimates(100, 100)
        self.assertEqual(expected_stamp, stamp)
        if source == "broken":
            raise subprocess.CalledProcessError(101, "cargo test")
        self.assertEqual(source, "candidate")
        return stamp, estimates(70, 100)


if __name__ == "__main__":
    unittest.main()

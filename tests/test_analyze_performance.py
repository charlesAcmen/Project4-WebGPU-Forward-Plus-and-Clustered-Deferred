"""Synthetic capture matrices for the Python performance-analysis contract."""

import csv
import json
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

from analyze_performance import (  # noqa: E402
    aggregate_trials,
    comparison_key,
    load_batch_manifest,
    load_trials,
    series_by_mode_and_strategy,
    summarize,
)


def write_trial(root, scenario_id, stamp, mode, strategy, lights, gpu_values, *, status="complete"):
    trial = root / scenario_id
    trial.mkdir(parents=True)
    metadata = {
        "schemaVersion": 2,
        "sessionId": "synthetic-session",
        "scenarioId": scenario_id,
        "startedAt": stamp,
        "status": status,
        "invalidReason": "synthetic invalid" if status != "complete" else None,
        "condition": {
            "mode": mode, "strategy": strategy, "lights": lights,
            "width": 1280, "height": 720, "dpr": 1,
            "camera": {"position": [0, 0, 0], "yaw": 0, "pitch": 0},
            "cluster": {"tilesX": 20, "tilesY": 12, "depthSlices": 24,
                        "maxLightsPerCluster": 128, "poolCapacity": 737280},
        },
        "droppedGpuSamples": 0,
        "clusterDiagnostic": None,
        "environment": {"browser": "synthetic-browser", "timeZone": "Asia/Shanghai"},
        "samplesFile": f"{scenario_id}.csv",
    }
    (trial / f"{scenario_id}.json").write_text(json.dumps(metadata), encoding="utf-8")
    with (trial / f"{scenario_id}.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["renderer_gpu_ms", "gpu_passes_json"])
        writer.writeheader()
        for value in gpu_values:
            writer.writerow({"renderer_gpu_ms": value, "gpu_passes_json": '{"geometry": 1}'})


class AnalysisMatrixTest(unittest.TestCase):
    def test_six_trials_across_modes_strategies_and_repeats(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            scenarios = [
                "fixed-forward-plus-a", "fixed-forward-plus-b", "adaptive-forward-plus",
                "fixed-clustered-deferred", "fixed-visibility-buffer", "naive", "invalid-naive",
            ]
            (directory / "batch.json").write_text(json.dumps({
                "batchSchemaVersion": 1,
                "kind": "performance-batch",
                "sessionId": "synthetic-session",
                "scenarios": [{"id": scenario} for scenario in scenarios],
            }), encoding="utf-8")
            write_trial(directory, "fixed-forward-plus-a", "2026-09-22_11-00-00", "forward+", "fixed", 50, [2, 4])
            write_trial(directory, "fixed-forward-plus-b", "2026-09-22_11-01-00", "forward+", "fixed", 50, [4, 6])
            write_trial(directory, "adaptive-forward-plus", "2026-09-22_11-02-00", "forward+", "adaptive", 50, [3, 5])
            write_trial(directory, "fixed-clustered-deferred", "2026-09-22_11-03-00", "clustered deferred (base)", "fixed", 50, [5, 7])
            write_trial(directory, "fixed-visibility-buffer", "2026-09-22_11-04-00", "visibility buffer (compute reconstruction)", "fixed", 50, [6, 8])
            write_trial(directory, "naive", "2026-09-22_11-05-00", "naive", "none", 25, [7, 9])
            write_trial(directory, "invalid-naive", "2026-09-22_11-06-00", "naive", "none", 25, [9, 11], status="invalid")
            (directory / "broken.json").write_text("", encoding="utf-8")

            manifest = load_batch_manifest(directory)
            trials = load_trials(directory, {scenario["id"] for scenario in manifest["scenarios"]})
            rows = summarize(trials)
            aggregates = aggregate_trials(rows)
            series = series_by_mode_and_strategy(rows)

            self.assertEqual(len(trials), 6)
            self.assertEqual(len({comparison_key(trial["meta"]) for trial in trials}), 1)
            self.assertEqual(len(series), 5)
            self.assertEqual(len(aggregates), 5)
            forward_fixed = next(row for row in aggregates
                                 if row["mode"] == "forward+" and row["strategy"] == "fixed")
            self.assertEqual(forward_fixed["repeats"], 2)
            self.assertEqual(forward_fixed["median_of_trial_medians_ms"], 4)

    def test_manifest_validation_rejects_missing_or_malformed_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            with self.assertRaisesRegex(ValueError, "Expected batch.json"):
                load_batch_manifest(directory)

            (directory / "batch.json").write_text(json.dumps({"kind": "other"}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "not a supported performance-batch manifest"):
                load_batch_manifest(directory)

            (directory / "batch.json").write_text(json.dumps({
                "kind": "performance-batch",
                "batchSchemaVersion": 1,
                "scenarios": [{"id": 42}],
            }), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "no valid scenario list"):
                load_batch_manifest(directory)

    def test_load_trials_rejects_samples_outside_trial_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            trial_directory = directory / "trial"
            trial_directory.mkdir()
            metadata = {
                "schemaVersion": 2,
                "sessionId": "synthetic-session",
                "scenarioId": "trial",
                "status": "complete",
                "samplesFile": "../samples.csv",
            }
            (trial_directory / "trial.json").write_text(json.dumps(metadata), encoding="utf-8")
            (directory / "samples.csv").write_text("renderer_gpu_ms\n1\n", encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "Missing or unsafe samples file"):
                load_trials(directory, {"trial"})

    def test_load_trials_skips_complete_trial_without_gpu_samples(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            write_trial(directory, "empty", "2026-09-22_12-00-00", "naive", "none", 25, [])

            trials = load_trials(directory, {"empty"})

            self.assertEqual(trials, [])

    def test_comparison_key_supports_version_one_user_agent(self):
        meta = {
            "sessionId": "session",
            "condition": {
                "width": 1280,
                "height": 720,
                "dpr": 1,
                "camera": {"position": [0, 0, 0]},
                "cluster": {"tilesX": 20},
            },
            "environment": {"userAgent": "legacy-browser"},
        }

        key = json.loads(comparison_key(meta))

        self.assertEqual(key["browser"], "legacy-browser")


if __name__ == "__main__":
    unittest.main()

"""Analyze one browser capture session without modifying its raw trial files.

Usage: python scripts/analyze_performance.py path/to/SESSION
Optional: pip install matplotlib (for PNG charts).
"""

import argparse
import csv
import json
import math
import statistics
from collections import defaultdict
from pathlib import Path


def percentile(values, fraction):
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * fraction) - 1)]


def comparison_key(meta):
    condition = meta["condition"]
    environment = meta["environment"]
    return json.dumps({
        "session": meta["sessionId"],
        "resolution": [condition["width"], condition["height"], condition["dpr"]],
        "camera": condition["camera"],
        "cluster": condition["cluster"],
        # Version 1 recorded userAgent; version 2 uses the clearer browser key.
        "browser": environment.get("browser", environment.get("userAgent", "unknown")),
    }, sort_keys=True)


def load_batch_manifest(directory):
    manifest_path = directory / "batch.json"
    if not manifest_path.is_file():
        raise ValueError("Expected batch.json in the selected capture-session directory")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError(f"Unreadable batch.json: {error.msg}") from error
    if manifest.get("kind") != "performance-batch" or manifest.get("batchSchemaVersion") != 1:
        raise ValueError("batch.json is not a supported performance-batch manifest")
    scenarios = manifest.get("scenarios")
    if not isinstance(scenarios, list) or not all(isinstance(item, dict) and isinstance(item.get("id"), str)
                                                  for item in scenarios):
        raise ValueError("batch.json has no valid scenario list")
    return manifest


def load_trials(directory, expected_scenario_ids):
    trials = []
    # Raw captures are nested as MODE/LOCAL-TIMESTAMP/MODE.json. The metadata,
    # rather than the shortened filename, remains the source of truth for mode.
    for path in sorted(directory.rglob("*.json")):
        try:
            meta = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            print(f"Skipping unreadable metadata: {path.name} ({error.msg})")
            continue
        if meta.get("kind") == "performance-batch":
            continue
        if meta.get("schemaVersion") not in (1, 2):
            continue
        scenario_id = meta.get("scenarioId")
        if scenario_id not in expected_scenario_ids:
            print(f"Skipping trial outside batch manifest: {path.name}")
            continue
        if meta["status"] != "complete":
            print(f"Skipping invalid trial: {path.name} ({meta.get('invalidReason')})")
            continue
        trial_directory = path.parent.resolve()
        sample_path = (trial_directory / meta["samplesFile"]).resolve()
        if sample_path.parent != trial_directory or not sample_path.is_file():
            raise ValueError(f"Missing or unsafe samples file: {sample_path}")
        with sample_path.open(newline="", encoding="utf-8") as handle:
            samples = list(csv.DictReader(handle))
        gpu = [float(row["renderer_gpu_ms"]) for row in samples if row["renderer_gpu_ms"]]
        if not gpu:
            print(f"Skipping trial without GPU samples: {path.name}")
            continue
        passes = defaultdict(list)
        for row in samples:
            if row["gpu_passes_json"]:
                for name, value in json.loads(row["gpu_passes_json"]).items():
                    passes[name].append(value)
        trials.append({"meta": meta, "gpu": gpu, "samples": samples, "passes": passes})
    return trials


def summarize(trials):
    results = []
    for trial in trials:
        meta = trial["meta"]
        values = trial["gpu"]
        diagnostic = meta.get("clusterDiagnostic") or {}
        results.append({
            "comparison_key": comparison_key(meta),
            "trial": meta["startedAt"],
            "mode": meta["condition"]["mode"],
            "strategy": meta["condition"]["strategy"],
            "lights": meta["condition"]["lights"],
            "gpu_samples": len(values),
            "missing_gpu_samples": len(trial["samples"]) - len(values),
            "dropped_gpu_samples": meta["droppedGpuSamples"],
            "gpu_median_ms": statistics.median(values),
            "gpu_p95_ms": percentile(values, 0.95),
            "gpu_mean_ms": statistics.mean(values),
            "gpu_stdev_ms": statistics.stdev(values) if len(values) > 1 else 0,
            "overflow_clusters": diagnostic.get("overflowClusters", ""),
            "dropped_references": diagnostic.get("droppedReferences", ""),
            "pool_used": diagnostic.get("poolUsed", ""),
            "pool_capacity": diagnostic.get("poolCapacity", ""),
            "pass_medians_json": json.dumps({name: statistics.median(times)
                                                 for name, times in trial["passes"].items()}, sort_keys=True),
        })
    return results


def write_summary(rows, output):
    with output.open("w", newline="", encoding="utf-8") as handle:
        if rows:
            writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
            writer.writeheader()
            writer.writerows(rows)


def aggregate_trials(rows):
    groups = defaultdict(list)
    for row in rows:
        groups[(row["comparison_key"], row["mode"], row["strategy"], row["lights"])].append(row)
    results = []
    for (key, mode, strategy, lights), trials in groups.items():
        medians = [row["gpu_median_ms"] for row in trials]
        results.append({
            "comparison_key": key, "mode": mode, "strategy": strategy, "lights": lights,
            "repeats": len(trials), "median_of_trial_medians_ms": statistics.median(medians),
            "min_trial_median_ms": min(medians), "max_trial_median_ms": max(medians),
            "median_of_trial_p95_ms": statistics.median(row["gpu_p95_ms"] for row in trials),
            "overflow_clusters_median": statistics.median(row["overflow_clusters"] for row in trials
                                                           if row["overflow_clusters"] != "")
            if any(row["overflow_clusters"] != "" for row in trials) else "",
            "dropped_references_median": statistics.median(row["dropped_references"] for row in trials
                                                            if row["dropped_references"] != "")
            if any(row["dropped_references"] != "" for row in trials) else "",
        })
    return results


def series_by_mode_and_strategy(rows):
    series = defaultdict(lambda: defaultdict(list))
    for row in rows:
        series[(row["mode"], row["strategy"])][row["lights"]].append(row)
    return series


def short_mode_name(mode):
    return {
        "naive": "Naive",
        "forward+": "Forward+",
        "clustered deferred (base)": "Deferred base",
        "clustered deferred (packed compute)": "Deferred optimized",
        "visibility buffer (compute reconstruction)": "Visibility buffer",
    }.get(mode, mode)


def series_label(mode, strategy):
    return short_mode_name(mode) if strategy == "none" else f"{short_mode_name(mode)} · {strategy}"


def configuration_subtitle(condition):
    cluster = condition["cluster"]
    width, height, dpr = condition["resolution"]
    return (f"{width} × {height} px · DPR {dpr} · "
            f"clusters {cluster['tilesX']} × {cluster['tilesY']} × {cluster['depthSlices']} · "
            f"fixed list cap {cluster['maxLightsPerCluster']}")


def plot_groups(rows, output):
    try:
        import matplotlib.pyplot as plt
    except ImportError:
        print("matplotlib not installed: summary.csv created; skipping charts.")
        return
    groups = defaultdict(list)
    for row in rows:
        groups[row["comparison_key"]].append(row)
    for index, group in enumerate(groups.values(), 1):
        condition = json.loads(group[0]["comparison_key"])
        by_series = series_by_mode_and_strategy(group)
        fig, ax = plt.subplots(figsize=(11, 6.5))
        for (mode, strategy), light_groups in sorted(by_series.items()):
            xs = sorted(light_groups)
            ys = [statistics.median(r["gpu_median_ms"] for r in light_groups[n]) for n in xs]
            label = series_label(mode, strategy)
            ax.plot(xs, ys, marker="o", label=label)
            p95 = [statistics.median(r["gpu_p95_ms"] for r in light_groups[n]) for n in xs]
            ax.plot(xs, p95, linestyle="--", alpha=0.55, label="_nolegend_")
        for budget in (8.33, 16.67, 33.33):
            ax.axhline(budget, color="gray", alpha=0.35, linestyle="--")
        ax.set(xlabel="Light count", ylabel="Renderer GPU time (ms)")
        ax.grid(axis="y", alpha=0.25)
        fig.suptitle("GPU time by renderer, strategy, and light count", y=0.98, fontsize=15)
        ax.set_title(configuration_subtitle(condition), fontsize=9, pad=12)
        ax.legend(fontsize="small", ncol=2)
        ax.text(0.01, 0.98, "Solid: median   Dashed: p95", transform=ax.transAxes,
                va="top", fontsize=9, color="dimgray")
        fig.tight_layout(rect=(0, 0, 1, 0.90))
        fig.savefig(output / f"gpu_vs_lights_{index}.png", dpi=160)
        plt.close(fig)
        if any(row["overflow_clusters"] != "" for row in group):
            fig, axes = plt.subplots(2, 1, figsize=(10, 8), sharex=True)
            for ax, field, ylabel in zip(axes, ("overflow_clusters", "dropped_references"),
                                         ("Overflow clusters", "Dropped light references")):
                for (mode, strategy), light_groups in sorted(by_series.items()):
                    points = [(n, statistics.median(r[field] for r in records if r[field] != ""))
                              for n, records in sorted(light_groups.items())
                              if any(r[field] != "" for r in records)]
                    if points:
                        ax.plot(*zip(*points), marker="o", label=series_label(mode, strategy))
                ax.set(ylabel=ylabel)
                ax.legend(fontsize="small")
            axes[-1].set_xlabel("Lights")
            fig.suptitle(f"Cluster capacity diagnostics by light count\n{configuration_subtitle(condition)}")
            fig.tight_layout(rect=(0, 0, 1, 0.91))
            fig.savefig(output / f"cluster_quality_{index}.png", dpi=160)
            plt.close(fig)
        # Make one pass chart for every light count in the capture matrix. The
        # old single chart used min(), which silently reduced a multi-count
        # batch to its smallest scenario.
        legacy_pass_chart = output / f"pass_breakdown_{index}.png"
        legacy_pass_chart.unlink(missing_ok=True)
        for selected_lights in sorted({row["lights"] for row in group}):
            pass_rows = [row for row in group if row["lights"] == selected_lights and
                         json.loads(row["pass_medians_json"])]
            if not pass_rows:
                continue
            labels = sorted({series_label(row['mode'], row['strategy']) for row in pass_rows})
            pass_maps = {label: defaultdict(list) for label in labels}
            for row in pass_rows:
                for name, value in json.loads(row["pass_medians_json"]).items():
                    pass_maps[series_label(row['mode'], row['strategy'])][name].append(value)
            names = sorted({name for values in pass_maps.values() for name in values})
            fig, ax = plt.subplots(figsize=(11, 6))
            bottoms = [0.0] * len(labels)
            for name in names:
                heights = [statistics.median(pass_maps[label][name]) if pass_maps[label][name] else 0
                           for label in labels]
                ax.bar(labels, heights, bottom=bottoms, label=name)
                bottoms = [a + b for a, b in zip(bottoms, heights)]
            ax.set(ylabel="Sum of pass medians (ms)",
                   title=f"Pass breakdown at {selected_lights} lights")
            ax.tick_params(axis="x", labelrotation=20)
            ax.legend(fontsize="small")
            fig.suptitle(configuration_subtitle(condition), y=0.98, fontsize=9)
            fig.tight_layout(rect=(0, 0, 1, 0.93))
            fig.savefig(output / f"pass_breakdown_{index}_{selected_lights}.png", dpi=160)
            plt.close(fig)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path, help="One capture-session directory")
    args = parser.parse_args()
    directory = args.directory.resolve()
    if not directory.is_dir():
        parser.error("Capture directory does not exist")
    try:
        manifest = load_batch_manifest(directory)
    except ValueError as error:
        parser.error(str(error))
    expected_scenario_ids = {scenario["id"] for scenario in manifest["scenarios"]}
    trials = load_trials(directory, expected_scenario_ids)
    if not trials:
        parser.error("No valid GPU trials found")
    output = directory / "analysis"
    output.mkdir(exist_ok=True)
    rows = summarize(trials)
    write_summary(rows, output / "summary.csv")
    write_summary(aggregate_trials(rows), output / "aggregate.csv")
    plot_groups(rows, output)
    print(f"Analyzed {len(trials)} trials from {len(expected_scenario_ids)} selected scenarios "
          f"in {len(set(row['comparison_key'] for row in rows))} comparable groups: {output}")


if __name__ == "__main__":
    main()

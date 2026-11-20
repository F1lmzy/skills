#!/usr/bin/env python3
import argparse
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import tarfile
import tempfile
import tomllib


class RunError(Exception):
    pass


@dataclass(frozen=True)
class Config:
    bench: str
    editable: list[str]
    primary: str
    protected: list[str]
    package: str | None = None
    min_speedup: float = 1.2
    max_regression_pct: float = 3.0
    max_trials: int = 6
    rayon_threads: int = 1

    @classmethod
    def parse(cls, text):
        try:
            config = cls(**tomllib.loads(text))
        except TypeError as error:
            raise RunError(f"invalid rustperf.toml: {error}") from error
        targets = [config.bench] if config.package is None else [config.bench, config.package]
        for name in targets:
            if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_-]*", name):
                raise RunError("bench and package must be Cargo target/package names")
        require_string_list(config.editable, "editable")
        require_string_list(config.protected, "protected")
        if not isinstance(config.primary, str) or not config.primary.strip():
            raise RunError("primary must be a nonempty benchmark ID")
        if config.primary in config.protected:
            raise RunError("primary must be distinct from protected IDs")
        for name in config.editable:
            path = Path(name)
            if (
                path.is_absolute()
                or {"..", ".git"}.intersection(path.parts)
                or name != path.as_posix()
                or path.suffix != ".rs"
            ):
                raise RunError(f"editable entry must be a repository-relative Rust file: {name}")
        if not finite_number(config.min_speedup) or config.min_speedup <= 1:
            raise RunError("min_speedup must be greater than 1")
        if not finite_number(config.max_regression_pct) or config.max_regression_pct < 0:
            raise RunError("max_regression_pct must be nonnegative")
        for key in ("max_trials", "rayon_threads"):
            value = getattr(config, key)
            if type(value) is not int or value < 1:
                raise RunError(f"{key} must be a positive integer")
        return config


def require_string_list(values, key):
    if not isinstance(values, list) or not values:
        raise RunError(f"{key} must be a nonempty array")
    if not all(isinstance(value, str) and value.strip() for value in values):
        raise RunError(f"{key} must contain only nonempty strings")
    if len(set(values)) != len(values):
        raise RunError(f"{key} must not contain duplicates")


def finite_number(value):
    return type(value) in (int, float) and math.isfinite(value)


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args])


def repo_context(directory, session):
    root = Path(os.fsdecode(git(directory, "rev-parse", "--show-toplevel")).rstrip("\n"))
    common_dir = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")
    return root, Path(os.fsdecode(common_dir).rstrip("\n")) / "rustperf" / session


@contextmanager
def lock_session(session):
    session.mkdir(parents=True, exist_ok=True)
    with (session.parent / "runner.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RunError("another rustperf command is active for this repository") from error
        yield


def path_names(output):
    return {os.fsdecode(path) for path in output.split(b"\0") if path}


def check_changes(root, commit, editable):
    changed = path_names(git(root, "diff", "--name-only", "--no-renames", "-z", commit, "--"))
    staged = path_names(git(root, "diff", "--cached", "--name-only", "--no-renames", "-z", commit, "--"))
    untracked = path_names(git(root, "ls-files", "--others", "--exclude-standard", "-z"))
    blocked = ((changed | staged) - set(editable)) | untracked
    if blocked:
        raise RunError(f"changes outside the editable file list: {', '.join(sorted(blocked))}")


def read_source(root, name):
    path = root / name
    if path.resolve() != root.resolve() / name or not path.is_file():
        raise RunError(f"editable file must exist and must not be a symlink: {name}")
    return path.read_bytes()


@contextmanager
def source_snapshot(root, commit, config, candidate):
    with tempfile.TemporaryDirectory(prefix="rustperf-") as temporary:
        archive = Path(temporary) / "source.tar"
        checkout = Path(temporary) / "source"
        checkout.mkdir()
        git(root, "archive", "--format=tar", f"--output={archive}", commit)
        with tarfile.open(archive) as bundle:
            bundle.extractall(checkout, filter="data")
        for name in config.editable:
            read_source(checkout, name)
            if candidate:
                (checkout / name).write_bytes(read_source(root, name))
        yield checkout


def cargo_environment(session, artifacts, config):
    env = os.environ.copy()
    overrides = ("RUSTFLAGS", "RUSTC", "RUSTDOC", "CARGO_ENCODED_RUSTFLAGS", "CARGO_BUILD_", "CARGO_PROFILE_", "CARGO_TARGET_", "CARGO_INCREMENTAL")
    active = sorted(key for key, value in env.items() if value and key.startswith(overrides))
    if active:
        raise RunError(f"unset build environment overrides: {', '.join(active)}")
    env.update(
        CARGO_TARGET_DIR=str(session / "target"),
        CRITERION_HOME=str(artifacts / "criterion"),
        RAYON_NUM_THREADS=str(config.rayon_threads),
    )
    return env


def environment_stamp(checkout, env):
    cargo_home = Path(env.get("CARGO_HOME", str(Path.home() / ".cargo"))).expanduser()
    if not cargo_home.is_absolute():
        raise RunError("CARGO_HOME must be an absolute path")
    cargo_config = {}
    for name in ("config", "config.toml"):
        path = cargo_home / name
        if path.is_file():
            cargo_config[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return {
        "host": list(platform.uname()),
        "cargo": subprocess.check_output(["cargo", "-vV"], cwd=checkout, env=env, text=True).strip(),
        "rustc": subprocess.check_output(["rustc", "-vV"], cwd=checkout, env=env, text=True).strip(),
        "cargo_home": str(cargo_home),
        "cargo_config_sha256": cargo_config,
        "rayon_threads": env["RAYON_NUM_THREADS"],
        "native_build_env": {key: env[key] for key in ("CC", "CXX", "CFLAGS", "CXXFLAGS", "LDFLAGS") if key in env},
    }


def criterion_results(directory):
    results = {}
    for metadata in sorted(directory.glob("**/new/benchmark.json")):
        try:
            label = json.loads(metadata.read_text())["full_id"]
            mean = json.loads(metadata.with_name("estimates.json").read_text())["mean"]
            interval = mean["confidence_interval"]
            estimate = {"low": interval["lower_bound"], "mean": mean["point_estimate"], "high": interval["upper_bound"]}
            if not isinstance(label, str) or label in results:
                raise ValueError(f"invalid or duplicate Criterion ID {label!r}")
            if not all(finite_number(value) for value in estimate.values()):
                raise ValueError(f"nonnumeric timing estimate for {label!r}")
            if not 0 < estimate["low"] <= estimate["mean"] <= estimate["high"]:
                raise ValueError(f"invalid interval for {label!r}")
        except (OSError, KeyError, TypeError, ValueError) as error:
            raise RunError(f"invalid Criterion output at {metadata}: {error}") from error
        results[label] = estimate
    return results


def measure(checkout, session, artifacts, config, expected_stamp=None):
    env = cargo_environment(session, artifacts, config)
    stamp = environment_stamp(checkout, env)
    if expected_stamp is not None and stamp != expected_stamp:
        raise RunError("toolchain, machine or tracked build environment differs from the baseline")
    package = ["-p", config.package] if config.package else []
    with (artifacts / "cargo.log").open("w") as log:
        checks = [
            ["cargo", "test", "--locked", "--release", *package],
            ["cargo", "bench", "--locked", *package, "--bench", config.bench, "--", "--noplot"],
        ]
        for command in checks:
            print(f"$ {' '.join(command)}", file=log, flush=True)
            print(f"Running {' '.join(command)} (log: {artifacts / 'cargo.log'})", flush=True)
            subprocess.run(command, cwd=checkout, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
    estimates = criterion_results(Path(env["CRITERION_HOME"]))
    required = {config.primary, *config.protected}
    if estimates.keys() != required:
        raise RunError(f"Criterion IDs differ from rustperf.toml (expected {sorted(required)}, got {sorted(estimates)})")
    return stamp, estimates


def speedup(reference, candidate):
    return {
        "low": reference["low"] / candidate["high"],
        "mean": reference["mean"] / candidate["mean"],
        "high": reference["high"] / candidate["low"],
    }


def assess(config, baseline, best, candidate):
    against_base = {label: speedup(baseline[label], estimate) for label, estimate in candidate.items()}
    against_best = speedup(best[config.primary], candidate[config.primary])
    safe_ratio = 1 / (1 + config.max_regression_pct / 100)
    guards = {label: against_base[label] for label in config.protected}
    if any(ratio["high"] < safe_ratio for ratio in guards.values()):
        status = "regression"
    elif against_best["high"] <= 1:
        status = "no-win"
    elif against_best["low"] <= 1 or any(ratio["low"] < safe_ratio for ratio in guards.values()):
        status = "inconclusive"
    else:
        status = "accepted"
    return {
        "status": status,
        "speedup_vs_baseline": against_base,
        "primary_speedup_vs_best": against_best,
        "target_met": status == "accepted" and against_base[config.primary]["low"] >= config.min_speedup,
    }


def read_history(session):
    history = session / "experiments.jsonl"
    return [json.loads(line) for line in history.read_text().splitlines()] if history.exists() else []


def log_event(session, event):
    event["at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with (session / "experiments.jsonl").open("a") as history:
        history.write(json.dumps(event, sort_keys=True) + "\n")


def artifacts_for(session, prefix):
    return Path(tempfile.mkdtemp(prefix=f"{prefix}-", dir=session))


def baseline_run(root, session, history):
    if history:
        raise RunError("this session already has a baseline; choose a new --session to start over")
    if git(root, "status", "--porcelain=v1", "--untracked-files=all"):
        raise RunError("commit or stash all staged, modified and untracked files before taking a baseline")
    commit = git(root, "rev-parse", "HEAD").decode().strip()
    config = Config.parse(git(root, "show", f"{commit}:rustperf.toml").decode())
    artifacts = artifacts_for(session, "baseline")
    with source_snapshot(root, commit, config, candidate=False) as checkout:
        stamp, estimates = measure(checkout, session, artifacts, config)
    event = {"status": "baseline", "commit": commit, "config": asdict(config), "environment": stamp, "estimates_ns": estimates, "artifacts": artifacts.name}
    log_event(session, event)
    print(f"Baseline: {commit[:12]} ({session})")
    for label, estimate in sorted(estimates.items()):
        print(f"  {label}: {estimate['mean']:,.2f} ns")
    return 0


def trial_run(root, session, history, hypothesis):
    if not history:
        raise RunError("this session has no baseline; run baseline first")
    if not hypothesis.strip():
        raise RunError("describe the proposed mechanism in --hypothesis")
    baseline = history[0]
    config = Config(**baseline["config"])
    number = len(history)
    if number > config.max_trials:
        raise RunError(f"trial budget exhausted ({config.max_trials}); inspect status for the best result")
    best = next(event for event in reversed(history) if event["status"] in {"accepted", "baseline"})
    commit = baseline["commit"]
    artifacts = artifacts_for(session, f"trial-{number:03d}")
    event = {"trial": number, "hypothesis": hypothesis, "artifacts": artifacts.name, "previous_best": best.get("trial", 0)}
    try:
        check_changes(root, commit, config.editable)
        patch = git(root, "--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--binary", commit, "--", *config.editable)
        if not patch:
            raise RunError("no candidate changes relative to the baseline")
        (artifacts / "candidate.patch").write_bytes(patch)
        with source_snapshot(root, commit, config, candidate=True) as checkout:
            _, estimates = measure(checkout, session, artifacts, config, baseline["environment"])
        event["estimates_ns"] = estimates
        event.update(assess(config, baseline["estimates_ns"], best["estimates_ns"], estimates))
    except (RunError, OSError, ValueError, tarfile.TarError, subprocess.CalledProcessError) as error:
        event.update(status="failed", error=str(error))
    log_event(session, event)
    print_trial(event)
    if event["status"] == "failed":
        return 1
    return 0 if event["status"] == "accepted" else 2


def print_trial(event):
    print(f"Trial {event['trial']}: {event['status']} — {event['hypothesis']}")
    if event.get("error"):
        print(f"  {event['error']}")
        return
    for label, ratio in sorted(event["speedup_vs_baseline"].items()):
        print(f"  {label}: {event['estimates_ns'][label]['mean']:,.2f} ns; {ratio['mean']:.3f}× baseline (bounds {ratio['low']:.3f}–{ratio['high']:.3f})")
    if event["previous_best"]:
        ratio = event["primary_speedup_vs_best"]
        print(f"  Primary vs trial {event['previous_best']}: {ratio['mean']:.3f}× (bounds {ratio['low']:.3f}–{ratio['high']:.3f})")
    if event["target_met"]:
        print("  Primary target confirmed")


def show_status(session, history):
    print(f"Session: {session}")
    if not history:
        print("No baseline")
        return 0
    baseline = history[0]
    print(f"Baseline {baseline['commit'][:12]} | {len(history) - 1}/{baseline['config']['max_trials']} trials used")
    for event in history[1:]:
        print_trial(event)
    best = next(event for event in reversed(history) if event["status"] in {"accepted", "baseline"})
    print(f"Best: trial {best['trial']}" if best["status"] == "accepted" else "Best: baseline")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description="Run bounded, correctness-gated Rust performance experiments")
    parser.add_argument("--repo", type=Path, default=Path.cwd(), help="a directory in the target Git checkout")
    parser.add_argument("--session", default="default", help="experiment session name (default: default)")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("baseline", help="measure the unmodified committed checkout")
    trial = commands.add_parser("trial", help="test the current candidate against the baseline and best trial")
    trial.add_argument("--hypothesis", required=True)
    commands.add_parser("status", help="read the experiment log without benchmarking")
    args = parser.parse_args(argv)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", args.session):
        parser.error("session must contain only letters, numbers, hyphens or underscores and start with a letter or number")
    try:
        root, session = repo_context(args.repo, args.session)
        with lock_session(session):
            history = read_history(session)
            if args.command == "baseline":
                return baseline_run(root, session, history)
            if args.command == "trial":
                return trial_run(root, session, history, args.hypothesis)
            return show_status(session, history)
    except (RunError, OSError, ValueError, tarfile.TarError, subprocess.CalledProcessError) as error:
        print(f"rustperf: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

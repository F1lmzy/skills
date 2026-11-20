# rustperf

An agent skill and dependency-free Python runner for **measured Rust optimization**. It records a fixed baseline, verifies candidate behavior, and keeps an experiment log. There is no static performance score or trained model in this first version.

## Install

Install into your agent's skills directory — `~/.agents/skills/` on Linux and macOS — keeping `SKILL.md`, `rustperf.py`, and this `README.md` together in the folder:

```sh
git clone git@github.com:F1lmzy/skills.git
mkdir -p ~/.agents/skills
cp -R skills/rustperf ~/.agents/skills/rustperf
```

A symlink also works and stays current with the repo:

```sh
ln -s "$(pwd -P)/skills/rustperf" ~/.agents/skills/rustperf
```

Restart your agent session after installing so the skill is picked up.

## Try it

Requires Linux or macOS, Python 3.12+, Git 2.31+, and a Rust toolchain on `PATH`. The bundled example uses Criterion 0.5.1. No Python packages are required.

From this directory:

```sh
runner="$PWD/rustperf.py"
demo=$(mktemp -d)
cp -R examples/vowel_count/. "$demo/"
git -C "$demo" init -q
git -C "$demo" add .
git -C "$demo" -c user.name=Demo -c user.email=demo@example.invalid commit -qm baseline
python3 "$runner" --repo "$demo" baseline
```

Replace `$demo/src/count.rs` with a byte lookup table. The contract counts ASCII vowels only, so non-ASCII UTF-8 bytes cannot match:

```rust
const VOWELS: [u8; 256] = {
    let mut table = [0; 256];
    let vowels = b"aeiouAEIOU";
    let mut index = 0;
    while index < vowels.len() {
        table[vowels[index] as usize] = 1;
        index += 1;
    }
    table
};

pub fn count_ascii_vowels(text: &str) -> usize {
    text.bytes()
        .map(|byte| usize::from(VOWELS[usize::from(byte)]))
        .sum()
}
```

```sh
python3 "$runner" --repo "$demo" trial --hypothesis 'Sum vowel membership using a 256-byte lookup table'
python3 "$runner" --repo "$demo" status
```

In one local run, the lookup table reduced the typical workload from **17.32 µs to 5.07 µs** and passed both protected workloads. A separate candidate using byte comparisons was rejected: it improved the typical case but slowed the small case. Your timings and decisions may differ.

## Use it on a crate

Add a standard Criterion bench with `harness = false`, independent workloads, and integration tests that catch missing or degraded work. Commit `Cargo.lock` and a `rustperf.toml` at the **Git root**. The root must also contain the Cargo manifest or workspace manifest.

```toml
bench = "vowels"                 # name of the [[bench]] target
# package = "my-crate"           # optional selector for a workspace
editable = ["src/count.rs"]      # existing tracked .rs files; never list tests or bench code
primary = "typical"              # Criterion full ID, not the results directory name
protected = ["small", "large"]   # the rest of the benchmark IDs
min_speedup = 1.2                 # target relative to the original baseline
max_regression_pct = 3.0          # allowed increase in mean time on protected workloads
max_trials = 6
rayon_threads = 1
```

Point your agent at the installed skill folder (see [Install](#install)); `<SKILL_DIR>` in `SKILL.md` refers to that folder. Use `--session <name>` before the command to open a separate experiment. A baseline requires a clean checkout. During a trial, only the listed files can change, including if prior accepted edits have been committed. The runner does not commit, revert, or select patches for you.

### What constitutes a win?

- Release tests pass and the frozen benchmark suite emits exactly the configured workload IDs.
- The primary workload is faster than the best accepted trial (or the original baseline if there is none).
- Protected workloads stay within the configured slowdown budget relative to the **original** baseline.

The runner reads Criterion mean estimates and computes conservative ratio bounds by dividing opposite ends of the reported intervals. They are not a joint confidence interval. A patch is accepted only when the bounds clear the gates; ambiguous results are `inconclusive`. Rerun noisy finalists on an idle machine rather than treating a single point estimate as proof. Exit codes: `0` for a successful baseline/status or accepted trial; `2` for a measured trial not accepted; `1` for a failed run or rejected input (argument syntax errors use argparse’s `2`).

Each trial saves its hypothesis, status, timings, ratio bounds, and candidate diff under the Git common directory at `rustperf/<session>/`. `experiments.jsonl` is readable without running Cargo. Raw Criterion output and the Cargo log are stored per attempt. To recover an accepted version, apply its saved patch **to the original baseline**. Failed submitted trials consume budget; the runner never changes your checkout.

### Scope and limitations

- The runner exports the baseline commit and overlays only allowlisted source. Ignored working-tree files are not included, and the snapshot has no `.git` directory or checked-out submodule contents. The project must build from an exported tree. Keep all benchmark/test inputs in version control.
- A per-repository lock prevents two `rustperf` commands from overlapping. It cannot prevent other builds, system load, CPU frequency changes, or unrelated processes from affecting results. `rayon_threads` covers Rayon only; pin other application concurrency in the benchmark harness if relevant.
- Environment overrides such as `RUSTFLAGS` are rejected, and the runner checks toolchain and selected build-environment values against the baseline. This is a guard against accidental benchmark drift, **not a sandbox for untrusted Rust code**. Use trusted repositories and review candidate diffs. For a hard no-`unsafe` rule, keep `#![forbid(unsafe_code)]` in a protected crate root, as in the example.

## Runner tests

```sh
python3 -m unittest discover -s tests -v
```

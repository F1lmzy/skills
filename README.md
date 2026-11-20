# Agent skills

A collection of installable skills for AI coding agents (pi and any harness that loads skills from `.agents/skills/`).

| Skill | Purpose |
|-------|---------|
| [rustperf](rustperf/) | Measured Rust optimization: frozen Criterion baseline, correctness gates, and a bounded series of experiments decided by the benchmark runner. |

## Install a skill

Each top-level folder is one self-contained skill. Its root holds a `SKILL.md` (the instructions your agent reads) plus any supporting files it needs. Install a skill by copying or symlinking its folder into your agent's skills directory — `.agents/skills/` under your home directory.

**Linux / macOS**

```sh
git clone git@github.com:F1lmzy/skills.git
cd skills
mkdir -p ~/.agents/skills
cp -R rustperf ~/.agents/skills/rustperf
```

A symlink stays current with the repo instead of making a copy:

```sh
ln -s "$(pwd -P)/rustperf" ~/.agents/skills/rustperf
```

**Windows (PowerShell)**

```powershell
git clone git@github.com:F1lmzy/skills.git
New-Item -ItemType Directory -Force "$env:USERPROFILE\.agents\skills" | Out-Null
Copy-Item -Recurse skills\rustperf "$env:USERPROFILE\.agents\skills\rustperf"
```

Notes for any system:

- The installed folder name becomes the skill name; keep the folder's files together (`SKILL.md`, `rustperf.py`, `README.md`, `examples/`, `tests/` for rustperf).
- Restart your agent session after installing so the skill is picked up.
- Each skill's own `README.md` documents its requirements and usage. Skill-specific runtime requirements (e.g. rustperf needs Linux or macOS, Python 3.12+, Git 2.31+, a Rust toolchain) apply to the skill, not to the install itself.

## Add a skill

Create a top-level folder containing at least a `SKILL.md` with `name` and `description` frontmatter, plus a `README.md`, and push it or open a PR.

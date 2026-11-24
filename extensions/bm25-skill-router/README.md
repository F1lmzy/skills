# BM25+ skill routing for Pi 1.5.2

A local, dependency-free extension that loads at most one skill body automatically at the start of a user-triggered run. It adds no tools or commands and does not execute the skill's scripts. Pi's normal skill advertising and explicit commands are unchanged. The selection is not a restriction on which skills the model can subsequently read.

## Try it

From the root of this repository:

```sh
cd extensions/bm25-skill-router
pi -e ./index.ts
```

For `/reload`, install the two runtime files in an auto-discovered directory (choose project-local `.pi/extensions/` or user-wide `~/.pi/agent/extensions/`). For example, from this directory:

```sh
mkdir -p ~/.pi/agent/extensions/bm25-skill-router
cp index.ts ranker.ts ~/.pi/agent/extensions/bm25-skill-router/
```

Use `pi` without `-e` after installing. Only enable the extension in contexts where you trust the skills Pi loads: the selected body is sent in a system prompt section, not merely advertised by name.

## Lifecycle and scope

In Pi 1.5.2, `AgentSession._preparePrompt` runs `input`, then native skill expansion, then template expansion; `_prepareRun` emits `before_agent_start`. Native `/skill:name` reads the winning discovered file, strips frontmatter, and puts a `<skill>` block with the base directory before the user's arguments. `input` has no structured skill list. `pi.getCommands()` supplies command metadata but omits the explicit-only flag. The structured getter on `ExtensionCommandContext` is command-only, not available to `input` handlers.

`index.ts` uses the current `before_agent_start.systemPromptOptions.skills` catalog, without running its own discovery or parsing a rendered system prompt. It ignores custom-message starts, an already forced system prompt, raw slash-prefixed inputs that reach the event, and the native `<skill name="…">` prefix in expanded **user** prompts. Automatic routing can see already-expanded prompt templates. It does not re-route steering or follow-up messages delivered inside an existing run. Pi does not expose the original input source on this hook.

The extension excludes `disable-model-invocation` skills before scoring. Pi resolves discovery precedence and name collisions before the extension sees the catalog. On selection it reads **only** the selected `filePath`, using Pi's exported `parseFrontmatter`, then adds the body and `baseDir` to one named section. A read/parse failure, empty body, or an on-disk explicit-only flag results in no injection and no fallback to a weaker match. No request text or images are rewritten. Pi diffs the structured section out of the effective system prompt on the next run without a selection; historical prompt patches may remain in the transcript. `/reload` reloads resources and replaces the extension runtime; there is no persistent index or global handler state.

## Retrieval contract

Each eligible skill is one document: `name + " " + description`, with no field boost. The name is an identifier; the description is authored for routing. The body is never indexed: for these two skills it includes lengthy instructions, examples, and platform mentions that are not reliable intent signals. Only the winning body is read by the extension.

- Both sides use NFKC and locale-independent `toLowerCase()`, then take maximal runs of Unicode letters, combining marks, and numbers. Punctuation and hyphens separate terms. Drop single-code-point terms (including the bare `X` platform name) and the fixed English stop list in `ranker.ts`. There is no stemming, phrase matching, synonym expansion, or user-supplied regex. Query terms are deduplicated and sorted in JavaScript code-unit order; document tokens count repetitions.
- For each distinct query term with `tf(t,d) > 0`, add:

  ```text
  idf(t) = ln(1 + (N - df(t) + 0.5) / (df(t) + 0.5))
  score(d) = sum_t idf(t) × [ tf(t,d) × (k1 + 1)
                            / (tf(t,d) + k1 × (1 - b + b × dl/avgdl)) + δ ]
  k1 = 1.2, b = 0.75, δ = 0.5
  ```

  `N` is the eligible document count, `df` is document frequency, `dl` is the filtered token count, and `avgdl` is its mean across eligible documents. Absent terms add nothing, including no delta. This matches the scoring variant in the installed `pi-blackhole/src/core/search-entries.ts`, not its regex search or top-k result filtering.
- Sort by descending score, then ascending name (code-unit order). Only the first hit can select. Require at least two distinct matches, coverage of at least one-third of all distinct filtered query terms (including terms outside the corpus), at least one match with `df = 1`, and, if there is a runner-up, `runner-up ≤ 0.75 × winner`. Ties never select. No absolute score threshold. These are abstention heuristics for a small catalog, not probabilities or a calibration for other collections.

## Offline verification

From this extension directory, run the unit and Pi integration tests:

```sh
PI_OFFLINE=1 node --disable-warning=ExperimentalWarning --test test/ranker.test.ts test/pi-integration.test.ts
```

To also run the relevance evaluation, install the `agent-reach` and `last30days` skills or point `SKILL_FIXTURE_DIR` at a directory containing them, then run:

```sh
PI_OFFLINE=1 node --disable-warning=ExperimentalWarning --test test/*.test.ts
```

Requires Node 22.18+ and the installed Pi 1.5.2 distribution. `PI_PACKAGE_DIR` can point at another installation of that distribution. `SKILL_FIXTURE_DIR` defaults to `~/.agents/skills`; the relevance test reads only the two named `SKILL.md` files and indexes their descriptions and names. The integration test uses an isolated temporary workspace/home, real Pi discovery and session reload, and a stub model stream that captures the model-facing messages. It checks body and base directory, exactly one handler call per request, byte-for-byte input text and PNG preservation, native explicit-only commands, discovery collisions, missing file handling, and updated metadata after repeated reloads.

The fixed relevance set matched **17 of 21** intent labels. Bare platform mentions, shared-only research queries, and a close split between distinct platform signals abstained. Both the paraphrased recency request and the body-only transcription request were missed (abstained); the LinkedIn translation and the local web-search unit-test request wrongly loaded `agent-reach`. The test reports these as errors and pins their current results separately from the intent labels. BM25+ cannot recognize a workflow exclusion, local-only intent, or a synonym just from token overlap. A larger or different skill catalog needs its own evaluation. Use `/skill:name` when you need to force a skill.

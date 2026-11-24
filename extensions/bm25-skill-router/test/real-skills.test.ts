import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { routeSkill } from "../ranker.ts";
import { loadPi } from "./installed-pi.ts";

const { loadSkills } = await loadPi();
const names = ["agent-reach", "last30days"] as const;
const [reach, recent] = names;
const root = process.env.SKILL_FIXTURE_DIR ?? join(homedir(), ".agents", "skills");
const { skills, diagnostics } = loadSkills({
	cwd: root,
	agentDir: root,
	skillPaths: names.map((name) => join(root, name, "SKILL.md")),
	includeDefaults: false,
});

// Intent labels are distinct from the measured routing results. The descriptions, not
// the bodies or any special-case rules for these names, are the retrieval corpus.
const cases = [
	["Search Bilibili for tea tutorials", reach],
	["Look up LinkedIn recruiting channels", reach],
	["Search the web for coffee grinders", reach],
	["Fetch RSS feeds from V2EX and Xiaoyuzhou Podcast", reach],
	["What do people say about keyboards in the last 30 days?", recent],
	["Research GitHub and Reddit posts from the last 30 days", recent],
	["Pull posts and engagement from TikTok and Hacker News", recent],
	["What do Polymarket and Hacker News say about the launch?", recent],
	["Research Reddit, YouTube, GitHub and the web", null], // shared-only
	["Research this topic", null], // no useful differentiator to clarify the intent
	["Bilibili and TikTok", null], // opposing signals, only one match apiece
	["Research Bilibili, LinkedIn jobs, TikTok and Polymarket", null], // both strong, small score margin
	["Reddit", null], // isolated platform mention
	["Implement radix sort in Rust", null], // unrelated, no matches
	["   ", null],
	["Summarize my local file", null],
	["Find me public videos on YouTube", reach], // platform routing vs. recent research
	// Known misses: third column pins the current result without changing the intent label.
	["Translate my report about LinkedIn jobs", null, reach], // no understanding of exclusions
	["What have people been saying about the launch over the past month?", recent, null], // paraphrased time window
	["Transcribe this YouTube video", reach, null], // use case specified in the body only
	["Fix the web search unit tests", null, reach], // lexical match, no internet intent
] as const;

test("fixed relevance evaluation against the two installed SKILL.md descriptions", (t) => {
	assert.deepEqual(skills.map((skill: { name: string }) => skill.name), [...names], JSON.stringify(diagnostics));
	let correct = 0;
	for (const [query, ideal, knownMiss] of cases) {
		const result = routeSkill(query, skills);
		const actual = result.selected?.name ?? null;
		const scores = result.hits.map(({ skill, score }) => `${skill.name}:${score.toFixed(3)}`).join(" ");
		if (actual === ideal) correct++;
		t.diagnostic(`${actual === ideal ? "OK" : "ERROR"} ${JSON.stringify(query)} → ${actual ?? "none"}; wanted ${ideal ?? "none"} [${result.reason}; ${scores || "no hits"}]`);
		assert.equal(actual, knownMiss === undefined ? ideal : knownMiss, query);
	}
	t.diagnostic(`${correct}/${cases.length} intent labels matched; ${cases.length - correct} known errors`);
});

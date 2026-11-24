import assert from "node:assert/strict";
import test from "node:test";
import { rankSkills, routeSkill, tokenize } from "../ranker.ts";

function approx(actual: number, expected: number) {
	assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
}

const equal = [
	{ name: "alpha", description: "alpha shared" },
	{ name: "beta", description: "shared spare" },
];

test("BM25+: equal lengths, repeated TF, shared IDF and matched-only delta", () => {
	const [a, b] = rankSkills(new Set(["alpha", "shared", "absent"]), equal);
	assert.equal(a.skill.name, "alpha");
	assert.equal(b.skill.name, "beta");
	// N=2, avgdl=3, lengthNorm=1.2, IDFs ln(2) and ln(1.2).
	approx(a.score, 1.875 * Math.log(2) + 1.5 * Math.log(1.2));
	approx(b.score, 1.5 * Math.log(1.2));
	assert.deepEqual([a.matches, a.uniqueMatches, b.matches, b.uniqueMatches], [2, 1, 1, 0]);
});

test("BM25+: unequal lengths are normalized even when the match counts are identical", () => {
	const [short, long] = rankSkills(new Set(["quartz"]), [
		{ name: "one", description: "quartz" },
		{ name: "two", description: "quartz slate chalk flint sand" },
	]);
	assert.equal(short.skill.name, "one");
	assert.equal(long.skill.name, "two");
	// Lengths 2 and 6, avgdl=4, giving denominator 1+0.75 and 1+1.65.
	approx(short.score, Math.log(1.2) * (2.2 / 1.75 + 0.5));
	approx(long.score, Math.log(1.2) * (2.2 / 2.65 + 0.5));
});

test("BM25+: tokenless documents count toward corpus statistics but never score", () => {
	const tokenlessSkill = { name: "X", description: "the" };
	const terms = new Set(["quartz"]);
	const hits = rankSkills(terms, [
		{ name: "minerals", description: "quartz" },
		tokenlessSkill,
	]);

	assert.equal(hits.length, 1);
	const [hit] = hits;
	assert.equal(hit.skill.name, "minerals");
	// The empty document makes the average length 1 and the IDF ln(2).
	approx(hit.score, Math.log(2) * (2.2 / 3.1 + 0.5));
	assert.deepEqual(rankSkills(terms, [tokenlessSkill]), []);
});

test("normalization, stop words, punctuation, and distinct query terms", () => {
	assert.deepEqual(tokenize("ＡLPHA-cafe\u0301; the ３０, X!"), ["alpha", "café", "30"]);
	assert.deepEqual(routeSkill("ALPHA shared alpha", equal), routeSkill("shared alpha", equal));
	assert.deepEqual(routeSkill("the X!", equal), { hits: [], reason: "no-match" });
	assert.deepEqual(routeSkill("quartz slate", []), { hits: [], reason: "no-match" });
});

test("rank ties by name but never auto-select a tied or shared-only hit", () => {
	const a = { name: "alpha", description: "quartz slate common words" };
	const b = { name: "beta", description: "granite flint common words" };
	for (const skills of [[a, b], [b, a]]) {
		const result = routeSkill("quartz slate granite flint", skills);
		assert.deepEqual(result.hits.map((hit) => hit.skill.name), ["alpha", "beta"]);
		assert.equal(result.reason, "ambiguous");
		assert.equal(result.selected, undefined);
		assert.equal(routeSkill("common words", skills).reason, "ambiguous");
	}
});

test("one token cannot route, and off-topic words count against coverage", () => {
	assert.equal(routeSkill("alpha alpha alpha", equal).reason, "weak-overlap");
	assert.equal(routeSkill("alpha shared slate chalk flint quartz granite", equal).reason, "weak-overlap");
	assert.equal(routeSkill("alpha shared slate chalk flint quartz", equal).selected?.name, "alpha");
});

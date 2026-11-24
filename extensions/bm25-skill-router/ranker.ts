export interface SkillMetadata {
	name: string;
	description: string;
}

const STOP_WORDS = new Set(
	[
		"a an and are as at be but by can could do does for from had has have how i in is it its",
		"me my of on or our please should that the their them these they this those to up us use",
		"was we were what when where which who will with would you your",
	].join(" ").split(" "),
);

const BM25_SATURATION = 1.2;
const BM25_LENGTH_WEIGHT = 0.75;
const BM25_MATCH_BONUS = 0.5;
const MIN_DISTINCT_MATCHES = 2;
const COVERAGE_DENOMINATOR = 3;
const MAX_RUNNER_UP_RATIO = 0.75;

export function tokenize(text: string): string[] {
	const normalized = text.normalize("NFKC").toLowerCase();
	const terms = normalized.match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
	return terms.filter((term) => [...term].length > 1 && !STOP_WORDS.has(term));
}

export interface Hit<T> {
	skill: T;
	score: number;
	matches: number;
	uniqueMatches: number;
}

export function rankSkills<T extends SkillMetadata>(
	terms: ReadonlySet<string>,
	skills: readonly T[],
): Hit<T>[] {
	const documentCount = skills.length;
	if (!documentCount) return [];

	const documentFrequencies = new Map<string, number>();
	let totalLength = 0;
	const documents = skills.map((skill) => {
		const tokens = tokenize(`${skill.name} ${skill.description}`);
		const termFrequencies = new Map<string, number>();
		for (const term of tokens) {
			if (!terms.has(term)) continue;
			termFrequencies.set(term, (termFrequencies.get(term) ?? 0) + 1);
		}
		for (const term of termFrequencies.keys()) {
			documentFrequencies.set(term, (documentFrequencies.get(term) ?? 0) + 1);
		}
		totalLength += tokens.length;
		return { skill, length: tokens.length, termFrequencies };
	});

	// Query order keeps floating-point summation consistent across documents.
	const queryWeights = [];
	for (const term of terms) {
		const documentFrequency = documentFrequencies.get(term);
		if (!documentFrequency) continue;
		const inverseFrequency = Math.log1p(
			(documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5),
		);
		queryWeights.push({ term, inverseFrequency, documentFrequency });
	}

	const averageLength = totalLength / documentCount;
	const hits: Hit<T>[] = [];
	for (const { skill, length, termFrequencies } of documents) {
		if (!termFrequencies.size) continue;

		const lengthWeight = BM25_LENGTH_WEIGHT * length / averageLength;
		const lengthNorm = BM25_SATURATION * (1 - BM25_LENGTH_WEIGHT + lengthWeight);
		let score = 0;
		let uniqueMatches = 0;
		for (const { term, inverseFrequency, documentFrequency } of queryWeights) {
			const frequency = termFrequencies.get(term);
			if (!frequency) continue; // The match bonus does not apply to absent terms.
			const normalizedFrequency = frequency * (BM25_SATURATION + 1) / (frequency + lengthNorm);
			score += inverseFrequency * (normalizedFrequency + BM25_MATCH_BONUS);
			if (documentFrequency === 1) uniqueMatches++;
		}
		hits.push({ skill, score, matches: termFrequencies.size, uniqueMatches });
	}

	return hits.sort((left, right) => {
		const scoreOrder = right.score - left.score;
		if (scoreOrder) return scoreOrder;
		if (left.skill.name < right.skill.name) return -1;
		if (left.skill.name > right.skill.name) return 1;
		return 0;
	});
}

export function routeSkill<T extends SkillMetadata>(query: string, skills: readonly T[]) {
	const terms = new Set(tokenize(query).sort());
	const hits = rankSkills(terms, skills);
	const [winner, runnerUp] = hits;
	if (!winner) return { hits, reason: "no-match" } as const;

	const minimumCoverageMet = winner.matches * COVERAGE_DENOMINATOR >= terms.size;
	if (winner.matches < MIN_DISTINCT_MATCHES || !minimumCoverageMet) {
		return { hits, reason: "weak-overlap" } as const;
	}

	const runnerUpTooClose = runnerUp && runnerUp.score > MAX_RUNNER_UP_RATIO * winner.score;
	if (!winner.uniqueMatches || runnerUpTooClose) {
		return { hits, reason: "ambiguous" } as const;
	}
	return { hits, selected: winner.skill, reason: "selected" } as const;
}

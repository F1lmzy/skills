import { readFile } from "node:fs/promises";
import { parseFrontmatter, type ExtensionAPI, type SkillFrontmatter } from "@earendil-works/pi-coding-agent";
import { routeSkill } from "./ranker.ts";

export default function skillRouter(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		if (event.messageType !== "user") return;
		const options = event.systemPromptOptions;
		if (options.forceSystemPrompt !== undefined) return;

		// Native skill commands have already expanded (including explicit-only skills).
		// Unknown or failed slash commands may still be present verbatim.
		const query = event.prompt.trimStart();
		if (query.startsWith("/") || query.startsWith('<skill name="')) return;

		const eligible = (options.skills ?? []).filter((skill) => !skill.disableModelInvocation);
		const { selected } = routeSkill(query, eligible);
		if (!selected) return;

		// Use Pi's own frontmatter parser and Skill.baseDir; do not rediscover skills.
		// Read only the winner, and do not fall back to a weaker match on read/parse errors.
		try {
			const { body, frontmatter } = parseFrontmatter<SkillFrontmatter>(await readFile(selected.filePath, "utf8"));
			if (frontmatter["disable-model-invocation"] === true || !body.trim()) return;
			options.sections.bm25_selected_skill =
				`Skill: ${selected.name}\nLocation: ${selected.filePath}\n` +
				`References are relative to ${selected.baseDir}.\n\n${body.trim()}`;
		} catch {
			// A removed, unreadable, or malformed file shouldn't prevent sending the request.
		}
	});
}

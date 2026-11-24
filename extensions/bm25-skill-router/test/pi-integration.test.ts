import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { loadPi, loadPiAI } from "./installed-pi.ts";

const TAG = "bm25_selected_skill";
const marker = "COBALT-BODY-ORIGINAL";
const privateMarker = "EXPLICIT-ONLY-BODY";
const image = {
	type: "image",
	mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=",
};

async function put(path: string, text: string) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, text);
}

function skill(name: string, description: string, body: string, disabled = false) {
	return `---\nname: ${name}\ndescription: ${description}\n${disabled ? "disable-model-invocation: true\n" : ""}---\n\n${body}\n`;
}

test("installed Pi loads one winning body, preserves input and native commands, and rebuilds on reload", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-skill-bm25-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const oldHome = process.env.HOME;
	const oldOffline = process.env.PI_OFFLINE;
	process.env.HOME = join(root, "home");
	process.env.PI_OFFLINE = "1";
	t.after(() => {
		if (oldHome === undefined) delete process.env.HOME;
		else process.env.HOME = oldHome;
		if (oldOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = oldOffline;
	});
	const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected network access"); });
	const { VERSION, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, parseSkillBlock } = await loadPi();
	const { createAssistantMessageEventStream, fauxAssistantMessage, InMemoryCredentialStore, getCurrentSystemPrompt } = await loadPiAI();
	assert.equal(VERSION, "1.5.2");

	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	const extDir = join(agentDir, "extensions", "bm25");
	await mkdir(cwd, { recursive: true });
	await mkdir(extDir, { recursive: true });
	for (const file of ["index.ts", "ranker.ts"]) {
		await copyFile(new URL(`../${file}`, import.meta.url), join(extDir, file));
	}
	const winner = join(root, "winner", "SKILL.md");
	const shadow = join(root, "shadow", "SKILL.md");
	const disabled = join(root, "manual", "SKILL.md");
	const firstDescription = "Glazes ceramics cobalt kiln";
	await put(winner, skill("pottery", firstDescription, `${marker}\nRead [notes](references/notes.md).`));
	await put(shadow, skill("pottery", firstDescription, "SHADOW-BODY"));
	await put(disabled, skill("manual", "Microscope aperture calibration", privateMarker, true));

	let handlerCalls = 0;
	let runtimeLoads = 0;
	const errors: unknown[] = [];
	const settingsManager = SettingsManager.inMemory({ enableSkillCommands: false, images: { autoResize: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
		additionalSkillPaths: [winner, shadow, disabled],
		extensionsOverride(result: LoadExtensionsResult) {
			assert.deepEqual(result.errors, []);
			assert.equal(result.extensions.length, 1);
			const handlers = result.extensions[0].handlers.get("before_agent_start");
			assert.equal(handlers?.length, 1);
			const [handler] = handlers!;
			// Count real runner invocations, not just section keys (writes to one key are idempotent).
			handlers![0] = (...args: unknown[]) => { handlerCalls++; return handler(...args); };
			runtimeLoads++;
			return result;
		},
	});
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getSkills().skills.map((s: { filePath: string }) => s.filePath), [winner, disabled]);
	assert.ok(resourceLoader.getSkills().diagnostics.some((d: { type: string }) => d.type === "collision"));

	const credentials = new InMemoryCredentialStore();
	await credentials.modify("openai", async () => ({ type: "api_key", key: "test-key-not-used" }));
	const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false });
	const model = modelRuntime.getModel("openai", "gpt-4o");
	assert.ok(model?.input.includes("image"));
	const { session } = await createAgentSession({
		cwd, agentDir, resourceLoader, settingsManager, modelRuntime, model, sessionManager: SessionManager.inMemory(),
	});
	t.after(() => session.dispose());
	await session.bindExtensions({ mode: "rpc", onError: (error: unknown) => errors.push(error) });

	const requests: Array<{ effective: string; user: unknown[]; providerMessages: unknown }> = [];
	session.agent.streamFunction = (requestModel: { id: string; provider: string; api: string }, context: {
		messages: Array<{ role: string; content: unknown[] }>;
	}) => {
		requests.push({
			effective: getCurrentSystemPrompt(context.messages),
			user: structuredClone(context.messages.findLast((message) => message.role === "user")?.content ?? []),
			providerMessages: structuredClone(context.messages),
		});
		const response = { ...fauxAssistantMessage("OK"), model: requestModel.id, provider: requestModel.provider, api: requestModel.api };
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "done", reason: "stop", message: response });
		return stream;
	};

	const prompt = async (text: string, images?: Array<typeof image>) => {
		const n = requests.length;
		const callsBefore = handlerCalls;
		await session.prompt(text, { source: "rpc", images });
		assert.equal(handlerCalls, callsBefore + 1);
		assert.equal(requests.length, n + 1);
		return requests[n];
	};
	const noAuto = (request: { effective: string }) => assert.ok(!request.effective.includes(`<${TAG}>`));

	const exact = "  Glazes ceramics\n\n  Keep this spacing.  ";
	const selected = await prompt(exact, [image]);
	assert.deepEqual(selected.user, [{ type: "text", text: exact }, image]);
	assert.equal(JSON.stringify(selected.providerMessages).split(marker).length - 1, 1);
	assert.equal(selected.effective.split(`<${TAG}>`).length - 1, 1);
	assert.ok(selected.effective.includes(`References are relative to ${dirname(winner)}.`));
	assert.ok(selected.effective.includes("Read [notes](references/notes.md)."));
	assert.doesNotMatch(selected.effective, /SHADOW-BODY|EXPLICIT-ONLY-BODY|\n---\n/);
	assert.equal(selected.effective.includes("<available_skills>"), true); // normal Pi metadata unchanged

	const noMatch = await prompt("Implement radix sort");
	noAuto(noMatch);
	assert.ok(!noMatch.effective.includes(marker)); // No carry-over in the effective prompt.
	noAuto(await prompt("Microscope aperture calibration"));

	const explicit = await prompt("/skill:manual Glazes ceramics cobalt kiln", [image]);
	noAuto(explicit);
	assert.deepEqual(explicit.user[1], image);
	const explicitText = (explicit.user[0] as { text: string }).text;
	assert.equal(explicitText.split(privateMarker).length - 1, 1);
	assert.deepEqual(parseSkillBlock(explicitText), {
		name: "manual", location: disabled, userMessage: "Glazes ceramics cobalt kiln",
		content: `References are relative to ${dirname(disabled)}.\n\n${privateMarker}`,
	});
	const unknown = "/skill:unknown Glazes ceramics cobalt kiln";
	const notExpanded = await prompt(unknown);
	noAuto(notExpanded);
	assert.deepEqual(notExpanded.user, [{ type: "text", text: unknown }]);

	await put(winner, skill("pottery", "Mineral stone polishing", "STONE-BODY-UPDATE"));
	const oldRunner = session.extensionRunner;
	await session.reload(); // same SDK method called by the TUI's /reload and the RPC reload command
	assert.notEqual(session.extensionRunner, oldRunner);
	assert.equal(runtimeLoads, 2);
	noAuto(await prompt("Glazes ceramics cobalt kiln"));
	const updated = await prompt("Mineral stone polishing");
	assert.ok(updated.effective.includes("STONE-BODY-UPDATE"));
	assert.ok(!updated.effective.includes(marker));
	await rm(winner);
	noAuto(await prompt("Mineral stone polishing")); // a removed winner must not break the run

	await put(winner, skill("pottery", "Mineral stone polishing", "STONE-BODY-UPDATE", true));
	await session.reload();
	assert.equal(runtimeLoads, 3);
	noAuto(await prompt("Mineral stone polishing"));
	noAuto(await prompt("Glazes ceramics cobalt kiln")); // disabled winner doesn't expose its shadowed duplicate
	assert.deepEqual(errors, []);
	assert.equal(fetch.mock.callCount(), 0);
});

import type { GraphDefinition } from "@buffered-audio/core";
import { validateGraphDefinition } from "@buffered-audio/core";
import type { Main } from "../models/Main";

async function selectBag(main: Main, title: string): Promise<string | undefined> {
	const result = await main.showOpenDialog({
		title,
		filters: [{ name: "Bag Files", extensions: ["bag"] }],
		properties: ["openFile"],
	});

	if (!result || result.length === 0) return undefined;

	return result[0];
}

export async function openBag(main: Main): Promise<string | undefined> {
	return selectBag(main, "Open Graph");
}

export async function importBag(main: Main): Promise<{ bagPath: string; definition: GraphDefinition } | undefined> {
	const bagPath = await selectBag(main, "Import Bag");

	if (!bagPath) return undefined;

	const definition = await loadBag(main, bagPath);

	return { bagPath, definition };
}

export async function loadBag(main: Main, bagPath: string): Promise<GraphDefinition> {
	const raw = await main.readFile(bagPath);
	const json: unknown = JSON.parse(raw);

	let needsWrite = false;
	const parsed = json as Record<string, unknown>;

	if (!parsed.id || typeof parsed.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.id)) {
		parsed.id = crypto.randomUUID();
		needsWrite = true;
	}

	const definition = validateGraphDefinition(parsed);

	if (needsWrite) {
		await main.writeFile(bagPath, JSON.stringify(definition, null, 2));
	}

	return definition;
}

export async function newBag(main: Main): Promise<{ bagPath: string; definition: GraphDefinition } | undefined> {
	const bagPath = await main.showSaveDialog({
		title: "New Graph",
		filters: [{ name: "Bag Files", extensions: ["bag"] }],
	});

	if (!bagPath) return undefined;

	const fileName = bagPath.split(/[\\/]/).pop() ?? "Untitled";
	const name = fileName.replace(/\.bag$/i, "");

	const definition: GraphDefinition = {
		id: crypto.randomUUID(),
		name,
		nodes: [],
		edges: [],
	};

	await main.writeFile(bagPath, JSON.stringify(definition, null, 2));

	return { bagPath, definition };
}

export async function saveBagDefinition(main: Main, bagPath: string, definition: GraphDefinition): Promise<void> {
	await main.writeFile(bagPath, JSON.stringify(definition, null, 2));
}

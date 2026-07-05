import { validateGraphDefinition, type GraphDefinition } from "@buffered-audio/core";
import type { Snapshot } from "valtio/vanilla";
import type { State } from ".";
import type { Main } from "../Main";

export type GraphDefinitionState = GraphDefinition & State;

export async function loadGraphDefinition(
	bagPath: string,
	main: Main,
): Promise<{ definition: Omit<GraphDefinitionState, "_key">; content: string }> {
	const content = await main.readFile(bagPath);
	const parsed: unknown = JSON.parse(content);
	const definition = validateGraphDefinition(parsed);

	return { definition, content };
}

export function serializeGraphDefinition(state: Snapshot<GraphDefinitionState>): string {
	const { _key, ...rest } = state;

	return JSON.stringify(rest, null, 2);
}

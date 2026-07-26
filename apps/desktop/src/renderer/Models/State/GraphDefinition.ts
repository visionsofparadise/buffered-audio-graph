import type { GraphDefinition } from "@buffered-audio/core";
import type { Snapshot } from "opshot";
import type { Main } from "../Main";

export type GraphDefinitionState = GraphDefinition;

export async function loadGraphDefinition(
	bagPath: string,
	main: Main,
): Promise<{ definition: GraphDefinitionState; content: string }> {
	const content = await main.readFile(bagPath);
	const parsed: unknown = JSON.parse(content);
	const definition = await main.validateGraphDefinition(parsed);

	return { definition, content };
}

export function serializeGraphDefinition(definition: Snapshot<GraphDefinitionState>): string {
	return JSON.stringify(definition, null, 2);
}

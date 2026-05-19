import type { Snapshot } from "valtio/vanilla";
import { z } from "zod";
import type { State } from ".";
import type { Main } from "../Main";

const ViewportSchema = z.object({
	x: z.number(),
	y: z.number(),
	zoom: z.number(),
});

export const GraphStateSchema = z.object({
	positions: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).default({}),
	inspectedNodeId: z.string().nullable().default(null),
	viewport: ViewportSchema.default({ x: 0, y: 0, zoom: 1 }),
});

export type GraphState = z.infer<typeof GraphStateSchema> & State;

export async function loadGraphState(main: Main, userDataPath: string, bagId: string): Promise<Omit<GraphState, "_key">> {
	const path = `${userDataPath}/graphs/${bagId}.json`;

	try {
		const content = await main.readFile(path);
		const result = GraphStateSchema.safeParse(JSON.parse(content));

		if (result.success) {
			return result.data;
		}
	} catch {
		// no saved graph state
	}

	return GraphStateSchema.parse({});
}

export function serializeGraphState(state: Snapshot<GraphState>): string {
	const { _key, ...rest } = state;

	return JSON.stringify(rest);
}

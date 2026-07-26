import type { Snapshot } from "opshot";
import { z } from "zod";
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

export type GraphState = z.infer<typeof GraphStateSchema>;

export interface PositionsState {
	positions: Record<string, { x: number; y: number }>;
}

export interface GraphViewState {
	inspectedNodeId: string | null;
	viewport: { x: number; y: number; zoom: number };
}

export async function loadGraphState(main: Main, userDataPath: string, bagId: string): Promise<GraphState> {
	const path = `${userDataPath}/graphs/${bagId}.json`;

	try {
		const content = await main.readFile(path);
		const result = GraphStateSchema.safeParse(JSON.parse(content));

		if (result.success) {
			return result.data;
		}
	} catch {
		return GraphStateSchema.parse({});
	}

	return GraphStateSchema.parse({});

}

export function serializeGraphState(positions: Snapshot<PositionsState>, view: Snapshot<GraphViewState>): string {
	return JSON.stringify({ positions: positions.positions, inspectedNodeId: view.inspectedNodeId, viewport: view.viewport });
}

import { z } from "zod";
import type { Main } from "../Main";

const GraphStateSchema = z.object({
	positions: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).default({}),
});

export type GraphState = z.infer<typeof GraphStateSchema>;

export interface PositionsState {
	positions: Record<string, { x: number; y: number }>;
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

export function serializeGraphState(positions: PositionsState): string {
	return JSON.stringify({ positions: positions.positions });
}

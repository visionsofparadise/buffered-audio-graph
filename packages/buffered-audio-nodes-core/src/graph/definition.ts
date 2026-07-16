import { z } from "zod";
import type { BufferedAudioNode } from "../node";

const graphNodeSchema = z.object({
	id: z.string().min(1),
	packageName: z.string().min(1),
	packageVersion: z.string().min(1),
	nodeName: z.string().min(1),
	parameters: z.record(z.string(), z.unknown()).optional(),
	options: z
		.object({
			bypass: z.boolean().optional(),
		})
		.optional(),
});

const graphEdgeSchema = z.object({
	from: z.string().min(1),
	to: z.string().min(1),
});

const graphDefinitionSchema = z.object({
	id: z.uuid(),
	name: z.string().default("Untitled"),
	apiVersion: z.number().int().min(1),
	nodes: z.array(graphNodeSchema),
	edges: z.array(graphEdgeSchema),
});

export type GraphNode = z.infer<typeof graphNodeSchema>;
export type GraphEdge = z.infer<typeof graphEdgeSchema>;
export type GraphDefinition = z.infer<typeof graphDefinitionSchema>;

export type NodeRegistry = Map<string, Map<string, Map<string, new (options?: Record<string, unknown>) => BufferedAudioNode>>>;

export function validateGraphDefinition(json: unknown): GraphDefinition {
	return graphDefinitionSchema.parse(json);
}

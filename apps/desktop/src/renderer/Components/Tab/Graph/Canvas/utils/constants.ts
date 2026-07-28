import { EdgeContainer } from "../../EdgeContainer";
import { NodeContainer } from "../../Node/Container";
import type { EdgeTypes, NodeTypes } from "@xyflow/react";

export const NODE_TYPES: NodeTypes = { bufferedAudioNode: NodeContainer };
export const EDGE_TYPES: EdgeTypes = { bufferedAudioEdge: EdgeContainer };
export const EMPTY_REMEMBERED_PARAMETERS: Record<string, string> = {};

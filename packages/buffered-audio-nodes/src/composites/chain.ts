import {
	type BufferedAudioNode,
	type BufferedTransformStream,
	CompositeNode,
	SourceNode,
	TransformNode,
} from "@buffered-audio/core";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../package-metadata";

export class ChainNode extends CompositeNode {
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	readonly type = ["buffered-audio-node", "transform", "composite", "chain"] as const;

	private readonly _head: BufferedAudioNode;
	private readonly _tail: BufferedAudioNode;

	constructor(head: BufferedAudioNode, tail: BufferedAudioNode) {
		super();

		this._head = head;
		this._tail = tail;
	}

	override get head(): BufferedAudioNode {
		return this._head;
	}

	override get tail(): BufferedAudioNode {
		return this._tail;
	}

	createStream(): BufferedTransformStream {
		throw new Error("ChainNode does not create streams");
	}

	clone(): ChainNode {
		throw new Error("ChainNode does not support cloning");
	}
}

export function chain(...nodes: Array<BufferedAudioNode | CompositeNode>): ChainNode {
	if (nodes.length < 2) {
		throw new Error("chain() requires at least 2 nodes");
	}

	const [first, ...rest] = nodes;

	if (!first) {
		throw new Error("chain() requires at least 2 nodes");
	}

	let previous: BufferedAudioNode | CompositeNode = first;

	for (const node of rest) {
		const resolvedTail = previous instanceof CompositeNode ? previous.tail : previous;
		const resolvedHead = node instanceof CompositeNode ? node.head : node;

		if (!(resolvedTail instanceof SourceNode) && !(resolvedTail instanceof TransformNode)) {
			throw new Error("Cannot connect downstream from a TargetNode");
		}

		(resolvedTail as SourceNode | TransformNode).to(resolvedHead);
		previous = node;
	}

	const resolvedHead = first instanceof CompositeNode ? first.head : first;
	const resolvedTail = previous instanceof CompositeNode ? previous.tail : previous;

	return new ChainNode(resolvedHead, resolvedTail);
}

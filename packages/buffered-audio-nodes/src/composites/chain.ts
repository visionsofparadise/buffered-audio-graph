import { type BufferedAudioNode, type Composition, SourceNode, TargetNode, TransformNode } from "@buffered-audio/core";

export interface Chain extends Composition {
	to(child: BufferedAudioNode | Composition): void;
}

function resolveHead(item: BufferedAudioNode | Composition): BufferedAudioNode {
	return "head" in item ? item.head : item;
}

function resolveTail(item: BufferedAudioNode | Composition): BufferedAudioNode {
	return "tail" in item ? item.tail : item;
}

function connect(tail: BufferedAudioNode, head: BufferedAudioNode): void {
	if (tail instanceof SourceNode || tail instanceof TransformNode) {
		tail.to(head);

		return;
	}

	throw new Error("Cannot connect downstream from a TargetNode");
}

export function chain(...items: Array<BufferedAudioNode | Composition>): Chain {
	if (items.length < 2) {
		throw new Error("chain() requires at least 2 nodes");
	}

	const [first, ...rest] = items;

	if (!first) {
		throw new Error("chain() requires at least 2 nodes");
	}

	let previous: BufferedAudioNode | Composition = first;

	for (const item of rest) {
		connect(resolveTail(previous), resolveHead(item));
		previous = item;
	}

	const head = resolveHead(first);
	const tail = resolveTail(previous);

	return {
		head,
		tail,
		to(child: BufferedAudioNode | Composition): void {
			if (tail instanceof TargetNode) {
				throw new Error("Cannot connect downstream from a TargetNode");
			}

			connect(tail, resolveHead(child));
		},
	};
}

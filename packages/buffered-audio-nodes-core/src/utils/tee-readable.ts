import type { Block } from "../node/stream/block";

interface TeeBranch {
	readonly controller: ReadableStreamDefaultController<Block>;
	readonly demandResolvers: Array<() => void>;
	cancelled: boolean;
}

export function teeReadable<T>(readable: ReadableStream<Block>, items: ReadonlyArray<T>): Array<[ReadableStream<Block>, T]> {
	if (items.length === 0) return [];

	const first = items[0] as T;

	if (items.length === 1) return [[readable, first]];

	const reader = readable.getReader();
	const branches: Array<TeeBranch> = [];

	let serving = false;
	let finished = false;

	const settleDemand = (branch: TeeBranch): void => {
		branch.demandResolvers.shift()?.();
	};

	const settleAllDemand = (branch: TeeBranch): void => {
		while (branch.demandResolvers.length > 0) settleDemand(branch);
	};

	const liveBranches = (): Array<TeeBranch> => branches.filter((branch) => !branch.cancelled);

	const serve = async (): Promise<void> => {
		if (serving) return;

		serving = true;

		try {
			while (!finished) {
				const demanding = liveBranches();

				if (demanding.length === 0) return;
				if (!demanding.every((branch) => branch.demandResolvers.length > 0)) return;

				let result: ReadableStreamReadResult<Block>;

				try {
					result = await reader.read();
				} catch (error) {
					finished = true;

					for (const branch of liveBranches()) {
						branch.controller.error(error);
						settleAllDemand(branch);
					}

					return;
				}

				for (const branch of liveBranches()) {
					if (result.done) branch.controller.close();
					else branch.controller.enqueue(result.value);

					settleDemand(branch);
				}

				if (result.done) finished = true;
			}
		} finally {
			serving = false;
		}
	};

	const streams = items.map(() => {
		let branch: TeeBranch;

		return new ReadableStream<Block>({
			start: (controller) => {
				branch = { controller, demandResolvers: [], cancelled: false };

				branches.push(branch);
			},
			pull: () =>
				new Promise<void>((resolve) => {
					branch.demandResolvers.push(resolve);

					void serve();
				}),
			cancel: async (reason) => {
				branch.cancelled = true;

				settleAllDemand(branch);

				if (branches.every((entry) => entry.cancelled)) {
					finished = true;

					await reader.cancel(reason);

					return;
				}

				void serve();
			},
		});
	});

	return streams.map((stream, offset) => [stream, items[offset] as T]);
}

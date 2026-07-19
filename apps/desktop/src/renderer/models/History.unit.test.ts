import { createGroup, createState } from "opshot";
import { describe, expect, it } from "vitest";

import { createHistory, graphMeta } from "./History";

const createFixture = () => {
	const group = createGroup(graphMeta);
	const definition = group.createState({ name: "g", nodes: new Array<{ id: string; parameters: Record<string, unknown> }>(), edges: new Array<{ from: string; to: string }>() });
	const positions = group.createState({ positions: {} as Record<string, { x: number; y: number }> });
	const history = createHistory(group);

	return { definition, positions, history };
};

describe("History", () => {
	it("records one entry for a mutation", () => {
		const { definition, history } = createFixture();

		definition.mutate((mutable) => {
			mutable.name = "renamed";
		});

		expect(history.op.unwrap().canUndo).toBe(true);
		expect(history.op.unwrap().stack).toHaveLength(1);
		expect(history.op.unwrap().stackLength).toBe(1);
	});

	it("undo restores the previous value and redo replays it", () => {
		const { definition, history } = createFixture();

		definition.mutate((mutable) => {
			mutable.name = "renamed";
		});

		history.op.unwrap().undo();

		expect(definition.op.unwrap().name).toBe("g");

		history.op.unwrap().redo();

		expect(definition.op.unwrap().name).toBe("renamed");
	});

	it("exact-restores the document across push, nested write, and splice", () => {
		const { definition, history } = createFixture();

		definition.mutate((mutable) => {
			mutable.nodes.push({ id: "gain-1", parameters: {} });
		});
		definition.mutate((mutable) => {
			const node = mutable.nodes[0];

			if (node) node.parameters.amount = 0.5;
		});
		definition.mutate((mutable) => {
			mutable.nodes.splice(0, 1);
		});

		history.op.unwrap().undo();

		expect(JSON.stringify(definition.op.unwrap().nodes)).toBe(JSON.stringify([{ id: "gain-1", parameters: { amount: 0.5 } }]));

		history.op.unwrap().undo();

		expect(JSON.stringify(definition.op.unwrap().nodes)).toBe(JSON.stringify([{ id: "gain-1", parameters: {} }]));

		history.op.unwrap().undo();

		expect(JSON.stringify(definition.op.unwrap())).toBe(JSON.stringify({ name: "g", nodes: [], edges: [] }));

		history.op.unwrap().redo();

		expect(JSON.stringify(definition.op.unwrap().nodes)).toBe(JSON.stringify([{ id: "gain-1", parameters: {} }]));

		history.op.unwrap().redo();

		expect(JSON.stringify(definition.op.unwrap().nodes)).toBe(JSON.stringify([{ id: "gain-1", parameters: { amount: 0.5 } }]));

		history.op.unwrap().redo();

		expect(JSON.stringify(definition.op.unwrap())).toBe(JSON.stringify({ name: "g", nodes: [], edges: [] }));
		expect(history.op.unwrap().canRedo).toBe(false);
	});

	it("coalesces definition and positions mutates under one transactionKey into one entry", () => {
		const { definition, positions, history } = createFixture();

		const transactionKey = "add-node-1";

		definition.mutate(
			(mutable) => {
				mutable.nodes.push({ id: "gain-1", parameters: {} });
			},
			{ transactionKey },
		);
		positions.mutate(
			(mutable) => {
				mutable.positions["gain-1"] = { x: 10, y: 20 };
			},
			{ transactionKey },
		);

		expect(history.op.unwrap().stack).toHaveLength(1);

		history.op.unwrap().undo();

		expect(definition.op.unwrap().nodes).toHaveLength(0);
		expect(positions.op.unwrap().positions["gain-1"]).toBeUndefined();
		expect(history.op.unwrap().canUndo).toBe(false);

		history.op.unwrap().redo();

		expect(JSON.stringify(definition.op.unwrap().nodes)).toBe(JSON.stringify([{ id: "gain-1", parameters: {} }]));
		expect(positions.op.unwrap().positions["gain-1"]).toEqual({ x: 10, y: 20 });
	});

	it("concatenates same-key emissions into the top entry and opens a new entry for a different key", () => {
		const { positions, history } = createFixture();

		positions.mutate(
			(mutable) => {
				mutable.positions["a"] = { x: 1, y: 1 };
			},
			{ transactionKey: "drag-1" },
		);
		positions.mutate(
			(mutable) => {
				mutable.positions["a"] = { x: 2, y: 2 };
			},
			{ transactionKey: "drag-1" },
		);

		expect(history.op.unwrap().stack).toHaveLength(1);

		positions.mutate(
			(mutable) => {
				mutable.positions["a"] = { x: 3, y: 3 };
			},
			{ transactionKey: "drag-2" },
		);

		expect(history.op.unwrap().stack).toHaveLength(2);

		history.op.unwrap().undo();

		expect(positions.op.unwrap().positions["a"]).toEqual({ x: 2, y: 2 });

		history.op.unwrap().undo();

		expect(positions.op.unwrap().positions["a"]).toBeUndefined();
	});

	it("appends into the existing same-state batch when states interleave under one key", () => {
		const { definition, positions, history } = createFixture();

		const transactionKey = "insert-1";

		definition.mutate(
			(mutable) => {
				mutable.nodes.push({ id: "a", parameters: {} });
			},
			{ transactionKey },
		);
		positions.mutate(
			(mutable) => {
				mutable.positions["a"] = { x: 1, y: 1 };
			},
			{ transactionKey },
		);
		definition.mutate(
			(mutable) => {
				mutable.nodes.push({ id: "b", parameters: {} });
			},
			{ transactionKey },
		);

		const entry = history.op.unwrap().stack[0];

		expect(history.op.unwrap().stack).toHaveLength(1);
		expect(entry?.batches).toHaveLength(2);

		history.op.unwrap().undo();

		expect(definition.op.unwrap().nodes).toHaveLength(0);
		expect(positions.op.unwrap().positions["a"]).toBeUndefined();
	});

	it("a new mutation after undo truncates forward history", () => {
		const { definition, history } = createFixture();

		definition.mutate((mutable) => {
			mutable.name = "one";
		});
		definition.mutate((mutable) => {
			mutable.name = "two";
		});

		history.op.unwrap().undo();

		definition.mutate((mutable) => {
			mutable.name = "three";
		});

		expect(history.op.unwrap().canRedo).toBe(false);
		expect(history.op.unwrap().stack).toHaveLength(2);

		history.op.unwrap().redo();

		expect(definition.op.unwrap().name).toBe("three");
	});

	it("replays are not recorded", () => {
		const { definition, history } = createFixture();

		definition.mutate((mutable) => {
			mutable.name = "renamed";
		});

		expect(history.op.unwrap().stack).toHaveLength(1);

		history.op.unwrap().undo();

		expect(history.op.unwrap().stack).toHaveLength(1);

		history.op.unwrap().redo();

		expect(history.op.unwrap().stack).toHaveLength(1);
	});

	it("an external mutate clears the stack and recording resumes from the post-external document", () => {
		const { definition, history } = createFixture();

		definition.mutate((mutable) => {
			mutable.name = "local";
		});

		expect(history.op.unwrap().canUndo).toBe(true);

		definition.mutate(
			(mutable) => {
				mutable.name = "reconciled";
			},
			{ external: true },
		);

		expect(history.op.unwrap().canUndo).toBe(false);
		expect(history.op.unwrap().canRedo).toBe(false);
		expect(history.op.unwrap().stack).toHaveLength(0);

		definition.mutate((mutable) => {
			mutable.name = "after";
		});

		expect(history.op.unwrap().stack).toHaveLength(1);

		history.op.unwrap().undo();

		expect(definition.op.unwrap().name).toBe("reconciled");
	});

	it("undo below the bottom and redo past the top are noops", () => {
		const { definition, history } = createFixture();

		definition.mutate((mutable) => {
			mutable.name = "renamed";
		});

		expect(() => {
			history.op.unwrap().redo();
		}).not.toThrow();
		expect(definition.op.unwrap().name).toBe("renamed");

		history.op.unwrap().undo();

		expect(() => {
			history.op.unwrap().undo();
		}).not.toThrow();
		expect(definition.op.unwrap().name).toBe("g");
		expect(history.op.unwrap().canUndo).toBe(false);
	});

	it("canUndo and canRedo are reactive across generations", () => {
		const { definition, history } = createFixture();

		expect(history.op.unwrap().canUndo).toBe(false);
		expect(history.op.unwrap().canRedo).toBe(false);

		definition.mutate((mutable) => {
			mutable.name = "renamed";
		});

		expect(history.op.unwrap().canUndo).toBe(true);
		expect(history.op.unwrap().canRedo).toBe(false);

		history.op.unwrap().undo();

		expect(history.op.unwrap().canUndo).toBe(false);
		expect(history.op.unwrap().canRedo).toBe(true);
	});

	it("a state created outside the group is inaudible", () => {
		const { history } = createFixture();
		const standalone = createState({ x: 0 });

		standalone.mutate((mutable) => {
			mutable.x = 1;
		});

		expect(history.op.unwrap().stack).toHaveLength(0);
		expect(history.op.unwrap().canUndo).toBe(false);
	});

	it("an external clear at the bottom of the stack flips canRedo through the tracked stack length", () => {
		const { definition, history } = createFixture();

		definition.mutate((mutable) => {
			mutable.name = "renamed";
		});

		history.op.unwrap().undo();

		expect(history.op.unwrap().canRedo).toBe(true);

		definition.mutate(
			(mutable) => {
				mutable.name = "reconciled";
			},
			{ external: true },
		);

		expect(history.op.unwrap().canRedo).toBe(false);
	});
});

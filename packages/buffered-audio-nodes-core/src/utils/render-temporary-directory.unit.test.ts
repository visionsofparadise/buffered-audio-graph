import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRenderTemporaryDirectory, scavengeRenderTemporaryDirectories } from "./render-temporary-directory";

vi.mock("node:fs/promises", { spy: true });

let rootDirectory: string;

beforeEach(async () => {
	rootDirectory = await mkdtemp(join(tmpdir(), "render-temporary-directory-test-"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	await rm(rootDirectory, { recursive: true, force: true });
});

async function expectExists(path: string): Promise<void> {
	await expect(access(path)).resolves.toBeUndefined();
}

async function expectMissing(path: string): Promise<void> {
	await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("render temporary directories", () => {
	it("creates unique current-process directories", async () => {
		const first = await createRenderTemporaryDirectory({ rootDirectory });
		const second = await createRenderTemporaryDirectory({ rootDirectory });

		expect(first).not.toBe(second);
		expect(basename(first)).toMatch(new RegExp(`^render-${process.pid}-.+$`));
		expect(basename(second)).toMatch(new RegExp(`^render-${process.pid}-.+$`));
		await expectExists(first);
		await expectExists(second);
	});

	it("tolerates a missing root", async () => {
		const missingRoot = join(rootDirectory, "missing");

		await expect(scavengeRenderTemporaryDirectories({ rootDirectory: missingRoot })).resolves.toBeUndefined();
	});

	it("removes only exactly named directories whose owner is definitely absent", async () => {
		const dead = join(rootDirectory, "render-1001-dead");
		const live = join(rootDirectory, "render-1002-live");
		const unknown = join(rootDirectory, "render-1003-unknown");
		const malformed = join(rootDirectory, "render-not-a-pid-malformed");
		const linkedTarget = join(rootDirectory, "linked-target");
		const linked = join(rootDirectory, "render-1004-linked");
		const file = join(rootDirectory, "render-1005-file");

		await Promise.all([dead, live, unknown, malformed, linkedTarget].map((path) => mkdir(path)));
		await symlink(linkedTarget, linked, "junction");
		await writeFile(file, "retained");

		await scavengeRenderTemporaryDirectories({
			rootDirectory,
			processIsAbsent(pid) {
				if (pid === 1003) throw new Error("probe unavailable");

				return pid === 1001 || pid === 1004 || pid === 1005;
			},
		});

		await expectMissing(dead);
		await Promise.all([live, unknown, malformed, linkedTarget, linked, file].map(expectExists));
	});

	it("the default process probe removes only ESRCH owners", async () => {
		const live = join(rootDirectory, "render-3001-live");
		const dead = join(rootDirectory, "render-3002-dead");
		const uncertain = join(rootDirectory, "render-3003-uncertain");

		await Promise.all([mkdir(live), mkdir(dead), mkdir(uncertain)]);

		vi.spyOn(process, "kill").mockImplementation((pid) => {
			if (pid === 3002) throw Object.assign(new Error("absent"), { code: "ESRCH" });
			if (pid === 3003) throw Object.assign(new Error("denied"), { code: "EPERM" });

			return true;
		});

		await scavengeRenderTemporaryDirectories({ rootDirectory });

		await expectExists(live);
		await expectMissing(dead);
		await expectExists(uncertain);
	});

	it("retains an entry whose removal fails and continues removing other dead entries", async () => {
		const locked = join(rootDirectory, "render-2001-locked");
		const removable = join(rootDirectory, "render-2002-removable");

		await Promise.all([mkdir(locked), mkdir(removable)]);

		const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
		const remove = vi.mocked(rm);

		remove.mockImplementation(async (path, options) => {
			if (path === locked) throw Object.assign(new Error("locked"), { code: "EBUSY" });

			return actual.rm(path, options);
		});

		await scavengeRenderTemporaryDirectories({ rootDirectory, processIsAbsent: () => true });

		await expectExists(locked);
		await expectMissing(removable);
	});
});

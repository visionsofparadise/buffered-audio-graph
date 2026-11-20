import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listModule } from "./listing";

const MODULE_PATH = "plugin.vst3";

const stub = (script: string): { readonly prefixArgs: ReadonlyArray<string> } => ({ prefixArgs: ["-e", script, "--"] });

describe("listModule", () => {
	it("resolves a non-cacheable failure when the CLI hangs past the timeout", async () => {
		const result = await listModule(process.execPath, MODULE_PATH, {
			...stub("setInterval(() => {}, 1000)"),
			timeoutMs: 300,
		});

		expect(result).toMatchObject({ ok: false, cacheable: false });
		expect(result.ok ? "" : result.error).toMatch(/timed out after 300 ms/);
	});

	it("resolves a non-cacheable failure when the CLI is missing", async () => {
		const result = await listModule(join(tmpdir(), "missing-vst-demon-cli"), MODULE_PATH);

		expect(result).toMatchObject({ ok: false, cacheable: false });
		expect(result.ok ? "" : result.error).toMatch(/vst-demon-cli failed to start/);
	});

	it("resolves a non-cacheable failure when the CLI writes more than the stdout cap", async () => {
		const result = await listModule(
			process.execPath,
			MODULE_PATH,
			stub("process.stdout.write(Buffer.alloc(2 * 1024 * 1024, 120))"),
		);

		expect(result).toMatchObject({ ok: false, cacheable: false });
		expect(result.ok ? "" : result.error).toMatch(/wrote more than 1048576 bytes to stdout/);
	});

	it("resolves a cacheable failure with the stderr tail when the CLI exits non-zero", async () => {
		const result = await listModule(
			process.execPath,
			MODULE_PATH,
			stub("process.stderr.write('boom\\n'); process.exit(2)"),
		);

		expect(result).toEqual({ ok: false, cacheable: true, error: "boom" });
	});

	it.skipIf(process.platform === "win32")(
		"resolves a non-cacheable failure when the CLI is killed by a signal",
		async () => {
			const result = await listModule(
				process.execPath,
				MODULE_PATH,
				stub("process.kill(process.pid, 'SIGKILL'); setInterval(() => {}, 1000)"),
			);

			expect(result).toMatchObject({ ok: false, cacheable: false });
			expect(result.ok ? "" : result.error).toMatch(/exited with signal SIGKILL/);
		},
	);

	it("resolves a cacheable failure when the CLI prints output that does not parse", async () => {
		const result = await listModule(process.execPath, MODULE_PATH, stub("process.stdout.write('not json')"));

		expect(result).toMatchObject({ ok: false, cacheable: true });
		expect(result.ok ? "" : result.error).toMatch(/Failed to parse --list output/);
	});
});

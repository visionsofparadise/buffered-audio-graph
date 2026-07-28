import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { resolveBinary } from "./resolve-binary";

vi.mock("node:fs/promises", () => ({
	access: vi.fn(),
	constants: { X_OK: 1 },
}));

vi.mock("node:child_process", () => ({
	execFile: vi.fn(),
}));

vi.mock("node:util", () => ({
	promisify: (fn: unknown) => fn,
}));

const mockAccess = vi.mocked(access);
const mockExecFile = vi.mocked(execFile);

describe("resolveBinary", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = { ...originalEnv };
		vi.clearAllMocks();
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it("resolves provided path when accessible", async () => {
		mockAccess.mockResolvedValue(undefined);

		const result = await resolveBinary("ffmpeg", "/usr/bin/ffmpeg");

		expect(result).toBe("/usr/bin/ffmpeg");
		expect(mockAccess).toHaveBeenCalledWith("/usr/bin/ffmpeg", expect.any(Number));
	});

	it("resolves from environment variable", async () => {
		process.env.FFMPEG_PATH = "/opt/ffmpeg";
		mockAccess.mockResolvedValue(undefined);

		const result = await resolveBinary("ffmpeg");

		expect(result).toBe("/opt/ffmpeg");
	});

	it("resolves from PATH lookup", async () => {
		mockAccess.mockRejectedValue(new Error("ENOENT"));
		(mockExecFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
			stdout: "/usr/local/bin/ffmpeg\n",
			stderr: "",
		});

		const result = await resolveBinary("ffmpeg");

		expect(result).toBe("/usr/local/bin/ffmpeg");
	});

	it("throws descriptive error when binary not found", async () => {
		(mockExecFile as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("not found"));

		await expect(resolveBinary("ffmpeg")).rejects.toThrow(
			'Binary "ffmpeg" not found. Provide a path via the unit\'s binaryPath property or set the FFMPEG_PATH environment variable.',
		);
	});

	it("uses uppercase name for environment variable", async () => {
		process.env.MYBIN_PATH = "/path/to/mybin";
		mockAccess.mockResolvedValue(undefined);

		const result = await resolveBinary("mybin");

		expect(result).toBe("/path/to/mybin");
	});
});

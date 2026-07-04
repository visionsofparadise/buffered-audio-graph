import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { filterOnnxProviders } from "./onnx-providers";

function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value, configurable: true });
}

describe("filterOnnxProviders", () => {
	const originalPlatform = process.platform;

	beforeEach(() => {
	});

	afterEach(() => {
		setPlatform(originalPlatform);
	});

	it("maps gpu→dml on win32", () => {
		setPlatform("win32");
		expect(filterOnnxProviders(["gpu", "cpu"])).toEqual(["dml", "cpu"]);
	});

	it("maps gpu→cuda on linux", () => {
		setPlatform("linux");
		expect(filterOnnxProviders(["gpu", "cpu"])).toEqual(["cuda", "cpu"]);
	});

	it("maps gpu→coreml on darwin", () => {
		setPlatform("darwin");
		expect(filterOnnxProviders(["gpu", "cpu"])).toEqual(["coreml", "cpu"]);
	});

	it("drops cpu-native (ONNX has no CPU-native EP)", () => {
		setPlatform("win32");
		expect(filterOnnxProviders(["gpu", "cpu-native", "cpu"])).toEqual(["dml", "cpu"]);
	});

	it("falls back to ['cpu'] when result would be empty", () => {
		setPlatform("win32");
		expect(filterOnnxProviders(["cpu-native"])).toEqual(["cpu"]);
		expect(filterOnnxProviders([])).toEqual(["cpu"]);
	});

	it("deduplicates while preserving order", () => {
		setPlatform("win32");
		expect(filterOnnxProviders(["gpu", "gpu", "cpu", "cpu"])).toEqual(["dml", "cpu"]);
	});

	it("drops gpu on unknown platforms but keeps cpu", () => {
		setPlatform("freebsd" as NodeJS.Platform);
		expect(filterOnnxProviders(["gpu", "cpu"])).toEqual(["cpu"]);
	});
});

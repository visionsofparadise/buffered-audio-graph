import { describe, expect, it } from "vitest";
import { ByteBoundedCache } from "./byte-bounded-cache";

describe("ByteBoundedCache", () => {
	it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN])("rejects invalid capacity %s", (maxBytes) => {
		expect(() => new ByteBoundedCache(maxBytes)).toThrow("positive finite integer");
	});

	it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN])("rejects invalid entry size %s", (bytes) => {
		const cache = new ByteBoundedCache<string, number>(10);

		expect(() => cache.set("a", 1, bytes)).toThrow("positive finite integer");
	});

	it("accounts for insertion and replacement bytes", () => {
		const cache = new ByteBoundedCache<string, string>(10);

		cache.set("a", "first", 4);
		cache.set("b", "second", 3);

		expect(cache.bytes).toBe(7);
		expect(cache.size).toBe(2);

		cache.set("a", "replacement", 2);

		expect(cache.get("a")).toBe("replacement");
		expect(cache.bytes).toBe(5);
		expect(cache.size).toBe(2);
	});

	it("evicts the oldest insertion and reads do not refresh it", () => {
		const cache = new ByteBoundedCache<string, number>(6);

		cache.set("a", 1, 2);
		cache.set("b", 2, 2);
		cache.set("c", 3, 2);
		expect(cache.get("a")).toBe(1);

		cache.set("d", 4, 2);

		expect(cache.get("a")).toBeUndefined();
		expect(cache.get("b")).toBe(2);
		expect(cache.get("c")).toBe(3);
		expect(cache.get("d")).toBe(4);
		expect(cache.bytes).toBe(6);
	});

	it("treats a replacement as the newest insertion", () => {
		const cache = new ByteBoundedCache<string, number>(4);

		cache.set("a", 1, 2);
		cache.set("b", 2, 2);
		cache.set("a", 3, 2);
		cache.set("c", 4, 2);

		expect(cache.get("a")).toBe(3);
		expect(cache.get("b")).toBeUndefined();
		expect(cache.get("c")).toBe(4);
	});

	it("does not retain an entry larger than the cap", () => {
		const cache = new ByteBoundedCache<string, number>(4);

		cache.set("a", 1, 2);
		cache.set("a", 2, 5);

		expect(cache.get("a")).toBeUndefined();
		expect(cache.bytes).toBe(0);
		expect(cache.size).toBe(0);
	});
});

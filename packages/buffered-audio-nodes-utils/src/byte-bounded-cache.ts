interface CacheEntry<Value> {
	readonly value: Value;
	readonly bytes: number;
}

export class ByteBoundedCache<Key, Value> {
	private readonly entries = new Map<Key, CacheEntry<Value>>();
	private currentBytes = 0;

	constructor(private readonly maxBytes: number) {
		assertPositiveInteger(maxBytes, "ByteBoundedCache maxBytes");
	}

	get bytes(): number {
		return this.currentBytes;
	}

	get size(): number {
		return this.entries.size;
	}

	get(key: Key): Value | undefined {
		return this.entries.get(key)?.value;
	}

	set(key: Key, value: Value, bytes: number): void {
		assertPositiveInteger(bytes, "ByteBoundedCache entry bytes");

		const replaced = this.entries.get(key);

		if (replaced !== undefined) {
			this.entries.delete(key);
			this.currentBytes -= replaced.bytes;
		}

		if (bytes > this.maxBytes) return;

		while (this.currentBytes + bytes > this.maxBytes) {
			const oldest = this.entries.entries().next();

			if (oldest.done) break;

			const [oldestKey, oldestEntry] = oldest.value;

			this.entries.delete(oldestKey);
			this.currentBytes -= oldestEntry.bytes;
		}

		this.entries.set(key, { value, bytes });
		this.currentBytes += bytes;
	}
}

function assertPositiveInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive finite integer, got ${value}`);
	}
}

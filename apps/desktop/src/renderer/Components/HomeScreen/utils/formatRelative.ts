const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

export function formatRelative(ms: number): string {
	const now = Date.now();
	const delta = Math.max(0, now - ms);

	if (delta < MINUTE_MS) return "Just now";

	if (delta < HOUR_MS) {
		const minutes = Math.floor(delta / MINUTE_MS);

		return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
	}

	if (delta < DAY_MS) {
		const hours = Math.floor(delta / HOUR_MS);

		return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
	}

	if (delta < 2 * DAY_MS) return "Yesterday";

	if (delta < WEEK_MS) {
		const days = Math.floor(delta / DAY_MS);

		return `${days} days ago`;
	}

	if (delta < 4 * WEEK_MS) {
		const weeks = Math.floor(delta / WEEK_MS);

		return `${weeks} ${weeks === 1 ? "week" : "weeks"} ago`;
	}

	const date = new Date(ms);
	const formatted = date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

	return `On ${formatted}`;
}

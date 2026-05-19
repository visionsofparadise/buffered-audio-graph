import { Icon } from "@iconify/react";
import { TerrainShader } from "@buffered-audio/design-system";
import type { AppContext } from "../../models/Context";
import type { RecentFile } from "../../models/State/App";

interface Props {
	readonly context: AppContext;
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

function formatRelative(ms: number): string {
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

export function HomeScreen({ context }: Props) {
	const recentFiles: ReadonlyArray<RecentFile> = context.app.recentFiles.slice(0, 6);

	return (
		<div className="relative flex flex-1 flex-col overflow-hidden bg-void">
			<TerrainShader colormap={context.app.theme} className="absolute inset-0" />
			<div className="relative flex h-full flex-col p-4">
				<h1 className="font-display text-[length:6rem] font-bold leading-none tracking-tight text-chrome-text">ENGINEERING</h1>

				<div className="flex-1" />

				<div className="flex flex-col gap-6">
					{recentFiles.length > 0 && (
						<div className="flex flex-col gap-4">
							<span className="font-technical text-[length:var(--text-xs)] uppercase tracking-widest text-chrome-text-dim">Recent Graphs</span>

							<div className="flex flex-col gap-2">
								{recentFiles.map((recent) => (
									<button
										key={recent.id}
										type="button"
										onClick={() => void context.openBagByPath(recent.bagPath)}
										className="flex w-fit items-baseline gap-5 text-left transition-colors duration-100 hover:bg-secondary"
									>
										<span className="font-body text-[length:var(--text-base)] text-chrome-text">{recent.name}</span>
										<span className="font-technical text-[length:var(--text-xs)] text-chrome-text-dim">{recent.bagPath}</span>
										<span className="font-technical text-[length:var(--text-xs)] text-chrome-text-dim">{formatRelative(recent.lastOpened)}</span>
									</button>
								))}
							</div>
						</div>
					)}

					<div className="flex flex-col gap-2">
						<button
							type="button"
							onClick={() => void context.newBagTab()}
							className="flex w-fit items-center gap-2 font-technical text-[length:var(--text-sm)] uppercase tracking-[0.06em] text-void transition-colors hover:brightness-110"
						>
							<span className="flex items-center gap-2 bg-primary">
								<Icon icon="lucide:plus" width={16} />
								New Graph
							</span>
						</button>
						<button
							type="button"
							onClick={() => void context.openBagTab()}
							className="flex w-fit items-center gap-2 font-technical text-[length:var(--text-sm)] uppercase tracking-[0.06em] text-chrome-text transition-colors hover:brightness-125"
						>
							<span className="flex items-center gap-2 bg-secondary">
								<Icon icon="lucide:folder-open" width={16} />
								Open Graph
							</span>
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}

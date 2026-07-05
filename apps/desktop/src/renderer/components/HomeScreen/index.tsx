import { Barcode, HomeGraphDecoration, barcodeWidth, type HomeGraphAnchor } from "@buffered-audio/design-system";
import { FolderOpen, Plus } from "lucide-react";
import type { AppContext } from "../../models/Context";
import { resnapshot } from "../../models/ProxyStore/resnapshot";
import type { RecentFile } from "../../models/State/App";
import { ProjectIcon } from "../ProjectIcon";

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

const HOME_BARCODE_TEXT = "BUFFERED AUDIO GRAPH MANAGER";
const HOME_BARCODE_NARROW = 1;
const HOME_BARCODE_WIDE = 3;
const HOME_BARCODE_LENGTH = barcodeWidth(HOME_BARCODE_TEXT, HOME_BARCODE_NARROW, HOME_BARCODE_WIDE, 0);

export const HomeScreen = resnapshot<Props>(({ context }: Props) => {
	const recentFiles: ReadonlyArray<RecentFile> = context.app.recentFiles.slice(0, 6);

	const anchors: ReadonlyArray<HomeGraphAnchor> = recentFiles.map((recent) => ({
		id: recent.id,
		label: recent.name,
		secondaryLabel: formatRelative(recent.lastOpened),
		icon: <ProjectIcon name={recent.name} size={18} />,
	}));

	const openAnchor = (id: string): void => {
		const match = recentFiles.find((recent) => recent.id === id);

		if (match) {
			void context.openBagByPath(match.bagPath);
		}
	};

	return (
		<div className="relative flex flex-1 flex-col overflow-hidden bg-surface p-6">
			<div className="pointer-events-none absolute right-4 top-6 z-0 flex items-start gap-4">
				<span
					className="type-label text-dimmed"
					style={{ writingMode: "vertical-rl" }}
				>
					Buffered Audio Graph Manager
				</span>
				<div
					className="relative w-8"
					style={{ height: HOME_BARCODE_LENGTH }}
				>
					<div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rotate-90">
						<Barcode
							text={HOME_BARCODE_TEXT}
							narrow={HOME_BARCODE_NARROW}
							wide={HOME_BARCODE_WIDE}
							height={28}
							color="var(--color-border)"
						/>
					</div>
				</div>
			</div>

			<h1 className="type-display text-display-lg leading-none text-text-primary">
				BAGMAN
			</h1>

			<div className="relative z-10 min-h-0 flex-1">
				<HomeGraphDecoration anchors={anchors} onAnchorClick={openAnchor} />
			</div>

			<span className="type-label pointer-events-none absolute bottom-6 left-6 z-20 text-dimmed">
				&copy; ZCROSS
			</span>

			<div className="absolute right-6 bottom-6 z-20 flex flex-col items-end gap-3">
				<button
					type="button"
					onClick={() => void context.newBagTab()}
					className="flex w-fit items-center gap-2 px-4 py-2 text-body text-text-primary hover:bg-text-primary hover:text-surface"
				>
					<Plus size={16} strokeWidth={1.5} />
					<span>New graph</span>
				</button>
				<button
					type="button"
					onClick={() => void context.openBagTab()}
					className="flex w-fit items-center gap-2 px-4 py-2 text-body text-text-primary hover:bg-text-primary hover:text-surface"
				>
					<FolderOpen size={16} strokeWidth={1.5} />
					<span>Open graph</span>
				</button>
			</div>
		</div>
	);
});

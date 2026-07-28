import { HomeGraphDecoration, type HomeGraphAnchor } from "./HomeGraphDecoration";
import { FolderOpen, Plus } from "lucide-react";
import { retrack } from "opshot/react";
import { cn } from "../../utils/cn";
import type { AppContext } from "../../Models/Context";
import type { RecentFile } from "../../Models/State/App";
import { ProjectIcon } from "../UI/ProjectIcon";
import { formatRelative } from "./utils/formatRelative";
import { HOME_BARCODE_ACCENT, HOME_BARCODE_BARS } from "./utils/homeBarcodeBars";

interface Props {
	readonly context: AppContext;
}

export const HomeScreen = retrack<Props>(({ context }: Props) => {
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
			<div className="pointer-events-none absolute right-4 top-6 z-0 flex items-start gap-3.5">
				<span className="type-label writing-vertical-rl text-dimmed">Buffered Audio Graph Manager</span>
				<div className="flex w-[30px] flex-col gap-0.5">
					{HOME_BARCODE_BARS.map((thickness, ix) => (
						<div
							key={`bar-${ix}`}
							className={cn("w-full shrink-0", HOME_BARCODE_ACCENT.has(ix) ? "bg-accent-primary" : "bg-border")}
							style={{ height: thickness }}
						/>
					))}
				</div>
			</div>

			<h1 className="type-display text-display-lg leading-none text-text-primary">BAGMAN</h1>

			<div className="relative z-10 min-h-0 flex-1">
				<HomeGraphDecoration anchors={anchors} onAnchorClick={openAnchor} />
			</div>

			<span className="type-label pointer-events-none absolute bottom-6 left-6 z-20 text-dimmed">&copy; ZCROSS</span>

			<div className="absolute right-6 bottom-6 z-20 flex flex-col items-end gap-3">
				<button
					type="button"
					onClick={() => void context.newBagTab()}
					className="flex w-fit items-center gap-2 px-4 py-2 text-body text-accent-primary hover:bg-accent-primary hover:text-surface"
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

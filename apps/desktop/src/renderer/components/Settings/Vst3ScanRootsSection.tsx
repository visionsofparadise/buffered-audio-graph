import { Plus, X } from "lucide-react";
import { retrack } from "opshot/react";
import { useCallback } from "react";
import type { AppContext } from "../../models/Context";
import { Button } from "../Button";

interface Props {
	readonly context: AppContext;
}

export const Vst3ScanRootsSection = retrack<Props>(({ context }: Props) => {
	const { app, main } = context;

	const scanRoots = app.vst3ScanRoots;

	const handleAddRoot = useCallback(async () => {
		const result = await main.showOpenDialog({
			title: "Select VST3 scan folder",
			properties: ["openDirectory"],
		});

		const selectedPath = result?.[0];

		if (!selectedPath) return;

		if (scanRoots.includes(selectedPath)) return;

		app.mutate((mutable) => {
			if (mutable.vst3ScanRoots.includes(selectedPath)) return;

			mutable.vst3ScanRoots.push(selectedPath);
		});

		// Rescan against the next roots; open pickers refresh via vst3:scanUpdate.
		void main.vst3ScanPlugins([...scanRoots, selectedPath]);
	}, [main, app, scanRoots]);

	const handleRemoveRoot = useCallback(
		(root: string) => {
			const nextRoots = scanRoots.filter((entry) => entry !== root);

			app.mutate((mutable) => {
				mutable.vst3ScanRoots = mutable.vst3ScanRoots.filter((entry) => entry !== root);
			});

			void main.vst3ScanPlugins([...nextRoots]);
		},
		[main, app, scanRoots],
	);

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center justify-between">
				<h3 className="type-label text-text-secondary">VST3 scan roots</h3>
				<Button
					variant="outline"
					size="sm"
					icon={Plus}
					onClick={() => void handleAddRoot()}
				>
					Add folder
				</Button>
			</div>

			{scanRoots.length === 0 ? (
				<p className="text-dimmed text-xs">No scan roots configured. Add a folder to discover installed VST3 plugins.</p>
			) : (
				<ul className="flex flex-col gap-2">
					{scanRoots.map((root) => (
						<li
							key={root}
							className="flex items-center gap-2"
						>
							<span
								className="text-sm text-text-secondary flex-1 truncate"
								title={root}
							>
								{root}
							</span>
							<Button
								variant="ghost"
								size="sm"
								aria-label={`Remove ${root}`}
								onClick={() => handleRemoveRoot(root)}
							>
								<X
									size={14}
									strokeWidth={1.5}
									aria-hidden="true"
								/>
							</Button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
});

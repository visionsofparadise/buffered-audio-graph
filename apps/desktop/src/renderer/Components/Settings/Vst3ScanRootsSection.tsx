import { Plus, X } from "lucide-react";
import { identify, scope } from "opshot";
import { useCallback } from "react";
import { Button } from "../UI/Button";
import type { AppContext } from "../../Models/Context";

interface Props {
	readonly context: AppContext;
}

export const Vst3ScanRootsSection = scope<Props>(({ context }: Props) => {
	const { app, main } = context;

	const scanRoots = app.vst3ScanRoots;

	const handleAddRoot = useCallback(async () => {
		const result = await main.showOpenDialog({
			title: "Select VST3 scan folder",
			properties: ["openDirectory"],
		});

		const selectedPath = result?.[0];

		if (!selectedPath) return;

		if (app.vst3ScanRoots.includes(selectedPath)) return;

		app.vst3ScanRoots.push(selectedPath);

		void main.vst3ScanPlugins([...app.vst3ScanRoots]);
	}, [main, identify(app)]);

	const handleRemoveRoot = useCallback(
		(root: string) => {
			const nextRoots = app.vst3ScanRoots.filter((entry) => entry !== root);

			app.vst3ScanRoots = nextRoots;

			void main.vst3ScanPlugins([...nextRoots]);
		},
		[main, identify(app)],
	);

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center justify-between">
				<h3 className="type-label text-text-secondary">VST3 scan roots</h3>
				<Button variant="outline" size="sm" icon={Plus} onClick={() => void handleAddRoot()}>
					Add folder
				</Button>
			</div>

			{scanRoots.length === 0 ? (
				<p className="text-dimmed text-xs">
					No scan roots configured. Add a folder to discover installed VST3 plugins.
				</p>
			) : (
				<ul className="flex flex-col gap-2">
					{scanRoots.map((root) => (
						<li key={root} className="flex items-center gap-2">
							<span className="text-sm text-text-secondary flex-1 truncate" title={root}>
								{root}
							</span>
							<Button
								variant="ghost"
								size="sm"
								aria-label={`Remove ${root}`}
								onClick={() => handleRemoveRoot(root)}
							>
								<X size={14} strokeWidth={1.5} aria-hidden="true" />
							</Button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
});

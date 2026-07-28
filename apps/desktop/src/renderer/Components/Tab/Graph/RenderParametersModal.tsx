import { useEffect, useMemo, useState } from "react";
import { Button } from "../../UI/Button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../UI/Dialog";
import { Input } from "../../UI/Input";
import { humanizeFieldName } from "./Node/ParameterRow/utils/labels";
import { seedValues } from "./utils/seedValues";

export interface RenderParametersModalProps {
	readonly isOpen: boolean;
	readonly names: ReadonlyArray<string>;
	readonly initialValues: Record<string, string>;
	readonly onCancel: () => void;
	readonly onConfirm: (values: Record<string, string>) => void;
}

export function RenderParametersModal({
	isOpen,
	names,
	initialValues,
	onCancel,
	onConfirm,
}: RenderParametersModalProps) {
	const [values, setValues] = useState<Record<string, string>>(() => seedValues(names, initialValues));

	useEffect(() => {
		if (!isOpen) return;

		setValues(seedValues(names, initialValues));
	}, [isOpen, names, initialValues]);

	const allFilled = useMemo(() => names.every((name) => (values[name] ?? "") !== ""), [names, values]);

	const handleConfirm = (): void => {
		if (!allFilled) return;

		const confirmed: Record<string, string> = {};

		for (const name of names) {
			confirmed[name] = values[name] ?? "";
		}

		onConfirm(confirmed);
	};

	return (
		<Dialog
			open={isOpen}
			onOpenChange={(open) => {
				if (!open) onCancel();
			}}
		>
			<DialogContent className="w-[420px]">
				<DialogHeader>
					<DialogTitle>Render parameters</DialogTitle>
					<DialogClose asChild>
						<Button variant="ghost" size="sm" data-render-params-cancel>
							Cancel
						</Button>
					</DialogClose>
				</DialogHeader>

				<div className="flex flex-col gap-4 overflow-y-auto px-6 py-2">
					{names.map((name) => (
						<Input
							key={name}
							label={humanizeFieldName(name)}
							value={values[name] ?? ""}
							onChange={(next) => {
								setValues((previous) => ({ ...previous, [name]: next }));
							}}
							data-render-param-input={name}
							className="w-full"
						/>
					))}
				</div>

				<DialogFooter>
					<Button
						variant="default"
						size="sm"
						onClick={handleConfirm}
						disabled={!allFilled}
						data-render-params-confirm
					>
						Render
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

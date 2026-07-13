import { useState } from "react";

interface TabNameInputProps {
	readonly tabId: string;
	readonly label: string;
	readonly onRename: (tabId: string, name: string) => void;
}

/**
 * Editable name for the active tab, edited in place as an `<input>`. The input
 * auto-sizes to its content via an invisible sizing span sharing one grid cell,
 * so the active tab keeps the width of its label instead of jumping to a fixed
 * size. Commits on blur and Enter, reverts to the current label on Escape.
 * `key`ed by `tabId` + `label` upstream so it re-initialises whenever the active
 * tab or its name changes.
 */
export function TabNameInput({ tabId, label, onRename }: TabNameInputProps) {
	const [value, setValue] = useState(label);

	const commit = (): void => {
		const trimmed = value.trim();

		if (trimmed && trimmed !== label) {
			onRename(tabId, trimmed);
		} else {
			setValue(label);
		}
	};

	return (
		<span className="inline-grid max-w-[180px] items-center">
			<span
				aria-hidden="true"
				className="invisible col-start-1 row-start-1 whitespace-pre pr-px"
			>
				{value || " "}
			</span>
			<input
				type="text"
				size={1}
				value={value}
				onChange={(event) => setValue(event.target.value)}
				onBlur={commit}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						commit();
						event.currentTarget.blur();
					} else if (event.key === "Escape") {
						setValue(label);
						event.currentTarget.blur();
					}

					event.stopPropagation();
				}}
				onClick={(event) => event.stopPropagation()}
				title={label}
				style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
				className="col-start-1 row-start-1 w-full min-w-0 bg-transparent text-inherit outline-none"
			/>
		</span>
	);
}

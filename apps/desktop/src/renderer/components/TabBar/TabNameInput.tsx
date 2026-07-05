import { useState } from "react";

interface TabNameInputProps {
	readonly tabId: string;
	readonly label: string;
	readonly onRename: (tabId: string, name: string) => void;
}

/**
 * Editable name for the active tab. Always rendered as an `<input>` so the
 * selected tab's name can be edited in place. Commits on blur and Enter,
 * reverts to the current label on Escape. `key`ed by `tabId` + `label` upstream
 * so it re-initialises whenever the active tab or its name changes.
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
		<input
			type="text"
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
			className="w-32 max-w-[180px] bg-transparent text-inherit outline-none"
		/>
	);
}

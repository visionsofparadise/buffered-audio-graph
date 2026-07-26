import { useState } from "react";

interface TabNameInputProps {
	readonly tabId: string;
	readonly label: string;
	readonly onRename: (tabId: string, name: string) => void;
}

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
				className="app-no-drag col-start-1 row-start-1 w-full min-w-0 bg-transparent text-inherit outline-none"
			/>
		</span>
	);
}

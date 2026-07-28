import { useEffect, useRef, useState, type KeyboardEvent } from "react";

export interface CommittedTextField {
	readonly value: string;
	readonly onChange?: (next: string) => void;
	readonly onBlur?: () => void;
	readonly onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
}

export function useCommittedText(value: string, onCommit?: (next: string) => void): CommittedTextField {
	const [local, setLocal] = useState(value);
	const localRef = useRef(value);

	useEffect(() => {
		localRef.current = value;
		setLocal(value);
	}, [value]);

	if (!onCommit) return { value: local };

	return {
		value: local,
		onChange: (next) => {
			localRef.current = next;
			setLocal(next);
		},
		onBlur: () => {
			const next = localRef.current;

			if (next === value) return;

			onCommit(next);
		},
		onKeyDown: (event) => {
			if (event.key === "Enter") {
				event.currentTarget.blur();
			}
		},
	};
}

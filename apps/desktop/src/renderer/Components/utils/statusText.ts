import type { NodePackageState } from "../../Models/State/App";

export function statusText(status: NodePackageState["status"]): string {
	switch (status) {
		case "installing":
			return "Installing";
		default:
			return "";
	}
}

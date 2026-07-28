import { retrack } from "opshot/react";
import { HomeScreen } from "../HomeScreen";
import { Graph } from "./Graph";
import type { AppContext } from "../../Models/Context";

interface Props {
	readonly context: AppContext;
}

export const Tab = retrack<Props>(({ context }: Props) => {
	const activeTab = context.app.activeTabId
		? context.app.tabs.find((tab) => tab.id === context.app.activeTabId)
		: null;

	if (!activeTab) {
		return <HomeScreen context={context} />;
	}

	return <Graph key={activeTab.id} tab={activeTab} context={context} />;
});

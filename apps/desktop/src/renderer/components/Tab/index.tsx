import { retrack } from "opshot/react";
import type { AppContext } from "../../models/Context";
import { HomeScreen } from "../HomeScreen";
import { GraphView } from "./Graph";

interface Props {
	readonly context: AppContext;
}

export const TabContent = retrack<Props>(({ context }: Props) => {
	const activeTab = context.app.activeTabId ? context.app.tabs.find((tab) => tab.id === context.app.activeTabId) : null;

	if (!activeTab) {
		return <HomeScreen context={context} />;
	}

	return (
		<GraphView
			key={activeTab.id}
			tab={activeTab}
			context={context}
		/>
	);
});

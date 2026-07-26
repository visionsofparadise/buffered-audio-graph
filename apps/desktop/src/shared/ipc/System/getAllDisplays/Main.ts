import { screen } from "electron";
import { AsyncMainIpc } from "../../../Models/AsyncMainIpc";
import { GET_ALL_DISPLAYS_ACTION, type GetAllDisplaysIpcParameters, type GetAllDisplaysIpcReturn } from "./Renderer";

export class GetAllDisplaysMainIpc extends AsyncMainIpc<GetAllDisplaysIpcParameters, GetAllDisplaysIpcReturn> {
	action = GET_ALL_DISPLAYS_ACTION;

	handler(): GetAllDisplaysIpcReturn {
		return screen.getAllDisplays().map((display) => {
			const { x, y, width, height } = display.workArea;

			return { x, y, width, height };
		});
	}
}

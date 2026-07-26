import { AsyncMainIpc, type IpcHandlerDependencies } from "../../../Models/AsyncMainIpc";
import { ABORT_JOB_ACTION, type AbortJobIpcParameters, type AbortJobIpcReturn } from "./Renderer";

export class AbortJobMainIpc extends AsyncMainIpc<AbortJobIpcParameters, AbortJobIpcReturn> {
	action = ABORT_JOB_ACTION;

	handler(jobId: string, dependencies: IpcHandlerDependencies): AbortJobIpcReturn {
		dependencies.jobManager.abortJob(jobId);

		return undefined;
	}
}

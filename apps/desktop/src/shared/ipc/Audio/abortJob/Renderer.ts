import { AsyncRendererIpc } from "../../../Models/AsyncRendererIpc";

export type AbortJobIpcParameters = [jobId: string];
export type AbortJobIpcReturn = undefined;
export const ABORT_JOB_ACTION = "audioAbortJob" as const;

export class AbortJobRendererIpc extends AsyncRendererIpc<typeof ABORT_JOB_ACTION, AbortJobIpcParameters, AbortJobIpcReturn> {
	action = ABORT_JOB_ACTION;
}

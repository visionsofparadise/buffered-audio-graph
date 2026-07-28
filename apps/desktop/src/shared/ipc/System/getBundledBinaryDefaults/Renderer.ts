import { AsyncRendererIpc } from "../../../Models/AsyncRendererIpc";

export type GetBundledBinaryDefaultsIpcParameters = [];
export type GetBundledBinaryDefaultsIpcReturn = Record<string, string>;
export const GET_BUNDLED_BINARY_DEFAULTS_ACTION = "getBundledBinaryDefaults" as const;

export class GetBundledBinaryDefaultsRendererIpc extends AsyncRendererIpc<
	typeof GET_BUNDLED_BINARY_DEFAULTS_ACTION,
	GetBundledBinaryDefaultsIpcParameters,
	GetBundledBinaryDefaultsIpcReturn
> {
	action = GET_BUNDLED_BINARY_DEFAULTS_ACTION;
}

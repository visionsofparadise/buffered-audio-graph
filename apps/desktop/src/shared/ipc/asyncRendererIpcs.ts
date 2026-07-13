import type { IpcHandlerAction, IpcHandlerParameters, IpcHandlerReturn } from "../models/AsyncRendererIpc";
import { AbortJobRendererIpc } from "./Audio/abortJob/Renderer";
import { RenderGraphRendererIpc } from "./Audio/renderGraph/Renderer";
import { ShowOpenDialogRendererIpc } from "./Dialog/showOpenDialog/Renderer";
import { ValidateGraphDefinitionRendererIpc } from "./Graph/validateDefinition/Renderer";
import { ShowSaveDialogRendererIpc } from "./Dialog/showSaveDialog/Renderer";
import { DeleteFileRendererIpc } from "./FileSystem/deleteFile/Renderer";
import { EnsureDirectoryRendererIpc } from "./FileSystem/ensureDirectory/Renderer";
import { ReadDirectoryRendererIpc } from "./FileSystem/readDirectory/Renderer";
import { ReadFileRendererIpc } from "./FileSystem/readFile/Renderer";
import { ReadFileChunkRendererIpc } from "./FileSystem/readFileChunk/Renderer";
import { StatRendererIpc } from "./FileSystem/stat/Renderer";
import { UnwatchFileRendererIpc } from "./FileSystem/unwatchFile/Renderer";
import { WatchFileRendererIpc } from "./FileSystem/watchFile/Renderer";
import { WriteFileRendererIpc } from "./FileSystem/writeFile/Renderer";
import { InstallPackageRendererIpc } from "./Package/install/Renderer";
import { LoadPackageNodesRendererIpc } from "./Package/loadNodes/Renderer";
import { UnloadPackageNodesRendererIpc } from "./Package/unloadNodes/Renderer";
import { GetAllDisplaysRendererIpc } from "./System/getAllDisplays/Renderer";
import { GetAppVersionRendererIpc } from "./System/getAppVersion/Renderer";
import { GetUserDataPathRendererIpc } from "./System/getUserDataPath/Renderer";
import { GetBundledBinaryDefaultsRendererIpc } from "./System/getBundledBinaryDefaults/Renderer";
import { ListBundledBinariesRendererIpc } from "./System/listBundledBinaries/Renderer";
import { GetWindowIdRendererIpc } from "./System/getWindowId/Renderer";
import { OpenPathRendererIpc } from "./System/openPath/Renderer";
import { QuitAppRendererIpc } from "./System/quitApp/Renderer";
import { SetBoundsRendererIpc } from "./System/setBounds/Renderer";
import { Vst3GetDefaultScanRootsRendererIpc } from "./Vst3/getDefaultScanRoots/Renderer";
import { Vst3ScanPluginsRendererIpc } from "./Vst3/scanPlugins/Renderer";
import { Vst3LaunchEditorRendererIpc } from "./Vst3/launchEditor/Renderer";

export const ASYNC_RENDERER_IPCS = [
	AbortJobRendererIpc,
	RenderGraphRendererIpc,
	DeleteFileRendererIpc,
	EnsureDirectoryRendererIpc,
	ReadDirectoryRendererIpc,
	ReadFileRendererIpc,
	ReadFileChunkRendererIpc,
	StatRendererIpc,
	UnwatchFileRendererIpc,
	WatchFileRendererIpc,
	WriteFileRendererIpc,
	InstallPackageRendererIpc,
	LoadPackageNodesRendererIpc,
	UnloadPackageNodesRendererIpc,
	ValidateGraphDefinitionRendererIpc,
	ShowOpenDialogRendererIpc,
	ShowSaveDialogRendererIpc,
	GetAllDisplaysRendererIpc,
	GetUserDataPathRendererIpc,
	GetWindowIdRendererIpc,
	GetAppVersionRendererIpc,
	GetBundledBinaryDefaultsRendererIpc,
	ListBundledBinariesRendererIpc,
	OpenPathRendererIpc,
	QuitAppRendererIpc,
	SetBoundsRendererIpc,
	Vst3GetDefaultScanRootsRendererIpc,
	Vst3ScanPluginsRendererIpc,
	Vst3LaunchEditorRendererIpc,
];

export type AsyncIpcAction = IpcHandlerAction<InstanceType<(typeof ASYNC_RENDERER_IPCS)[number]>>;
export type AsyncIpcParameters<A extends AsyncIpcAction> = IpcHandlerParameters<Extract<InstanceType<(typeof ASYNC_RENDERER_IPCS)[number]>, { action: A }>>;
export type AsyncIpcReturn<A extends AsyncIpcAction> = IpcHandlerReturn<Extract<InstanceType<(typeof ASYNC_RENDERER_IPCS)[number]>, { action: A }>>;

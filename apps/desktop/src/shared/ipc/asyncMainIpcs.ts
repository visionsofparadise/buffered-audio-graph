import { AbortJobMainIpc } from "./Audio/abortJob/Main";
import { RenderNodeMainIpc } from "./Audio/renderNode/Main";
import { ShowOpenDialogMainIpc } from "./Dialog/showOpenDialog/Main";
import { ValidateGraphDefinitionMainIpc } from "./Graph/validateDefinition/Main";
import { ShowSaveDialogMainIpc } from "./Dialog/showSaveDialog/Main";
import { DeleteFileMainIpc } from "./FileSystem/deleteFile/Main";
import { EnsureDirectoryMainIpc } from "./FileSystem/ensureDirectory/Main";
import { ReadDirectoryMainIpc } from "./FileSystem/readDirectory/Main";
import { ReadFileMainIpc } from "./FileSystem/readFile/Main";
import { ReadFileChunkMainIpc } from "./FileSystem/readFileChunk/Main";
import { StatMainIpc } from "./FileSystem/stat/Main";
import { UnwatchFileMainIpc } from "./FileSystem/unwatchFile/Main";
import { WatchFileMainIpc } from "./FileSystem/watchFile/Main";
import { WriteFileMainIpc } from "./FileSystem/writeFile/Main";
import { InstallPackageMainIpc } from "./Package/install/Main";
import { LoadPackageNodesMainIpc } from "./Package/loadNodes/Main";
import { UnloadPackageNodesMainIpc } from "./Package/unloadNodes/Main";
import { GetAllDisplaysMainIpc } from "./System/getAllDisplays/Main";
import { GetAppVersionMainIpc } from "./System/getAppVersion/Main";
import { GetUserDataPathMainIpc } from "./System/getUserDataPath/Main";
import { GetBundledBinaryDefaultsMainIpc } from "./System/getBundledBinaryDefaults/Main";
import { ListBundledBinariesMainIpc } from "./System/listBundledBinaries/Main";
import { GetWindowIdMainIpc } from "./System/getWindowId/Main";
import { OpenPathMainIpc } from "./System/openPath/Main";
import { QuitAppMainIpc } from "./System/quitApp/Main";
import { SetBoundsMainIpc } from "./System/setBounds/Main";

export const ASYNC_MAIN_IPCS = [
	AbortJobMainIpc,
	RenderNodeMainIpc,
	DeleteFileMainIpc,
	EnsureDirectoryMainIpc,
	ReadDirectoryMainIpc,
	ReadFileMainIpc,
	ReadFileChunkMainIpc,
	StatMainIpc,
	UnwatchFileMainIpc,
	WatchFileMainIpc,
	WriteFileMainIpc,
	InstallPackageMainIpc,
	LoadPackageNodesMainIpc,
	UnloadPackageNodesMainIpc,
	ValidateGraphDefinitionMainIpc,
	ShowOpenDialogMainIpc,
	ShowSaveDialogMainIpc,
	GetAllDisplaysMainIpc,
	GetUserDataPathMainIpc,
	GetWindowIdMainIpc,
	GetAppVersionMainIpc,
	GetBundledBinaryDefaultsMainIpc,
	ListBundledBinariesMainIpc,
	OpenPathMainIpc,
	QuitAppMainIpc,
	SetBoundsMainIpc,
];

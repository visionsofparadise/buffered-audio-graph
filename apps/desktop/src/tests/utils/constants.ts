import { join, resolve } from "node:path";

const DESKTOP_DIR = resolve(import.meta.dirname, "../../..");

export const REPO_ROOT = resolve(DESKTOP_DIR, "..", "..");
export const PROFILE_DIR = join(DESKTOP_DIR, ".smoke-profile");
export const BAG_PATH = join(DESKTOP_DIR, ".smoke-seed.bag");
export const RESTORED_BAG_PATH = join(PROFILE_DIR, "smoke-restored.bag");
export const BAG_NAME = "Smoke Bag";
export const RESTORED_BAG_NAME = "Restored Bag";
export const PATH_SENTINEL = "C:/smoke/input.wav";
export const INPUT_WAV_PATH = join(PROFILE_DIR, "smoke-input.wav");
export const OUTPUT_WAV_PATH = join(PROFILE_DIR, "smoke-output.wav");
export const TEMPLATED_WRITE_PATH = "{{outDir}}/templated-out.wav";
export const TEMPLATED_OUTPUT_WAV_PATH = join(PROFILE_DIR, "templated-out.wav");

export const BUILTIN_PACKAGE = "@buffered-audio/nodes";
export const STALE_BUILTIN_VERSION = "0.22.0";
export const ZERO_TARGET_MIN_VERSION = "0.21.0";

export const SOURCE_NODE = "Read WAV";
export const TRANSFORM_NODE = "Gain";
export const DUPLICATE_CHANNELS_NODE = "Duplicate Channels";
export const WRITE_NODE = "Write";
export const VST3_NODE = "VST3";
export const OTT_MATCH = "OTT";

export const DEBOUNCE_WAIT_MS = 1300;

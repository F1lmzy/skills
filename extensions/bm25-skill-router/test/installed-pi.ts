import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const piDir = process.env.PI_PACKAGE_DIR ?? join(homedir(), ".local/lib/node_modules/@earendil-works/pi-coding-agent");
// These tests exercise the installed Pi 1.5.2 distribution, not a separately installed SDK.
export const loadPi = () => import(pathToFileURL(join(piDir, "dist/index.js")).href);
export const loadPiAI = () => import(pathToFileURL(join(piDir, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);

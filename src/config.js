// Bridge settings live in omp's plugin runtime config (the same store edited by
// `omp plugin config` and the /settings → Plugins overlay). Defaults come from
// the `omp.settings` schema in package.json. Slack tokens are kept out of that
// (world-readable) lockfile, in a 0600 file under the bridge state dir.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_NAME = "omp-slack";
export const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
export const STATE_DIR = process.env.SLACK_STATE_DIR || join(homedir(), ".local/share/omp-slack");
export const TOKENS_FILE = join(STATE_DIR, "tokens.json");
export const SERVICE = "omp-slack.service";

const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")).omp;

/** omp's user plugin root: `$XDG_DATA_HOME/omp/plugins` once `omp config init-xdg` ran, else `~/.omp/plugins`. */
export function pluginsDir() {
	const xdg = join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "omp/plugins");
	return existsSync(join(xdg, "omp-plugins.lock.json")) ? xdg : join(homedir(), ".omp/plugins");
}

export const lockfilePath = () => join(pluginsDir(), "omp-plugins.lock.json");

/**
 * Effective settings: persisted value, else schema default.
 * @returns {{allowedUsers: Set<string>, cwd: string, model: string, thinking: string, progress: string}}
 */
export function loadSettings() {
	let stored = {};
	try {
		stored = JSON.parse(readFileSync(lockfilePath(), "utf8")).settings?.[PLUGIN_NAME] ?? {};
	} catch {
		// Missing or mid-write lockfile: fall back to defaults.
	}
	const value = (key) => stored[key] ?? manifest.settings[key].default;
	return {
		allowedUsers: new Set(
			String(value("allowedUsers"))
				.split(/[\s,]+/)
				.map((id) => id.trim().toUpperCase())
				.filter(Boolean),
		),
		cwd: String(value("cwd")).trim().replace(/^~(?=\/|$)/, homedir()) || homedir(),
		model: String(value("model")).trim(),
		thinking: value("thinking"),
		progress: value("progress"),
	};
}

/** @returns {{botToken?: string, appToken?: string}} */
export function loadTokens() {
	try {
		return JSON.parse(readFileSync(TOKENS_FILE, "utf8"));
	} catch {
		return {};
	}
}

export function saveTokens(tokens) {
	mkdirSync(dirname(TOKENS_FILE), { recursive: true, mode: 0o700 });
	writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
	chmodSync(TOKENS_FILE, 0o600); // `mode` only applies when the file is created
}

// Project directory resolution (/cd) and session listing (/resume) for the bridge.
import { existsSync, openSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const home = homedir();
const PROJECT_ROOT = join(home, "Github");
const SEARCH_DEPTH = 3;

const isDir = (p) => {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
};

/**
 * Resolve a /cd argument: an absolute or ~ path, a path relative to ~/Github, or a
 * directory name searched under ~/Github (depth ≤ 3, dot/vendor dirs skipped).
 * @returns {{dir: string} | {candidates: string[]} | {error: string}}
 */
export function resolveProject(arg) {
	const raw = arg.trim().replace(/^~(?=\/|$)/, home);
	if (isAbsolute(raw)) return isDir(raw) ? { dir: resolve(raw) } : { error: `No such folder: ${raw}` };
	const direct = join(PROJECT_ROOT, raw);
	if (raw.includes("/") && isDir(direct)) return { dir: direct };

	const want = basename(raw).toLowerCase();
	const found = [];
	const walk = (dir, depth) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules" || e.name === "vendor") continue;
			const p = join(dir, e.name);
			if (e.name.toLowerCase() === want) found.push(p);
			if (depth < SEARCH_DEPTH) walk(p, depth + 1);
		}
	};
	walk(PROJECT_ROOT, 1);
	if (found.length === 1) return { dir: found[0] };
	if (found.length > 1) return { candidates: found };
	return { error: `No folder named "${raw}" under ${PROJECT_ROOT}` };
}

/** Display a path relative to home. */
export const tildify = (p) => (p === home ? "~" : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);

/** Title of a session file: its leading `title` record or `session` header, else null. */
function sessionTitle(file) {
	const fd = openSync(file, "r");
	try {
		const buf = Buffer.alloc(4096);
		const n = readSync(fd, buf, 0, buf.length, 0);
		for (const line of buf.subarray(0, n).toString("utf8").split("\n").slice(0, 3)) {
			try {
				const rec = JSON.parse(line);
				if (rec.title) return rec.title;
			} catch {
				// truncated line at the buffer edge
			}
		}
		return null;
	} finally {
		closeSync(fd);
	}
}

/**
 * Sessions stored next to `sessionFile` (omp keeps one directory per cwd), newest first.
 * @returns {Array<{file: string, title: string|null, mtime: Date}>}
 */
export function listSessions(sessionFile, limit = 10) {
	if (!sessionFile) return [];
	const dir = dirname(sessionFile);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".jsonl"))
		.map((f) => {
			const file = join(dir, f);
			return { file, mtime: statSync(file).mtime };
		})
		.sort((a, b) => b.mtime - a.mtime)
		.slice(0, limit)
		.map((s) => ({ ...s, title: sessionTitle(s.file) }));
}

/** "5 min ago" style age. */
export function ago(date) {
	const s = Math.max(0, (Date.now() - date.getTime()) / 1000);
	if (s < 90) return "just now";
	if (s < 3600) return `${Math.round(s / 60)} min ago`;
	if (s < 86400) return `${Math.round(s / 3600)} h ago`;
	return `${Math.round(s / 86400)} d ago`;
}

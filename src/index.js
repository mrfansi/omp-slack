// Slack <-> omp bridge. Connects a Slack app over Socket Mode (no public URL) and
// relays DMs, @mentions, and follow-ups in threads the bot joined, from
// allowlisted members, to one `omp --mode rpc-ui` session running with the
// user's normal omp config (skills, MCP, memory, extensions, slash commands).
// Sessions live in omp's default session store, so terminal `omp --resume`
// sees them and vice versa. Settings come from omp's plugin config (see
// config.js) and are hot-reloaded; tokens come from the bridge's tokens file.
import { mkdirSync, readFileSync, statSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { App, LogLevel } from "@slack/bolt";
import { STATE_DIR, loadSettings, loadTokens, lockfilePath } from "./config.js";
import { OmpAgent } from "./omp-rpc.js";
import { ago, listSessions, resolveProject, tildify } from "./workspace.js";

const env = process.env;
const INBOX_DIR = join(STATE_DIR, "inbox");
const STATE_FILE = join(STATE_DIR, "state.json");
const MAX_CHUNK = 3500;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_THREADS = 200;
const PROGRESS_LINES = 8;
const PROGRESS_EDIT_MS = 2000;
const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const BRIDGE_COMMANDS = new Set(["help", "stop", "new", "status", "cd", "resume"]);
// omp commands that exist in the terminal but not over RPC; refused instead of reaching the model.
const TUI_ONLY_COMMANDS = new Set(["goal", "vibe", "btw"]);
const REACTION = { working: "hourglass_flowing_sand", done: "white_check_mark", stopped: "black_square_for_stop", failed: "x" };

mkdirSync(INBOX_DIR, { recursive: true, mode: 0o700 });

const log = (...args) => console.log(new Date().toISOString(), ...args);

let settings = loadSettings();
const tokens = loadTokens();
if (!tokens.botToken || !tokens.appToken) {
	log("Slack tokens are not set. In omp run: /slack token");
	process.exit(2);
}

/** Persisted bridge state: current project, session, and threads the bot answers in. */
function loadState() {
	try {
		return JSON.parse(readFileSync(STATE_FILE, "utf8"));
	} catch {
		return {};
	}
}
let state = loadState();
const saveState = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
const activeThreads = new Set(state.threads ?? []);

const HELP = [
	"*omp via Slack*",
	"DM me, or @mention me in a channel (I answer in the thread; later messages in that thread need no mention).",
	"Images and files are forwarded (and saved to the inbox).",
	"Slack reserves messages starting with `/`, so write omp commands with `!`: `!model`, `!switch`, `!compact`, `!todo`, `!mcp`, `!rename`, `!session`, `!skill:<name>`, `!usage`, `!move`, … or use `/omp model`.",
	"Agent questions (ask tool): reply with an option number or free text.",
	"",
	"*Bridge commands*",
	"`!cd <project|path>` — switch project (new session in that folder)",
	"`!new` — new session in the same project",
	"`!resume` — list this project's sessions (terminal ones included); `!resume <n>` to continue",
	"`!stop` — stop the running work / cancel a question",
	"`!status` — project, session, model, context",
	"`!help` — this help",
].join("\n");

const SYSTEM_APPEND = [
	"The user is talking to you through a Slack bridge on host mrfansi-dev.",
	"Keep replies short and in the user's language. Slack mrkdwn: *bold*, _italic_, ~strike~, `code`, ```code blocks```; no markdown headings or tables; write links as plain URLs.",
	"Messages marked as coming from a channel thread are visible to other channel members: never print secrets (tokens, passwords, .env values, credentials) there.",
	"The `ask` tool works: the user answers in Slack by option number or free text.",
	"Files and images the user sends are saved under the inbox path given in their message.",
	"To deliver a file or image to the user, call the `slack_send_file` tool with an absolute path.",
].join("\n");

const HOST_TOOLS = [
	{
		name: "slack_send_file",
		label: "Slack send file",
		description: "Upload a local file to the user's current Slack conversation (DM or thread). Max 64 MiB.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Absolute path of the file to send" },
				caption: { type: "string", description: "Optional comment posted with the file" },
			},
			required: ["path"],
			additionalProperties: false,
		},
		loadMode: "essential",
	},
];

// ---------------------------------------------------------------------------
// Slack formatting

/** Convert common Markdown to Slack mrkdwn; escapes the three control characters Slack requires. */
function toSlack(md) {
	return md
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.split(/(```[\s\S]*?```)/g)
		.map((part, i) => {
			if (i % 2) return part;
			return part
				.replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
				.replace(/\*\*(.+?)\*\*/g, "*$1*")
				.replace(/__(.+?)__/g, "_$1_")
				.replace(/~~(.+?)~~/g, "~$1~")
				.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "<$2|$1>");
		})
		.join("");
}

/** Slack message text → plain text: drop our own mention, unwrap links and channel refs, unescape. */
function fromSlack(text) {
	return text
		.replace(new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`, "g"), "")
		.replace(/<#[A-Z0-9]+\|([^>]*)>/g, "#$1")
		.replace(/<mailto:[^|>]+\|([^>]+)>/g, "$1")
		.replace(/<((?:https?|ftp):[^|>]+)(?:\|[^>]*)?>/g, "$1")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.trim();
}

function chunk(text) {
	const out = [];
	let rest = text;
	while (rest.length > MAX_CHUNK) {
		let cut = rest.lastIndexOf("\n", MAX_CHUNK);
		if (cut < MAX_CHUNK / 2) cut = MAX_CHUNK;
		out.push(rest.slice(0, cut));
		rest = rest.slice(cut).replace(/^\n/, "");
	}
	if (rest.trim()) out.push(rest);
	return out;
}

// ---------------------------------------------------------------------------
// Slack connection

const app = new App({
	token: tokens.botToken,
	appToken: tokens.appToken,
	socketMode: true,
	logLevel: env.SLACK_LOG_LEVEL === "debug" ? LogLevel.DEBUG : LogLevel.WARN,
});
const client = app.client;
let botUserId = null;
let target = null; // {channel, thread_ts?} receiving agent output
let agent = null;

const dmChannels = new Map(); // user id -> DM channel id with the bot
async function dmChannel(user) {
	if (!dmChannels.has(user)) {
		const res = await client.conversations.open({ users: user });
		dmChannels.set(user, res.channel.id);
	}
	return dmChannels.get(user);
}

const warnedUsers = new Set();
function allowed(user) {
	if (settings.allowedUsers.has(user)) return true;
	if (!warnedUsers.has(user)) {
		warnedUsers.add(user);
		log(`ignored message from ${user} (not in allowedUsers)`);
	}
	return false;
}

const seen = new Set(); // event redelivery guard
function firstTime(key) {
	if (seen.has(key)) return false;
	seen.add(key);
	if (seen.size > 500) seen.delete(seen.values().next().value);
	return true;
}

function rememberThread(key) {
	activeThreads.delete(key);
	activeThreads.add(key);
	while (activeThreads.size > MAX_THREADS) activeThreads.delete(activeThreads.values().next().value);
	state.threads = [...activeThreads];
	saveState();
}

// Messages are handled without waiting for the agent turn they start: a reply to an
// `ask` question, a !stop, or a follow-up must get through while the agent works.
app.event("message", async ({ event }) => {
	try {
		await onMessage(event);
	} catch (err) {
		log("failed to handle message:", err);
		await reply(`Failed: ${err.message}`).catch(() => {});
	}
});

async function onMessage(event) {
	if (event.subtype && event.subtype !== "file_share") return; // edits, joins, bot posts
	if (event.bot_id || !event.user || event.user === botUserId) return;
	if (!firstTime(`${event.channel}:${event.ts}`)) return;

	const isDm = event.channel_type === "im";
	const mentioned = (event.text ?? "").includes(`<@${botUserId}`);
	const threadKey = event.thread_ts ? `${event.channel}:${event.thread_ts}` : null;
	if (!isDm && !mentioned && !(threadKey && activeThreads.has(threadKey))) return; // not for us
	if (!allowed(event.user)) return;

	let threadTs = event.thread_ts;
	if (!isDm) {
		threadTs ??= event.ts; // answer a top-level mention in a new thread
		rememberThread(`${event.channel}:${threadTs}`);
	}
	target = { channel: event.channel, thread_ts: threadTs };

	const text = normalizeCommand(fromSlack(event.text ?? ""));
	const images = [];
	const notes = [];
	for (const file of event.files ?? []) {
		try {
			await receiveFile(file, images, notes);
		} catch (err) {
			notes.push(`[File "${file.name}" from the user could not be downloaded: ${err.message}]`);
		}
	}
	if (!isDm && !text.startsWith("/")) notes.unshift("[Sent in a Slack channel thread; your replies are visible to channel members.]");
	await handleInput(text, images, notes, { channel: event.channel, ts: event.ts });
}

async function receiveFile(file, images, notes) {
	if (file.file_access === "check_file_info") file = (await client.files.info({ file: file.id })).file;
	if (file.size > MAX_FILE_BYTES) {
		notes.push(`[File "${file.name}" skipped: ${file.size} bytes is over the ${MAX_FILE_BYTES}-byte limit]`);
		return;
	}
	const res = await fetch(file.url_private_download ?? file.url_private, {
		headers: { Authorization: `Bearer ${tokens.botToken}` },
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	if ((res.headers.get("content-type") ?? "").startsWith("text/html")) {
		throw new Error("Slack returned a login page; is the files:read scope granted?");
	}
	const data = Buffer.from(await res.arrayBuffer());
	const name = basename(file.name || `file-${file.id}`).replace(/[^\w.\- ]/g, "_");
	const path = join(INBOX_DIR, `${Date.now()}-${name}`);
	writeFileSync(path, data, { mode: 0o600 });
	if (IMAGE_MIME.has(file.mimetype)) {
		images.push({ type: "image", data: data.toString("base64"), mimeType: file.mimetype });
		notes.push(`[Image from the user, also saved at ${path}]`);
	} else {
		notes.push(`[File from the user saved at ${path} (${file.mimetype || "unknown"}, ${data.length} bytes)]`);
	}
}

// `/omp <args>` Slack slash command. Output goes to the member's DM with the bot, so
// results never land in a channel the bot is not part of.
app.command("/omp", async ({ command, ack }) => {
	if (!allowed(command.user_id)) {
		await ack({ response_type: "ephemeral", text: "You are not allowed to use this bot." });
		return;
	}
	const dm = await dmChannel(command.user_id);
	await ack(command.channel_id === dm ? undefined : { response_type: "ephemeral", text: "Running; output goes to your DM with omp." });
	target = { channel: dm };
	const raw = command.text.trim();
	const asCommand = normalizeCommand(`!${raw.replace(/^[!/]/, "")}`);
	const text = !raw ? "/help" : asCommand.startsWith("/") ? asCommand : raw;
	try {
		await handleInput(text, [], [], null);
	} catch (err) {
		log("failed to handle /omp:", err);
		await reply(`Failed: ${err.message}`).catch(() => {});
	}
});

/** `!cmd` (or a leading `/` that got through) → `/cmd` when it names a bridge or omp command. */
function normalizeCommand(text) {
	const m = /^[!/]([\w:.-]+)([\s\S]*)$/.exec(text);
	if (!m) return text;
	const name = m[1].toLowerCase();
	if (BRIDGE_COMMANDS.has(name) || agent.commands.has(m[1]) || TUI_ONLY_COMMANDS.has(name)) return `/${m[1]}${m[2]}`;
	return text; // unknown: `/x` is refused later, `!x` stays plain text
}

async function handleInput(text, images, notes, msgRef) {
	if (text.startsWith("/") && (await bridgeCommand(text))) return;
	if (pendingUi && text && !text.startsWith("/") && !images.length) return answerUi(text);

	const prompt = [notes.join("\n"), text].filter(Boolean).join("\n\n");
	if (!text && !images.length && !notes.some((n) => n.startsWith("[File") || n.startsWith("[Image"))) {
		return reply(HELP); // a bare @mention
	}
	if (text.startsWith("/")) {
		const name = text.slice(1).split(/\s/, 1)[0];
		if (!agent.commands.has(name)) return reply(`\`!${name}\` is not available over Slack (omp RPC mode). Send \`!help\`.`);
	}
	submit(msgRef, text.startsWith("/") ? text : prompt, images);
}

// ---------------------------------------------------------------------------
// Prompts

let inFlight = 0; // prompts submitted to omp and not yet yielded
let nameSession = false; // fresh session: title it from the first message

function submit(msgRef, prompt, images) {
	react(msgRef, REACTION.working);
	inFlight++;
	const first = nameSession && !prompt.startsWith("/");
	if (first) nameSession = false;
	agent
		.prompt(prompt, images.length ? images : undefined)
		.catch((err) => ({ status: "error", error: { message: err.message } }))
		.then(async (result) => {
			if (first) {
				const title = `Slack: ${prompt.replace(/^\[[^\]]*\]\s*/gm, "").replace(/\s+/g, " ").trim().slice(0, 60)}`;
				await agent.request({ type: "set_session_name", name: title }).catch(() => {});
			}
			unreact(msgRef, REACTION.working);
			if (result.status === "error") {
				await reply(`Failed: ${result.error?.message ?? "unknown error"}`);
				await react(msgRef, REACTION.failed);
			} else {
				await react(msgRef, result.status === "aborted" ? REACTION.stopped : REACTION.done);
			}
		})
		.finally(() => {
			inFlight--;
			applyPendingRestart();
		})
		.catch((err) => log("failed to finish prompt:", err));
}

// ---------------------------------------------------------------------------
// Bridge commands (omp has no RPC equivalent for these)

/** @returns {Promise<boolean>} true when the message was a bridge command */
async function bridgeCommand(text) {
	const [cmd, ...rest] = text.slice(1).split(/\s+/);
	const arg = rest.join(" ").trim();
	switch (cmd.toLowerCase()) {
		case "help":
			await reply(HELP);
			return true;
		case "stop":
			if (pendingUi) cancelUi();
			if (progress) progress.stopped = true;
			await agent.request({ type: "abort" }).catch(() => {});
			await reply("Stopped.");
			return true;
		case "new":
			if (pendingUi) cancelUi();
			await agent.request({ type: "new_session" });
			await agent.refreshSession();
			nameSession = true;
			await reply(`New session in ${tildify(agent.opts.cwd)}.`);
			return true;
		case "status":
			await reply(await statusText());
			return true;
		case "cd":
			await changeProject(arg);
			return true;
		case "resume":
			await resumeSession(arg);
			return true;
		default:
			return false;
	}
}

async function statusText() {
	const s = await agent.request({ type: "get_state" });
	const ctx = s.contextUsage;
	return [
		`Project: ${tildify(agent.opts.cwd)}`,
		`Session: ${s.sessionName ?? "(untitled)"}${s.messageCount ? ` — ${s.messageCount} messages` : ""}`,
		`Model: ${s.model?.provider}/${s.model?.id} (thinking ${s.thinkingLevel})`,
		`Working: ${s.isStreaming ? "yes" : "no"}${s.queuedMessageCount ? `, ${s.queuedMessageCount} queued` : ""}`,
		pendingUi ? "Waiting for your answer to the agent's question." : null,
		ctx ? `Context: ${ctx.tokens}/${ctx.contextWindow} tokens (${Number(ctx.percent).toFixed(1)}%)` : null,
	]
		.filter(Boolean)
		.join("\n");
}

async function changeProject(arg) {
	if (!arg) return reply(`Current project: ${tildify(agent.opts.cwd)}\nUsage: \`!cd <folder-name | path>\``);
	const found = resolveProject(arg);
	if (found.error) return reply(found.error);
	if (found.candidates) {
		return reply(`Several folders match; use a full path:\n${found.candidates.map(tildify).join("\n")}`);
	}
	if (inFlight > 0) return reply("The agent is still working. Wait for it to finish or `!stop` first.");
	switchProject(found.dir);
	await reply(`Switched to ${tildify(found.dir)}. New session started.`);
}

/** Restart omp in `dir` with a fresh session. */
function switchProject(dir) {
	if (pendingUi) cancelUi();
	state = { ...state, cwd: dir, sessionFile: undefined };
	saveState();
	Object.assign(agent.opts, { cwd: dir, sessionFile: undefined });
	nameSession = true;
	agent.restart();
}

let lastListing = [];

async function resumeSession(arg) {
	if (!arg) {
		lastListing = listSessions(agent.opts.sessionFile);
		if (!lastListing.length) return reply("No saved sessions for this project yet.");
		const lines = lastListing.map((s, i) => {
			const current = s.file === agent.opts.sessionFile ? " ← active" : "";
			return `${i + 1}. ${s.title ?? basename(s.file).slice(0, 19)} — ${ago(s.mtime)}${current}`;
		});
		return reply(`*Sessions in ${tildify(agent.opts.cwd)}*\n${lines.join("\n")}\n\nReply \`!resume <n>\`.`);
	}
	const pick = lastListing[Number(arg) - 1];
	if (!pick) return reply("Invalid number. Run `!resume` first to see the list.");
	if (inFlight > 0) return reply("The agent is still working. Wait for it to finish or `!stop` first.");
	if (pendingUi) cancelUi();
	await agent.request({ type: "switch_session", sessionPath: pick.file });
	await agent.refreshSession();
	const warn =
		Date.now() - pick.mtime.getTime() < 5 * 60 * 1000
			? "\nThis session was active recently; don't use it from the terminal at the same time."
			: "";
	await reply(`Resumed: ${pick.title ?? basename(pick.file)}${warn}`);
}

// ---------------------------------------------------------------------------
// Agent dialogs (ask tool, command pickers) relayed to Slack

let pendingUi = null; // extension_ui_request awaiting the user's reply
let uiStash = null; // free text meant for the editor that follows an "Other" pick

function onUiRequest(frame) {
	if (uiStash !== null && (frame.method === "editor" || frame.method === "input")) {
		const value = uiStash;
		uiStash = null;
		agent.respondUi(frame.id, { value });
		return;
	}
	pendingUi = frame;
	if (frame.timeout) {
		// omp answers with the default itself when the dialog times out
		setTimeout(() => {
			if (pendingUi === frame) pendingUi = null;
		}, frame.timeout);
	}
	const title = frame.title ? `*${frame.title}*` : "*Question from the agent*";
	const body = frame.message ? `\n${frame.message}` : "";
	let prompt;
	switch (frame.method) {
		case "select":
			prompt = `${frame.options
				.map((o, i) => `${i + 1}. ${o}${frame.optionDetails?.[i]?.description ? ` — ${frame.optionDetails[i].description}` : ""}`)
				.join("\n")}\n\nReply with a number, or type your own answer.`;
			break;
		case "confirm":
			prompt = "Reply *yes* or *no*.";
			break;
		default:
			prompt = frame.placeholder ? `Type your answer (${frame.placeholder}).` : "Type your answer.";
	}
	reply(`❓ ${title}${body}\n${prompt}`).catch((err) => log("failed to send question:", err));
}

function answerUi(text) {
	const frame = pendingUi;
	pendingUi = null;
	if (frame.method === "confirm") {
		const yes = /^(y|ya|yes|ok|oke|iya|lanjut|setuju)\b/i.test(text);
		const no = /^(n|no|tidak|tdk|gak|nggak|batal|jangan)\b/i.test(text);
		if (!yes && !no) {
			pendingUi = frame;
			return reply("Reply *yes* or *no*.");
		}
		return agent.respondUi(frame.id, { confirmed: yes });
	}
	if (frame.method === "select") {
		const n = Number(text);
		const byNumber = Number.isInteger(n) ? frame.options[n - 1] : undefined;
		const byLabel = frame.options.find((o) => o.toLowerCase() === text.toLowerCase());
		const choice = byNumber ?? byLabel;
		if (choice) return agent.respondUi(frame.id, { value: choice });
		const other = frame.options.find((o) => /^other\b/i.test(o));
		if (other) {
			uiStash = text; // omp asks for the custom text next
			return agent.respondUi(frame.id, { value: other });
		}
		pendingUi = frame;
		return reply(`Pick a number from 1 to ${frame.options.length}.`);
	}
	return agent.respondUi(frame.id, { value: text });
}

function cancelUi() {
	const frame = pendingUi;
	pendingUi = null;
	uiStash = null;
	try {
		agent.respondUi(frame.id, { cancelled: true });
	} catch {
		// omp already gone; nothing to answer
	}
}

// ---------------------------------------------------------------------------
// Progress: one Slack message per turn, edited as tools run

let progress = null; // current turn: {ts, target, lines, steps, timer, sending, stopped}

function onToolStart(toolName, intent) {
	if (settings.progress === "off" || !target || toolName === "ask") return;
	if (!progress) progress = { ts: null, target, lines: [], steps: 0, timer: null, sending: Promise.resolve() };
	const p = progress;
	p.steps++;
	p.lines.push(`• ${intent || toolName}`);
	if (p.lines.length > PROGRESS_LINES) p.lines.shift();
	if (!p.timer) p.timer = setTimeout(() => flushProgress(p, false), p.ts ? PROGRESS_EDIT_MS : 0);
}

function progressText(p, done) {
	const steps = `${p.steps} step${p.steps === 1 ? "" : "s"}`;
	const head = !done ? `⏳ Working… (${steps})` : p.stopped ? `⏹️ Stopped after ${steps}` : `✅ ${steps}`;
	return `${head}\n${p.lines.join("\n")}`;
}

/** Post or update the progress message; calls are chained so updates never overtake the first post. */
function flushProgress(p, done) {
	clearTimeout(p.timer);
	p.timer = null;
	if (done && progress === p) progress = null;
	p.sending = p.sending
		.then(async () => {
			const text = toSlack(progressText(p, done));
			if (!p.ts) p.ts = (await client.chat.postMessage({ ...p.target, text, unfurl_links: false })).ts;
			else await client.chat.update({ channel: p.target.channel, ts: p.ts, text });
		})
		.catch((err) => log("failed to update progress:", err.data?.error ?? err.message));
	return p.sending;
}

// ---------------------------------------------------------------------------
// Outgoing

async function reply(text) {
	if (!target) return;
	const to = target;
	for (const part of chunk(toSlack(text))) {
		await client.chat.postMessage({ ...to, text: part, unfurl_links: false, unfurl_media: false });
	}
}

async function react(msgRef, name) {
	if (!msgRef) return;
	await client.reactions.add({ channel: msgRef.channel, timestamp: msgRef.ts, name }).catch(() => {});
}

function unreact(msgRef, name) {
	if (!msgRef) return;
	client.reactions.remove({ channel: msgRef.channel, timestamp: msgRef.ts, name }).catch(() => {});
}

async function sendFile({ path, caption }) {
	if (!target) throw new Error("No active Slack conversation");
	const size = statSync(path).size;
	if (size > MAX_FILE_BYTES) throw new Error(`File too large: ${size} bytes (max ${MAX_FILE_BYTES})`);
	await client.filesUploadV2({
		channel_id: target.channel,
		thread_ts: target.thread_ts,
		file: readFileSync(path),
		filename: basename(path),
		initial_comment: caption,
	});
	return `Uploaded ${basename(path)} (${size} bytes) to Slack.`;
}

// ---------------------------------------------------------------------------
// omp agent

function startAgent() {
	agent = new OmpAgent({
		bin: env.OMP_BIN || "omp",
		args: ["--approval-mode", "yolo", "--append-system-prompt", SYSTEM_APPEND],
		hostTools: HOST_TOOLS,
		onHostTool: async (name, args) => {
			if (name === "slack_send_file") return sendFile(args);
			throw new Error(`Unknown host tool: ${name}`);
		},
		cwd: state.cwd || settings.cwd,
		sessionFile: state.sessionFile,
		model: settings.model,
		thinking: settings.thinking,
	});
	agent.on("log", (line) => log(line));
	agent.on("exit", (err, restarting) => {
		if (pendingUi) pendingUi = null; // the dialog died with the process
		log(`${err.message}; ${restarting ? "restarting with new settings" : "restarting in 3s"}`);
	});
	agent.on("initialized", () =>
		log(`omp ready (cwd=${agent.opts.cwd}, model=${agent.opts.model || "default"}, thinking=${agent.opts.thinking})`),
	);
	agent.on("session", (s) => {
		state = { ...state, cwd: agent.opts.cwd, sessionFile: s.sessionFile };
		saveState();
		if (!s.messageCount && !s.sessionName) nameSession = true;
	});
	agent.on("assistant_text", (text) => reply(text).catch((err) => log("failed to send reply:", err.data?.error ?? err.message)));
	agent.on("command_output", (text) => reply(text).catch((err) => log("failed to send command output:", err.data?.error ?? err.message)));
	agent.on("notify", (text, level) => reply(`${level === "error" ? "⚠️ " : ""}${text}`).catch(() => {}));
	agent.on("ui_request", onUiRequest);
	agent.on("tool_start", onToolStart);
	agent.on("agent_end", () => {
		if (progress) flushProgress(progress, true);
	});
	agent.start();
}

// Settings edited through `omp plugin config`, /slack set, or /settings land in
// omp's plugin lockfile. The allowlist and progress apply immediately; model and
// thinking restart omp (same session) once idle; a new default cwd switches project.
let pendingRestart = null; // null | "restart" | {cwd}

function applyPendingRestart() {
	if (!pendingRestart || inFlight > 0) return;
	const action = pendingRestart;
	pendingRestart = null;
	Object.assign(agent.opts, { model: settings.model, thinking: settings.thinking });
	if (action.cwd) switchProject(action.cwd);
	else agent.restart();
}

function watchSettings() {
	const file = lockfilePath();
	let timer = null;
	watch(dirname(file), (_event, name) => {
		if (name !== basename(file)) return;
		clearTimeout(timer);
		timer = setTimeout(() => {
			const prev = settings;
			settings = loadSettings();
			const allow = [...settings.allowedUsers].join(",");
			if (allow !== [...prev.allowedUsers].join(",")) {
				log(`allowedUsers updated: ${allow || "(empty)"}`);
				warnedUsers.clear();
			}
			if (settings.cwd !== prev.cwd) pendingRestart = { cwd: settings.cwd };
			else if (settings.model !== prev.model || settings.thinking !== prev.thinking) pendingRestart ??= "restart";
			else return;
			log("agent settings changed; applying once the agent is idle");
			applyPendingRestart();
		}, 300);
	});
}

// The agent starts first so incoming events always find it.
let auth;
try {
	auth = await client.auth.test();
	botUserId = auth.user_id;
} catch (err) {
	log(`Slack connection failed: ${err.data?.error ?? err.message}. Check the tokens with /slack token in omp.`);
	process.exit(3);
}
if (!settings.allowedUsers.size) {
	log("allowedUsers is empty: all messages are ignored. Set it with: /slack set allowedUsers U012AB3CD");
}
startAgent();
try {
	await app.start();
	log(`Slack connected as @${auth.user} (${auth.user_id}) in ${auth.team}`);
} catch (err) {
	log(`Slack Socket Mode failed: ${err.data?.error ?? err.message}. Check the app-level token with /slack token in omp.`);
	agent.stop();
	setTimeout(() => process.exit(3), 1000);
}
watchSettings();
for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, () => {
		agent.stop();
		app.stop().catch(() => {});
		setTimeout(() => process.exit(0), 1500);
	});
}

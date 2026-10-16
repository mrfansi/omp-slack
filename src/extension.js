// omp extension: `/slack` manages the Slack bridge service from inside omp.
// The bridge itself runs as a systemd user service (src/index.js) so Slack
// stays reachable when no omp session is open; settings are omp plugin settings,
// tokens live in the bridge's 0600 tokens file.
import { execFile } from "node:child_process";
import { join } from "node:path";
import { WebClient } from "@slack/web-api";
import { PACKAGE_DIR, PLUGIN_NAME, SERVICE, TOKENS_FILE, loadSettings, loadTokens, saveTokens } from "./config.js";

const SUBCOMMANDS = [
	{ value: "status", description: "Service, Slack connection, and settings" },
	{ value: "token", description: "Enter the bot (xoxb-) and app-level (xapp-) tokens" },
	{ value: "set", description: "set <allowedUsers|cwd|model|thinking|progress> <value>" },
	{ value: "start", description: "Enable and start the bridge service" },
	{ value: "stop", description: "Stop and disable the bridge service" },
	{ value: "restart", description: "Restart the bridge service" },
	{ value: "logs", description: "Last 30 log lines" },
];
const SETTING_KEYS = ["allowedUsers", "cwd", "model", "thinking", "progress"];
const LIVE_KEYS = new Set(["allowedUsers", "progress"]);
const MANIFEST = join(PACKAGE_DIR, "slack-app-manifest.json");

function run(cmd, args) {
	return new Promise((resolve) => {
		execFile(cmd, args, { timeout: 30_000 }, (err, stdout, stderr) =>
			resolve({ ok: !err, out: `${stdout}${stderr}`.trim(), code: err?.code }),
		);
	});
}

const systemctl = (...args) => run("systemctl", ["--user", ...args]);

/** @returns {Promise<{ok: true, team: string, user: string} | {ok: false, error: string}>} */
async function checkBotToken(token) {
	try {
		const auth = await new WebClient(token).auth.test();
		return { ok: true, team: auth.team, user: auth.user };
	} catch (err) {
		return { ok: false, error: err.data?.error ?? err.message };
	}
}

/** An app-level token is valid when it may open a Socket Mode connection. */
async function checkAppToken(token) {
	try {
		await new WebClient(token).apps.connections.open();
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err.data?.error ?? err.message };
	}
}

const SETUP_STEPS = [
	"Setup:",
	`1. https://api.slack.com/apps → Create New App → From a manifest → paste ${MANIFEST}`,
	"2. Install to Workspace; copy the Bot User OAuth Token (xoxb-…)",
	"3. Basic Information → App-Level Tokens → Generate with scope connections:write (xapp-…)",
	"4. /slack token, then /slack set allowedUsers <your member ID>, then /slack start",
].join("\n");

async function status() {
	const [active, enabled] = await Promise.all([systemctl("is-active", SERVICE), systemctl("is-enabled", SERVICE)]);
	const s = loadSettings();
	const tokens = loadTokens();
	let slack;
	if (!tokens.botToken || !tokens.appToken) slack = "tokens not set — /slack token";
	else {
		const auth = await checkBotToken(tokens.botToken);
		slack = auth.ok ? `@${auth.user} in ${auth.team}` : `bot token rejected (${auth.error}) — /slack token`;
	}
	return [
		`Service: ${active.out || "unknown"} (${enabled.out || "unknown"})`,
		`Slack: ${slack}`,
		`allowedUsers: ${[...s.allowedUsers].join(", ") || "(empty — all messages are ignored)"}`,
		`cwd default: ${s.cwd}`,
		`model: ${s.model || "(default omp)"}`,
		`thinking: ${s.thinking}`,
		`progress: ${s.progress}`,
		"Change: /slack set <key> <value>, /settings → Plugins, or omp plugin config set omp-slack <key> <value>",
		...(tokens.botToken ? [] : ["", SETUP_STEPS]),
	].join("\n");
}

async function setSetting(rest) {
	const [key, ...valueParts] = rest;
	if (!SETTING_KEYS.includes(key)) return { text: `Key must be one of: ${SETTING_KEYS.join(", ")}`, level: "error" };
	const value = valueParts.join(" ");
	const res = value
		? await run("omp", ["plugin", "config", "set", PLUGIN_NAME, key, value])
		: await run("omp", ["plugin", "config", "delete", PLUGIN_NAME, key]);
	if (!res.ok) return { text: res.out || `Failed to save ${key}`, level: "error" };
	return {
		text: `${key} = ${value || "(default)"}. ${LIVE_KEYS.has(key) ? "Applied immediately." : "The bridge applies it once the agent is idle."}`,
		level: "info",
	};
}

/**
 * Ask for both tokens in dialogs (so they never enter prompt history), verify them
 * against Slack, store them, and restart a running bridge.
 */
async function enterTokens(ctx) {
	if (!ctx.hasUI) return { text: "/slack token needs the omp terminal UI.", level: "error" };
	const current = loadTokens();
	const botToken = (await ctx.ui.input("Slack Bot User OAuth Token", current.botToken ? "xoxb-… (Enter keeps the current one)" : "xoxb-…"))?.trim() || current.botToken;
	if (!botToken) return { text: "Cancelled.", level: "warning" };
	if (!botToken.startsWith("xoxb-")) return { text: "The bot token must start with xoxb-.", level: "error" };
	const appToken = (await ctx.ui.input("Slack App-Level Token (connections:write)", current.appToken ? "xapp-… (Enter keeps the current one)" : "xapp-…"))?.trim() || current.appToken;
	if (!appToken) return { text: "Cancelled.", level: "warning" };
	if (!appToken.startsWith("xapp-")) return { text: "The app-level token must start with xapp-.", level: "error" };

	const [bot, appCheck] = await Promise.all([checkBotToken(botToken), checkAppToken(appToken)]);
	if (!bot.ok) return { text: `Slack rejected the bot token: ${bot.error}. Nothing saved.`, level: "error" };
	if (!appCheck.ok) return { text: `Slack rejected the app-level token: ${appCheck.error}. Nothing saved.`, level: "error" };
	saveTokens({ botToken, appToken });

	const active = (await systemctl("is-active", SERVICE)).out === "active";
	const restarted = active ? await systemctl("restart", SERVICE) : null;
	const next = active ? (restarted.ok ? "Bridge restarted." : `Restart failed: ${restarted.out}`) : "Start the bridge with /slack start.";
	return { text: `Tokens verified for @${bot.user} in ${bot.team} and saved to ${TOKENS_FILE}. ${next}`, level: "info" };
}

async function dispatch(args, ctx) {
	const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
	switch (sub) {
		case "status":
			return { text: await status(), level: "info" };
		case "token":
			return enterTokens(ctx);
		case "set":
			return setSetting(rest);
		case "start": {
			const tokens = loadTokens();
			if (!tokens.botToken || !tokens.appToken) return { text: `Tokens are not set.\n${SETUP_STEPS}`, level: "error" };
			const r = await systemctl("enable", "--now", SERVICE);
			return r.ok ? { text: await status(), level: "info" } : { text: r.out, level: "error" };
		}
		case "stop": {
			const r = await systemctl("disable", "--now", SERVICE);
			return r.ok ? { text: "Bridge stopped; autostart disabled.", level: "info" } : { text: r.out, level: "error" };
		}
		case "restart": {
			const r = await systemctl("restart", SERVICE);
			return r.ok ? { text: "Bridge restarted.", level: "info" } : { text: r.out, level: "error" };
		}
		case "logs": {
			const r = await run("journalctl", ["--user", "-u", SERVICE, "-n", "30", "-o", "cat", "--no-pager"]);
			return { text: r.out || "(no log lines)", level: r.ok ? "info" : "error" };
		}
		default:
			return { text: `Unknown subcommand: ${sub}. Options: ${SUBCOMMANDS.map((s) => s.value).join(", ")}`, level: "error" };
	}
}

export default function slack(pi) {
	pi.setLabel("Slack");
	pi.registerCommand("slack", {
		description: "Manage the Slack bridge (status, token, set, start, stop, restart, logs)",
		getArgumentCompletions(prefix) {
			const [sub, ...rest] = prefix.split(/\s+/);
			if (sub === "set" && rest.length === 1) {
				return SETTING_KEYS.filter((k) => k.startsWith(rest[0])).map((k) => ({ value: `set ${k} `, label: k }));
			}
			if (rest.length) return null;
			return SUBCOMMANDS.filter((s) => s.value.startsWith(sub)).map((s) => ({ ...s, label: s.value }));
		},
		async handler(args, ctx) {
			const { text, level } = await dispatch(args, ctx);
			ctx.ui.notify(text, level);
		},
	});
}

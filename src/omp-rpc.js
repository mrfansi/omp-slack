// Minimal client for `omp --mode rpc-ui` (protocol v1, newline-delimited JSON over stdio).
// Wire contract: omp://rpc.md. rpc-ui routes the `ask` tool and command dialogs
// through `extension_ui_request` frames so the host can answer them.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";

const UI_DIALOGS = new Set(["select", "confirm", "input", "editor"]);

export class OmpAgent extends EventEmitter {
	/**
	 * @param {object} opts  mutable; read again on every (re)start
	 * @param {string} opts.bin            omp executable
	 * @param {string[]} opts.args         extra CLI args appended after the RPC flags
	 * @param {string} opts.cwd            working directory for the agent
	 * @param {string} [opts.sessionFile]  session to resume; when absent (or deleted) a fresh
	 *                                     session starts in omp's default session dir for `cwd`
	 * @param {string} [opts.model]        "provider/id" applied after the session opens
	 * @param {string} [opts.thinking]     thinking level applied after the session opens
	 * @param {Array} opts.hostTools       host tool definitions (set_host_tools)
	 * @param {(name: string, args: object) => Promise<string>} opts.onHostTool
	 */
	constructor(opts) {
		super();
		this.opts = opts;
		this.commands = new Set(); // slash commands the RPC session accepts
		this.proc = null;
		this.seq = 0;
		this.pending = new Map(); // request id -> {resolve, reject}
		this.prompts = new Map(); // prompt id -> {resolve, reject}
		this.stopping = false;
		this.restarting = false;
		this.isUp = false;
		this.#resetUp();
	}

	/** `this.up` resolves once the current omp process is initialized; renewed after each exit. */
	#resetUp() {
		this.up = new Promise((resolve) => (this.markUp = resolve));
	}

	start() {
		const { bin, args, cwd, sessionFile } = this.opts;
		const resume = sessionFile && existsSync(sessionFile) ? ["--resume", sessionFile] : [];
		const proc = spawn(bin, ["--mode", "rpc-ui", "--allow-home", "--cwd", cwd, ...resume, ...args], {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: process.env,
		});
		this.proc = proc;
		let markReady;
		const ready = new Promise((resolve) => (markReady = resolve));
		createInterface({ input: proc.stdout }).on("line", (line) => {
			if (!line.trim()) return;
			let frame;
			try {
				frame = JSON.parse(line);
			} catch {
				return; // v1 oversized-frame fallback or stray output; nothing we need
			}
			if (frame.type === "ready") {
				markReady();
				return;
			}
			this.#onFrame(frame);
		});
		createInterface({ input: proc.stderr }).on("line", (line) => this.emit("log", `[omp] ${line}`));

		proc.on("exit", (code, signal) => {
			const err = new Error(`omp exited (code=${code}, signal=${signal})`);
			for (const p of [...this.pending.values(), ...this.prompts.values()]) p.reject(err);
			this.pending.clear();
			this.prompts.clear();
			this.proc = null;
			if (this.isUp) {
				this.isUp = false;
				this.#resetUp();
			}
			const restarting = this.restarting;
			this.restarting = false;
			this.emit("exit", err, restarting);
			if (!this.stopping) setTimeout(() => this.start(), restarting ? 0 : 3000);
		});

		ready
			.then(async () => {
				await this.request({
					type: "set_event_filter",
					events: ["agent_start", "agent_end", "message_end", "tool_execution_start"],
				});
				await this.#applyModel();
				if (this.opts.hostTools?.length) {
					await this.request({ type: "set_host_tools", tools: this.opts.hostTools });
				}
				await this.refreshSession();
				this.isUp = true;
				this.markUp();
				this.emit("initialized");
			})
			.catch((err) => this.emit("log", `init failed: ${err.message}`));
	}

	/** Apply configured model/thinking; a bad value is reported, not fatal. */
	async #applyModel() {
		const { model, thinking } = this.opts;
		if (model) {
			const slash = model.indexOf("/");
			try {
				if (slash < 1) throw new Error("expected provider/id");
				await this.request({ type: "set_model", provider: model.slice(0, slash), modelId: model.slice(slash + 1) });
			} catch (err) {
				this.emit("log", `model "${model}" not applied: ${err.message}`);
			}
		}
		if (thinking && thinking !== "default") {
			await this.request({ type: "set_thinking_level", level: thinking }).catch((err) =>
				this.emit("log", `thinking "${thinking}" not applied: ${err.message}`),
			);
		}
	}

	/** Restart omp with the current `opts`. */
	restart() {
		if (!this.proc) return;
		this.restarting = true;
		if (this.isUp) {
			// New work must wait for the replacement process, not race the draining one.
			this.isUp = false;
			this.#resetUp();
		}
		this.proc.stdin.end();
	}

	stop() {
		this.stopping = true;
		this.proc?.stdin.end();
	}

	#write(frame) {
		if (!this.proc || this.proc.stdin.writableEnded) throw new Error("omp is not running");
		this.proc.stdin.write(`${JSON.stringify(frame)}\n`);
	}

	#onFrame(frame) {
		switch (frame.type) {
			case "response": {
				const p = this.pending.get(frame.id);
				if (p) {
					this.pending.delete(frame.id);
					frame.success ? p.resolve(frame.data) : p.reject(new Error(frame.error));
					return;
				}
				// Late failure of an already-acknowledged prompt.
				const pr = this.prompts.get(frame.id);
				if (pr && !frame.success) {
					this.prompts.delete(frame.id);
					pr.resolve({ status: "error", error: { message: frame.error } });
				}
				return;
			}
			case "prompt_result": {
				const pr = this.prompts.get(frame.id);
				if (pr) {
					this.prompts.delete(frame.id);
					pr.resolve(frame);
				}
				return;
			}
			case "host_tool_call":
				this.#runHostTool(frame);
				return;
			case "available_commands_update":
				this.commands = new Set(frame.commands.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
				return;
			case "command_output":
				if (frame.text?.trim()) this.emit("command_output", frame.text.trim());
				return;
			case "extension_ui_request":
				if (frame.method === "notify") this.emit("notify", frame.message, frame.notifyType);
				else if (UI_DIALOGS.has(frame.method)) this.emit("ui_request", frame);
				return; // widgets, status lines, titles: no WhatsApp surface
			case "agent_start":
				this.emit("agent_start");
				return;
			case "agent_end":
				if (frame.yielded !== false) this.emit("agent_end");
				return;
			case "tool_execution_start":
				this.emit("tool_start", frame.toolName, frame.intent);
				return;
			case "message_end": {
				const msg = frame.message;
				if (msg?.role !== "assistant") return;
				const text = (msg.content ?? [])
					.filter((c) => c.type === "text" && c.text?.trim())
					.map((c) => c.text.trim())
					.join("\n\n");
				if (text) this.emit("assistant_text", text);
				return;
			}
		}
	}

	async #runHostTool(frame) {
		try {
			const text = await this.opts.onHostTool(frame.toolName, frame.arguments ?? {});
			this.#write({ type: "host_tool_result", id: frame.id, result: { content: [{ type: "text", text }] } });
		} catch (err) {
			this.#write({
				type: "host_tool_result",
				id: frame.id,
				isError: true,
				result: { content: [{ type: "text", text: String(err?.message ?? err) }] },
			});
		}
	}

	/** Answer an `extension_ui_request` dialog with `{value}`, `{confirmed}`, or `{cancelled: true}`. */
	respondUi(id, answer) {
		this.#write({ type: "extension_ui_response", id, ...answer });
	}

	/** Re-read the live session and publish it (`session` event) so the host can persist it. */
	async refreshSession() {
		const s = await this.request({ type: "get_state" });
		this.opts.sessionFile = s.sessionFile;
		this.emit("session", s);
		return s;
	}

	/** Send a command and resolve with its response `data`. */
	request(cmd) {
		const id = `req_${++this.seq}`;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			try {
				this.#write({ ...cmd, id });
			} catch (err) {
				this.pending.delete(id);
				reject(err);
			}
		});
	}

	/**
	 * Submit a user message (plain text or a slash command) and wait until the agent
	 * yields for it. While a turn is running the message is queued as a follow-up.
	 * Assistant replies arrive separately as `assistant_text` events; slash-command
	 * output as `command_output` events.
	 * @returns {Promise<{status: string, agentInvoked: boolean, error?: {message: string}}>}
	 */
	async prompt(message, images) {
		await this.up;
		const id = `prompt_${++this.seq}`;
		const done = new Promise((resolve, reject) => this.prompts.set(id, { resolve, reject }));
		const ack = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
		done.catch(() => {}); // an exit rejects both; keep `done` handled if we bail at `ack`
		try {
			this.#write({ id, type: "prompt", message, images, streamingBehavior: "followUp" });
		} catch (err) {
			this.pending.delete(id);
			this.prompts.delete(id);
			throw err;
		}
		const data = await ack.catch((err) => {
			this.prompts.delete(id);
			throw err;
		});
		if (data?.agentInvoked === false) {
			this.prompts.delete(id);
			return { status: "completed", agentInvoked: false };
		}
		const result = await done;
		return { status: result.status, agentInvoked: true, error: result.error };
	}
}

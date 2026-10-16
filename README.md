# omp-slack

Use omp from Slack the same way you use it in the terminal. The package has two parts:

- **omp plugin** (`src/extension.js`): adds the `/slack` command and settings to omp.
- **Bridge service** (`src/index.js`, systemd user unit): connects a Slack app over Socket Mode
  (outbound WebSocket, no public URL) and relays DMs, @mentions, and follow-ups in threads the bot
  answered, from allowlisted members, to an `omp --mode rpc-ui` session. It runs outside omp so
  Slack stays reachable when no omp window is open.

The bridge session loads your normal omp setup: skills, MCP servers, memory, extensions, model
roles, and slash commands. Sessions are stored in omp's default session store for the project
folder, so `omp --resume` in the terminal lists Slack sessions and `!resume` in Slack lists
terminal sessions. The Slack bridge has its own omp process, project, and session; it shares
nothing with omp-whatsapp.

The agent runs with `--approval-mode yolo`, so every tool (bash, edit, MCP) runs without
confirmation. Access control is only `allowedUsers`. Replies in channel threads are visible to
every channel member; the agent is told not to print secrets there, but that is an instruction,
not a guarantee. Use DMs for anything sensitive.

## Setup

```sh
npm install
omp plugin link .                                   # registers /slack and the settings
cp systemd/omp-slack.service ~/.config/systemd/user/ && systemctl --user daemon-reload
```

Create the Slack app (needs permission to install apps in the workspace):

1. https://api.slack.com/apps → Create New App → From a manifest → pick the workspace → paste
   `slack-app-manifest.json`.
2. Install to Workspace, then copy the Bot User OAuth Token (`xoxb-…`).
3. Basic Information → App-Level Tokens → Generate Token with scope `connections:write` (`xapp-…`).
4. Your member ID: your Slack profile → ⋮ → Copy member ID (`U…`).

Then in omp:

```
/slack token                                        # prompts for both tokens, verifies them with Slack
/slack set allowedUsers U012AB3CD                   # your member ID(s), comma-separated
/slack set cwd ~/Github/viding-co                   # default project (optional)
/slack start
/slack status
```

`/slack token` asks in dialogs, so the tokens never enter omp's prompt history. They are stored
in `~/.local/share/omp-slack/tokens.json` (mode 0600), not in omp's plugin lockfile. A running
bridge is restarted with the new tokens.

To use the bot in a channel, invite it first: `/invite @omp`.

## Settings

Stored in omp's plugin config. Edit them with `/slack set <key> <value>`, `/settings` → Plugins,
or `omp plugin config set omp-slack <key> <value>`. The bridge reloads them live.

| Key | Effect |
| --- | --- |
| `allowedUsers` | Member IDs allowed to command the agent. Applies immediately. Others are ignored and logged (`/slack logs`). |
| `cwd` | Default project. Changing it switches the bridge there with a new session. |
| `model` | `provider/id` override; empty uses your omp default role. Applied on idle, same session. |
| `thinking` | Thinking level override (`default` = omp's). Applied on idle, same session. |
| `progress` | `tools`: one live-edited message listing tool steps per turn; `off`: none. |

`/slack start|stop|restart|logs` control the service. `stop` also disables autostart.

## Using it from Slack

- **Where:** DM the bot, or @mention it in a channel. A channel mention is answered in a thread,
  and later messages in that thread reach the agent without a mention. There is one agent
  session: output goes to the conversation (DM or thread) of the latest message.
- **Commands:** Slack treats any message starting with `/` as a Slack command, so omp commands are
  written with `!`: `!model`, `!switch`, `!compact`, `!todo`, `!mcp`, `!rename`, `!session`,
  `!usage`, `!move`, `!skill:<name>`, and more wherever omp's RPC mode supports them. `/omp <command
  or prompt>` also works from anywhere; its output goes to your DM with the bot.
- **Agent questions** (`ask` tool, command pickers) arrive as numbered lists. Reply with a number,
  *yes*/*no* for confirmations, or free text (picks "Other" and sends your text).
- **Files:** images are attached to the prompt; all files are saved to
  `~/.local/share/omp-slack/inbox/` and their path is given to the agent. The agent can upload files
  back with the `slack_send_file` host tool.
- **Reactions** on your message: :hourglass_flowing_sand: working, :white_check_mark: done,
  :black_square_for_stop: stopped, :x: failed.

Bridge commands (omp has no RPC equivalent):

| Command | Effect |
| --- | --- |
| `!cd <name\|path>` | Switch project. Names are searched under `~/Github` (3 levels). Starts a new session. |
| `!new` | New session in the current project. |
| `!resume`, `!resume <n>` | List the project's sessions (terminal ones included) / continue one. Don't drive one session from the terminal and Slack at the same time. |
| `!stop` | Abort the running turn and cancel a pending question. |
| `!status` | Project, session, model, context usage. |
| `!help` | Command summary. |

## State

`~/.local/share/omp-slack/`: `tokens.json` (secret), `state.json` (current project, session file,
and the threads the bot answers in), `inbox/` (received files). Session transcripts live in
`~/.omp/agent/sessions/`.

The service exits without restarting when tokens are missing (code 2) or rejected by Slack
(code 3); fix them with `/slack token`.

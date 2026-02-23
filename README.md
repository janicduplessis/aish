# aish

AI Shell - convert natural language to bash commands.

Describe what you want to do and `aish` translates it into the right shell command using [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [Codex](https://github.com/openai/codex) CLI. It reads your project files (Makefile, package.json, README, etc.) and checks `--help` output to get the exact flags right.

## Install

```bash
npm install -g aish-cli
```

Requires [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude` CLI) or [Codex](https://github.com/openai/codex) installed and authenticated.

## Usage

```bash
aish <natural language query>
```

### Examples

```bash
# Simple commands
aish list files

# Project-aware - reads your Makefile/package.json to find the right command
aish start the dev server
aish package ios app in debug, skip setup

# Multi-step tasks
aish create a new branch, commit everything, and push
```

`aish` will suggest a command, then let you **Run**, **Edit**, or **Cancel** before executing anything.

### Options

```
-p, --provider <claude|codex>  AI provider (default: claude)
-m, --model <model>            Model override
--cwd <dir>                    Working directory
-v, --verbose                  Show debug output
-h, --help                     Show help
```

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `AISH_PROVIDER` | AI provider (`claude` or `codex`) | `claude` |
| `AISH_MODEL` | Model to use | `sonnet` |

Flags take precedence over environment variables.

## How It Works

1. You type a natural language query
2. `aish` invokes the AI CLI in your project directory
3. The AI reads your project files (README, Makefile, package.json, etc.) and runs `--help` on relevant commands to discover exact flags
4. Returns one or more suggested commands
5. You choose to **Run**, **Edit**, or **Cancel**
6. On Run/Edit the command executes with your shell, inheriting stdio

## License

MIT

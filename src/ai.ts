import { execFile, spawn } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface AiResult {
  commands: string[];
}

const SYSTEM_PROMPT = `You are a CLI assistant that converts natural language into the exact shell commands to run.

RESEARCH STEPS (do all of these before responding):
1. Read the README.md (or README) file thoroughly — it often documents available commands, flags, and workflows.
2. Read the Makefile, package.json scripts, Justfile, Taskfile.yml, docker-compose.yml, Cargo.toml, or pyproject.toml — whichever exist — to find available targets/scripts.
3. When the user's request maps to a specific command or script, run it with --help to discover the exact flags and options available.
4. Cross-reference what you found: use the exact flag names and syntax from --help output and documentation, not guesses.

RESPONSE FORMAT:
Respond with ONLY a JSON object: {"commands": ["command1", "command2"]}
No explanation, no markdown, no code fences. Just raw JSON.
Prefer existing scripts/targets with correct flags over raw commands.`;

let verbose = false;

export function setVerbose(v: boolean) {
  verbose = v;
}

function execPromise(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  if (verbose) {
    console.error(`\x1b[2m$ ${cmd} ${args.join(" ")}\x1b[0m`);
    console.error(`\x1b[2m  cwd: ${cwd}\x1b[0m`);
  }
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 1024 * 1024, timeout: 120_000 }, (err, stdout, stderr) => {
      if (verbose) {
        if (stderr) console.error(`\x1b[2mstderr: ${stderr}\x1b[0m`);
        if (stdout) console.error(`\x1b[2mstdout: ${stdout.slice(0, 500)}\x1b[0m`);
        if (err) console.error(`\x1b[2merror: ${err.message}\x1b[0m`);
      }
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

function parseCommands(raw: string): string[] {
  // Strip code fences if present
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  cleaned = cleaned.trim();

  const parsed = JSON.parse(cleaned);
  if (!parsed.commands || !Array.isArray(parsed.commands)) {
    throw new Error("Invalid response: missing commands array");
  }
  if (!parsed.commands.every((c: unknown) => typeof c === "string")) {
    throw new Error("Invalid response: commands must be strings");
  }
  return parsed.commands;
}

function spawnWithStdin(
  cmd: string,
  args: string[],
  input: string,
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  if (verbose) {
    console.error(`\x1b[2m$ echo '...' | ${cmd} ${args.join(" ")}\x1b[0m`);
    console.error(`\x1b[2m  cwd: ${cwd}\x1b[0m`);
    console.error(`\x1b[2m  stdin: ${input.slice(0, 200)}...\x1b[0m`);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      if (verbose) {
        if (stderr) console.error(`\x1b[2mstderr: ${stderr.slice(0, 500)}\x1b[0m`);
        if (stdout) console.error(`\x1b[2mstdout: ${stdout.slice(0, 500)}\x1b[0m`);
      }
      if (code !== 0) reject(new Error(`${cmd} exited with code ${code}\n${stderr}`));
      else resolve({ stdout, stderr });
    });
    child.on("error", reject);
    child.stdin.write(input);
    child.stdin.end();
  });
}

async function queryClaude(query: string, cwd: string, model?: string): Promise<AiResult> {
  const prompt = `${SYSTEM_PROMPT}\n\nUser request: ${query}`;
  const args = [
    "-p",
    "--output-format",
    "json",
  ];
  if (model) {
    args.push("--model", model);
  } else {
    args.push("--model", "sonnet");
  }

  const { stdout } = await spawnWithStdin("claude", args, prompt, cwd);

  // claude --output-format json wraps the response in a JSON object with a "result" field
  let text = stdout.trim();
  try {
    const wrapper = JSON.parse(text);
    if (wrapper.result) {
      text = wrapper.result;
    }
  } catch {
    // Not wrapped, use as-is
  }

  return { commands: parseCommands(text) };
}

async function queryCodex(query: string, cwd: string, model?: string): Promise<AiResult> {
  const resultFile = join(tmpdir(), `aish-codex-${Date.now()}.txt`);
  const args = [
    "exec",
    "-o",
    resultFile,
    `${SYSTEM_PROMPT}\n\nUser request: ${query}`,
  ];
  if (model) {
    args.push("--model", model);
  }

  await execPromise("codex", args, cwd);
  const text = await readFile(resultFile, "utf-8");
  await unlink(resultFile).catch(() => {});

  return { commands: parseCommands(text) };
}

export type Provider = "claude" | "codex";

export async function queryAi(
  provider: Provider,
  query: string,
  cwd: string,
  model?: string,
): Promise<AiResult> {
  if (provider === "codex") {
    return queryCodex(query, cwd, model);
  }
  return queryClaude(query, cwd, model);
}

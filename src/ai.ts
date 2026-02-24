import { execFile, spawn } from "node:child_process";
import { readFile, writeFile, unlink, access, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

export interface AiResult {
  commands: string[];
  cacheKey?: string;
}

const SYSTEM_PROMPT = `You are a CLI assistant that converts natural language into the exact shell commands to run.

Some project files are provided below for reference so you don't need to read them yourself.

GUIDELINES:
1. Review the project files provided below to understand available scripts and commands.
2. If you need more context, use the Read tool to look at relevant files (scripts, configs, docs).
3. Prefer existing scripts/targets from package.json, Makefile, etc. over raw commands.
4. If unsure about exact flags, use common/standard ones or provide multiple options.

RESPONSE FORMAT — THIS IS CRITICAL:
Your final message MUST be ONLY a JSON object. No prose, no explanation, no "Based on...", no markdown.
Exactly this format: {"commands": ["command1"]}
If you are unsure which command the user wants, return multiple options and the user will pick: {"commands": ["option1", "option2"]}
Prefer existing scripts/targets with correct flags over raw commands.
For values the user hasn't specified, use <placeholders> like: git commit -m "<message>" or curl <url>. Use descriptive names inside the angle brackets.`;

const PROJECT_FILES = [
  "Makefile",
  "package.json",
  "README.md",
  "Justfile",
  "Taskfile.yml",
  "docker-compose.yml",
  "Cargo.toml",
  "pyproject.toml",
  "Gemfile",
];

const MAX_FILE_SIZE = 4000;

async function gatherProjectContext(cwd: string): Promise<string> {
  const sections: string[] = [];
  const found: string[] = [];
  for (const file of PROJECT_FILES) {
    const filePath = join(cwd, file);
    try {
      await access(filePath);
      let content = await readFile(filePath, "utf-8");
      if (content.length > MAX_FILE_SIZE) {
        content = content.slice(0, MAX_FILE_SIZE) + "\n...(truncated)";
      }
      sections.push(`--- ${file} ---\n${content}`);
      found.push(file);
    } catch {
      // File doesn't exist, skip
    }
  }
  if (found.length > 0) logVerbose(`  context: ${found.join(", ")}`);
  if (sections.length === 0) return "";
  return `\n\nProject files:\n\n${sections.join("\n\n")}`;
}

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

function tryParseJson(text: string): string[] | null {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed.command === "string") {
      return [parsed.command];
    }
    if (Array.isArray(parsed.commands) &&
        parsed.commands.every((c: unknown) => typeof c === "string")) {
      return parsed.commands;
    }
  } catch {}
  return null;
}

function parseResponse(raw: string): AiResult {
  let text = raw.trim();

  let commands = tryParseJson(text);
  if (commands) return { commands };

  // Try stripping code fences
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    commands = tryParseJson(fenceMatch[1].trim());
    if (commands) return { commands };
  }

  // Try extracting JSON object from prose
  const jsonMatch = text.match(/\{[\s\S]*"commands?"\s*:[\s\S]*\}/);
  if (jsonMatch) {
    commands = tryParseJson(jsonMatch[0]);
    if (commands) return { commands };
  }

  // Last resort: extract commands from backtick-wrapped code in prose
  const backtickCmds = [...text.matchAll(/`([^`]+)`/g)]
    .map((m) => m[1].trim())
    .filter((c) => c.length > 2 && !c.includes("{") && !c.startsWith("//"));
  if (backtickCmds.length > 0) return { commands: backtickCmds };

  throw new Error("Could not parse AI response. Run with -v to debug.");
}

const DIM = "\x1b[2m";
const R = "\x1b[0m";

function logVerbose(msg: string) {
  if (verbose) console.error(`${DIM}${msg}${R}`);
}

function formatStats(wrapper: any) {
  const lines: string[] = [];
  const duration = wrapper.duration_ms;
  const apiDuration = wrapper.duration_api_ms;
  const turns = wrapper.num_turns;
  const cost = wrapper.total_cost_usd;
  const usage = wrapper.usage;

  if (duration != null) {
    const secs = (duration / 1000).toFixed(1);
    const apiSecs = apiDuration ? ` (api: ${(apiDuration / 1000).toFixed(1)}s)` : "";
    lines.push(`  time: ${secs}s${apiSecs}`);
  }
  if (turns != null) lines.push(`  turns: ${turns}`);
  if (cost != null) lines.push(`  cost: $${cost.toFixed(4)}`);
  if (usage) {
    const input = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
    const output = usage.output_tokens || 0;
    lines.push(`  tokens: ${input} in / ${output} out`);
  }
  return lines.join("\n");
}

// --- Cache ---
const CACHE_DIR = join(homedir(), ".cache", "aish");
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function cacheKey(query: string, context: string, model: string): string {
  return createHash("sha256").update(`${model}:${query}:${context}`).digest("hex").slice(0, 16);
}

async function cacheGet(key: string): Promise<AiResult | null> {
  try {
    const filePath = join(CACHE_DIR, `${key}.json`);
    const stat = await access(filePath).then(() => true).catch(() => false);
    if (!stat) return null;
    const raw = await readFile(filePath, "utf-8");
    const entry = JSON.parse(raw);
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
      await unlink(filePath).catch(() => {});
      return null;
    }
    return entry.result;
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, result: AiResult): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(join(CACHE_DIR, `${key}.json`), JSON.stringify({ ts: Date.now(), result }));
  } catch {
    // Non-fatal
  }
}

function spawnWithStdin(
  cmd: string,
  args: string[],
  input: string,
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  logVerbose(`$ ${cmd} ${args.join(" ")}`);
  logVerbose(`  cwd: ${cwd}`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      if (verbose && stderr) logVerbose(`stderr: ${stderr.slice(0, 500)}`);
      if (code !== 0) reject(new Error(`${cmd} exited with code ${code}\n${stderr}`));
      else resolve({ stdout, stderr });
    });
    child.on("error", reject);
    child.stdin.write(input);
    child.stdin.end();
  });
}

async function queryClaude(query: string, cwd: string, model?: string): Promise<AiResult> {
  const effectiveModel = model || "sonnet";
  const context = await gatherProjectContext(cwd);

  // Check cache
  const key = cacheKey(query, context, effectiveModel);
  const cached = await cacheGet(key);
  if (cached) {
    logVerbose("  cache: hit");
    return cached;
  }

  const prompt = `${SYSTEM_PROMPT}${context}\n\nUser request: ${query}`;
  const args = [
    "-p",
    "--output-format",
    "json",
    "--model",
    effectiveModel,
    "--allowedTools",
    "Read,Glob",
  ];

  const { stdout } = await spawnWithStdin("claude", args, prompt, cwd);

  // claude --output-format json wraps the response in a JSON object with a "result" field
  let text = stdout.trim();
  try {
    const wrapper = JSON.parse(text);
    if (verbose) {
      logVerbose(formatStats(wrapper));
      if (wrapper.result) logVerbose(`  result: ${wrapper.result}`);
    }
    if (wrapper.result) {
      text = wrapper.result;
    }
  } catch {
    // Not wrapped, use as-is
    if (verbose) logVerbose(`  raw: ${text.slice(0, 500)}`);
  }

  const result = parseResponse(text);
  result.cacheKey = key;
  return result;
}

async function queryCodex(query: string, cwd: string, model?: string): Promise<AiResult> {
  const context = await gatherProjectContext(cwd);
  const resultFile = join(tmpdir(), `aish-codex-${Date.now()}.txt`);
  const prompt = `${SYSTEM_PROMPT}${context}\n\nUser request: ${query}`;
  const args = [
    "exec",
    "--sandbox",
    "read-only",
    "-o",
    resultFile,
    "-",  // Read prompt from stdin
  ];
  if (model) {
    args.push("--model", model);
  }

  // Pass prompt via stdin for safety with special characters
  await spawnWithStdin("codex", args, prompt, cwd);
  const text = await readFile(resultFile, "utf-8");
  await unlink(resultFile).catch(() => {});

  return parseResponse(text);
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

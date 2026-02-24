import { execFile, spawn } from "node:child_process";
import { readFile, writeFile, unlink, access, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

export interface AiStats {
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  cached?: boolean;
}

export interface AiResult {
  commands: string[];
  cacheKey?: string;
  stats?: AiStats;
}

const SYSTEM_PROMPT = `You are a CLI assistant that converts natural language into the exact shell commands to run.

GUIDELINES:
1. For standard commands (git, ls, curl, etc.), respond immediately without reading files.
2. For project-specific commands (build, test, run scripts, etc.), ALWAYS read README.md first (if it exists), then the relevant config file:
   - Node.js: package.json
   - Python: pyproject.toml, setup.py, or Pipfile
   - Rust: Cargo.toml
   - Go: go.mod
   - Ruby: Gemfile
   - Make: Makefile
   - Other: Justfile, Taskfile.yml
3. ALWAYS prefer project scripts over direct tool invocation:
   - Use "npm run build" not "tsup" or "tsc"
   - Use "make test" not the underlying test command
   - Use "cargo build" not "rustc" directly
   This ensures correct flags, environment, and project configuration.
4. If unsure about exact flags, provide multiple options.

RESPONSE FORMAT — THIS IS CRITICAL:
Your final message MUST be ONLY a JSON object. No prose, no explanation, no "Based on...", no markdown.
Exactly this format: {"commands": ["command1"]}
If you are unsure which command the user wants, return multiple options and the user will pick: {"commands": ["option1", "option2"]}
For values the user hasn't specified, use <placeholders> like: git commit -m "<message>" or curl <url>. Use descriptive names inside the angle brackets.`;

// Detect tooling based on lockfiles and config files
const TOOL_HINTS: Array<{ files: string[]; hint: string }> = [
  { files: ["bun.lockb", "bun.lock"], hint: "Use bun (not npm/yarn/pnpm)" },
  { files: ["pnpm-lock.yaml"], hint: "Use pnpm (not npm/yarn)" },
  { files: ["yarn.lock"], hint: "Use yarn (not npm/pnpm)" },
  { files: ["package-lock.json"], hint: "Use npm (not yarn/pnpm)" },
  { files: ["Cargo.lock"], hint: "Use cargo for Rust commands" },
  { files: ["poetry.lock"], hint: "Use poetry (not pip)" },
  { files: ["Pipfile.lock"], hint: "Use pipenv (not pip)" },
  { files: ["uv.lock"], hint: "Use uv (not pip/poetry)" },
  { files: ["Gemfile.lock"], hint: "Use bundle exec for Ruby commands" },
  { files: ["go.sum"], hint: "Use go modules" },
  { files: ["flake.lock"], hint: "Nix flake project - use nix commands" },
];

async function gatherProjectContext(cwd: string): Promise<string> {
  const hints: string[] = [];
  for (const { files, hint } of TOOL_HINTS) {
    for (const file of files) {
      try {
        await access(join(cwd, file));
        hints.push(hint);
        break; // Only add hint once per tool
      } catch {
        // File doesn't exist
      }
    }
  }

  if (hints.length > 0) logVerbose(`  hints: ${hints.join(", ")}`);

  if (hints.length === 0) return "";
  return `\n\nTool hints:\n- ${hints.join("\n- ")}`;
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
    return { ...cached, stats: { cached: true } };
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
  let stats: AiStats = {};
  try {
    const wrapper = JSON.parse(text);
    if (verbose) {
      logVerbose(formatStats(wrapper));
      if (wrapper.result) logVerbose(`  result: ${wrapper.result}`);
    }
    // Extract stats
    stats.durationMs = wrapper.duration_ms;
    stats.cost = wrapper.total_cost_usd;
    if (wrapper.usage) {
      stats.inputTokens = (wrapper.usage.input_tokens || 0) +
        (wrapper.usage.cache_creation_input_tokens || 0) +
        (wrapper.usage.cache_read_input_tokens || 0);
      stats.outputTokens = wrapper.usage.output_tokens || 0;
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
  result.stats = stats;
  return result;
}

async function queryCodex(query: string, cwd: string, model?: string): Promise<AiResult> {
  const startTime = Date.now();
  const context = await gatherProjectContext(cwd);
  const resultFile = join(tmpdir(), `aish-codex-${Date.now()}.txt`);
  const prompt = `${SYSTEM_PROMPT}${context}\n\nUser request: ${query}`;
  const args = [
    "exec",
    "--sandbox",
    "read-only",
    "-c",
    "model_reasoning_effort=\"low\"",
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

  const result = parseResponse(text);
  result.stats = { durationMs: Date.now() - startTime };
  return result;
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

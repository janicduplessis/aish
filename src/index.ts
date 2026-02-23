import { queryAi, setVerbose, type Provider } from "./ai.js";
import { promptCommand } from "./ui.js";
import { execCommand } from "./exec.js";

const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const RED = "\x1b[31m";

function startSpinner(message: string): () => void {
  let i = 0;
  const interval = setInterval(() => {
    process.stderr.write(`\r${DIM}${BRAILLE[i++ % BRAILLE.length]} ${message}${RESET}`);
  }, 80);
  return () => {
    clearInterval(interval);
    process.stderr.write("\r\x1b[K");
  };
}

function parseArgs(argv: string[]): {
  query: string;
  provider: Provider;
  cwd: string;
  model?: string;
  verbose: boolean;
} {
  const args = argv.slice(2);
  let provider: Provider = (process.env.AISH_PROVIDER as Provider) || "claude";
  let cwd = process.cwd();
  let model: string | undefined = process.env.AISH_MODEL || undefined;
  let verbose = false;
  const queryParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-p" || arg === "--provider") {
      const val = args[++i];
      if (val !== "claude" && val !== "codex") {
        console.error(`${RED}Invalid provider: ${val}. Use "claude" or "codex".${RESET}`);
        process.exit(1);
      }
      provider = val;
    } else if (arg === "--cwd") {
      cwd = args[++i];
    } else if (arg === "-m" || arg === "--model") {
      model = args[++i];
    } else if (arg === "-v" || arg === "--verbose") {
      verbose = true;
    } else if (arg === "-h" || arg === "--help") {
      console.log(`Usage: aish [options] <query...>

Options:
  -p, --provider <claude|codex>  AI provider (default: claude, env: AISH_PROVIDER)
  -m, --model <model>            Model override (env: AISH_MODEL)
  --cwd <dir>                    Working directory
  -v, --verbose                  Show debug output
  -h, --help                     Show help`);
      process.exit(0);
    } else {
      queryParts.push(arg);
    }
  }

  return { query: queryParts.join(" "), provider, cwd, model, verbose };
}

async function main() {
  const { query, provider, cwd, model, verbose } = parseArgs(process.argv);
  setVerbose(verbose);

  if (!query) {
    console.error(`${RED}Usage: aish <query>${RESET}`);
    process.exit(1);
  }

  const stopSpinner = verbose ? () => {} : startSpinner("Thinking...");
  let commands: string[];
  try {
    const result = await queryAi(provider, query, cwd, model);
    commands = result.commands;
  } catch (err: any) {
    stopSpinner();
    console.error(`${RED}Error: ${err.message}${RESET}`);
    process.exit(1);
  }
  stopSpinner();

  if (commands.length === 0) {
    console.error(`${RED}No commands suggested.${RESET}`);
    process.exit(1);
  }

  let chosen: string | null;
  try {
    chosen = await promptCommand(commands);
  } catch {
    // User pressed Ctrl+C during prompt
    console.log();
    process.exit(130);
  }

  if (!chosen) {
    process.exit(0);
  }

  const exitCode = await execCommand(chosen, cwd);
  process.exit(exitCode);
}

main();

import { createInterface } from "node:readline";
import { select, input } from "@inquirer/prompts";

const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const PLACEHOLDER_RE = /<([^>]+)>/g;

async function fillPlaceholders(cmd: string): Promise<string | null> {
  const placeholders = [...cmd.matchAll(PLACEHOLDER_RE)];
  if (placeholders.length === 0) return cmd;

  console.log(`${DIM}  Fill in the placeholders:${RESET}`);
  let result = cmd;
  const seen = new Set<string>();
  for (const match of placeholders) {
    const full = match[0];
    const name = match[1];
    if (seen.has(full)) continue;
    seen.add(full);

    const value = await input({
      message: `${YELLOW}${name}${RESET}`,
    });
    if (!value.trim()) return null;
    result = result.replaceAll(full, value);
  }
  return result;
}

function promptEdit(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    rl.write(cmd);
    rl.on("line", (line) => {
      rl.close();
      const trimmed = line.trim();
      resolve(trimmed || null);
    });
    rl.on("close", () => resolve(null));
  });
}

async function promptAction(cmd: string): Promise<string | null> {
  const hasPlaceholders = PLACEHOLDER_RE.test(cmd);
  PLACEHOLDER_RE.lastIndex = 0;

  const action = await select({
    message: "Action:",
    choices: [
      { name: hasPlaceholders ? "Run (fill placeholders)" : "Run", value: "run" },
      { name: `Edit ${DIM}(modify command before running)${RESET}`, value: "edit" },
      { name: "Cancel", value: "cancel" },
    ],
  });

  if (action === "run") return fillPlaceholders(cmd);
  if (action === "edit") {
    process.stdout.write(`${DIM}> ${RESET}`);
    return promptEdit(cmd);
  }
  return null;
}

export async function promptCommand(commands: string[]): Promise<string | null> {
  if (commands.length === 1) {
    console.log(`\n  ${CYAN}${commands[0]}${RESET}\n`);
    return promptAction(commands[0]);
  }

  const choice = await select({
    message: "Select a command:",
    choices: [
      ...commands.map((cmd) => ({
        name: `${CYAN}${cmd}${RESET}`,
        value: cmd,
      })),
      { name: "Cancel", value: "__cancel__" },
    ],
  });

  if (choice === "__cancel__") return null;
  console.log(`\n  ${CYAN}${choice}${RESET}\n`);
  return promptAction(choice);
}

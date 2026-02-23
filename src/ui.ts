import { select, input } from "@inquirer/prompts";

const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

async function promptEdit(cmd: string): Promise<string | null> {
  const edited = await input({
    message: "Edit command:",
    default: cmd,
  });
  const trimmed = edited.trim();
  return trimmed || null;
}

async function promptAction(cmd: string): Promise<string | null> {
  console.log(`\n  ${CYAN}${cmd}${RESET}\n`);
  const action = await select({
    message: "Action:",
    choices: [
      { name: "Run", value: "run" },
      { name: "Edit", value: "edit" },
      { name: "Cancel", value: "cancel" },
    ],
  });

  if (action === "run") return cmd;
  if (action === "edit") return promptEdit(cmd);
  return null;
}

export async function promptCommand(commands: string[]): Promise<string | null> {
  if (commands.length === 1) {
    return promptAction(commands[0]);
  }

  const choice = await select({
    message: "Select a command to run:",
    choices: [
      ...commands.map((cmd) => ({
        name: `${CYAN}${cmd}${RESET}`,
        value: cmd,
      })),
      { name: "Cancel", value: "__cancel__" },
    ],
  });

  if (choice === "__cancel__") return null;
  return promptAction(choice);
}

import { spawn } from "node:child_process";

export function execCommand(cmd: string, cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/bash";
    const child = spawn(shell, ["-c", cmd], {
      stdio: "inherit",
      cwd,
    });

    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

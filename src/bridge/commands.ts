import { splitShellArgs } from "../util/shell-args.js";

export interface ParsedCommand {
  name: string;
  args: string[];
  raw: string;
}

export function parseCommand(text: string): ParsedCommand | null {
  const raw = text.trim();
  if (!raw.startsWith("/") || raw === "/") return null;
  const [head = "", ...args] = splitShellArgs(raw.slice(1).trim());
  if (!head) return null;
  return { name: normalizeCommandName(head), args, raw };
}

export function normalizeCommandName(name: string): string {
  const normalized = name.trim().toLowerCase();
  const aliases: Record<string, string> = {
    h: "help",
    st: "status",
    n: "new",
    r: "retry",
    s: "stop",
    routes: "routes",
    ls: "routes",
    cd: "cwd",
  };
  return aliases[normalized] ?? normalized;
}

export function helpText(): string {
  return [
    "Wechat Codex Bridge",
    "",
    "/help - show commands",
    "/status - show bridge status for this chat",
    "/new [cwd] - start a new Codex thread for this chat",
    "/cwd <path> - set working directory for this chat",
    "/retry - retry the last prompt in this chat",
    "/stop - stop the running Codex task for this chat",
    "/routes - list known chats",
    "/pair <code> - trust this chat after reading the terminal code",
    "",
    "Send any normal message to run Codex.",
  ].join("\n");
}

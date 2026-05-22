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
    "微信 Codex Bridge 命令",
    "",
    "/help - 显示命令",
    "/status - 查看当前聊天状态",
    "/new [cwd] - 为当前聊天开启新 Codex 对话，可选切换工作目录",
    "/cwd <path> - 设置当前聊天的工作目录",
    "/retry - 重试当前聊天上一条任务",
    "/stop - 停止当前聊天正在运行的任务",
    "/routes - 列出已记录的微信聊天",
    "/pair <code> - 输入终端里的配对码，信任当前聊天",
    "",
    "别名：/st=/status，/n=/new，/cd=/cwd，/r=/retry，/s=/stop，/ls=/routes",
    "直接发送普通消息即可运行 Codex。",
  ].join("\n");
}

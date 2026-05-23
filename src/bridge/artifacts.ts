import fs from "node:fs";
import path from "node:path";

const ARTIFACT_EXTENSION_SOURCE = "png|jpe?g|webp|gif|svg|pdf|html?|docx?|xlsx?|pptx?|rtf";
const ARTIFACT_EXTENSIONS = new RegExp(`\\.(?:${ARTIFACT_EXTENSION_SOURCE})$`, "i");
const ARTIFACT_LINE = /(artifact|output|file|path|image|poster|generated|saved|created|海报|图片|图像|文件|文档|表格|演示|附件|产物|生成|保存|输出|发给|发送|这里|位置)/i;
const ARTIFACT_DIRECTIVE = /(artifact|output|file|path|image|poster|generated|saved|created|海报|图片|图像|文件|文档|表格|演示|附件|产物|生成|保存|输出|发给|发送|这里|位置)\s*(?:在这里|位置|路径)?\s*[:：]/i;

export function extractArtifactPaths(text: string, cwd: string): string[] {
  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const candidates = extractPathLikes(line);
    if (candidates.length === 0) continue;
    if (!ARTIFACT_LINE.test(line) && !isPathOnlyLine(line, candidates)) continue;
    for (const candidate of candidates) {
      const resolved = resolveArtifactPath(candidate, cwd);
      if (resolved) out.add(resolved);
    }
  }
  return [...out];
}

export function stripArtifactDirectives(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const candidates = extractPathLikes(line);
      if (candidates.length === 0) return true;
      return !ARTIFACT_DIRECTIVE.test(line) && !isPathOnlyLine(line, candidates);
    })
    .join("\n")
    .trim();
}

export function isImageArtifactRequest(prompt: string): boolean {
  return /(生成|制作|做|设计|画|create|make|design|generate)/i.test(prompt)
    && /(海报|图片|图像|配图|poster|image|flyer|banner)/i.test(prompt);
}

export function isPlaceholderArtifactReply(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length < 120 && /imagegen|生成.*海报|生成.*图片|会用|will use/i.test(trimmed);
}

function extractPathLikes(text: string): string[] {
  const out: string[] = [];
  const markdown = /\[[^\]]+\]\(([^)]+)\)/g;
  for (const match of text.matchAll(markdown)) out.push(match[1] ?? "");

  const quoted = new RegExp("[`'\"]([^`'\"]+\\.(?:" + ARTIFACT_EXTENSION_SOURCE + "))[`'\"]", "gi");
  for (const match of text.matchAll(quoted)) out.push(match[1] ?? "");

  const absolute = new RegExp(`((?:[A-Za-z]:\\\\|/)[^\\s)]+?\\.(?:${ARTIFACT_EXTENSION_SOURCE}))`, "gi");
  for (const match of text.matchAll(absolute)) out.push(match[1] ?? "");

  const relative = new RegExp(`((?:\\.{1,2}[\\\\/]|wechat-codex-artifacts[\\\\/])?[^\\s)]+?\\.(?:${ARTIFACT_EXTENSION_SOURCE}))`, "gi");
  for (const match of text.matchAll(relative)) out.push(match[1] ?? "");
  return out;
}

function isPathOnlyLine(line: string, candidates: string[]): boolean {
  const normalized = line.trim().replace(/^[`'"\s]+|[`'"\s,，。.)）]+$/g, "");
  return candidates.some((candidate) => normalized === cleanCandidate(candidate));
}

function resolveArtifactPath(candidate: string, cwd: string): string | undefined {
  const cleaned = cleanCandidate(candidate);
  if (!cleaned || !ARTIFACT_EXTENSIONS.test(cleaned)) return undefined;
  const withoutScheme = cleaned.startsWith("file://") ? cleaned.slice("file://".length) : cleaned;
  const decoded = safeDecodeUri(withoutScheme);
  const resolved = path.isAbsolute(decoded) ? decoded : path.resolve(cwd, decoded);
  return fs.existsSync(resolved) ? resolved : undefined;
}

function cleanCandidate(value: string): string {
  return value
    .trim()
    .replace(/^[`'"\s]+|[`'"\s,，。.)）]+$/g, "");
}

function safeDecodeUri(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

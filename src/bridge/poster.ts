import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

export interface PosterArtifact {
  path: string;
  title: string;
}

export async function createFallbackPoster(prompt: string, cwd: string): Promise<PosterArtifact> {
  const subject = posterSubject(prompt);
  const title = subject ? `${subject}旅行海报` : "旅行海报";
  const dir = path.join(cwd, "wechat-codex-artifacts");
  await fs.mkdir(dir, { recursive: true });
  const slug = safeSlug(subject || "travel-poster");
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const svgPath = path.join(dir, `${stamp}-${slug}.svg`);
  const pngPath = path.join(dir, `${stamp}-${slug}.png`);
  const svg = buildPosterSvg(title, subject || "目的地");
  await fs.writeFile(svgPath, svg, "utf8");
  await sharp(Buffer.from(svg), { limitInputPixels: false }).png().toFile(pngPath);
  return { path: pngPath, title };
}

export function posterReadyText(prompt: string): string {
  const subject = posterSubject(prompt);
  return `已生成${subject ? `「${subject}」` : ""}旅游海报，下面发图。`;
}

function posterSubject(prompt: string): string {
  return prompt
    .replace(/请|帮我|麻烦|生成|制作|设计|做一?张?|画一?张?|旅游海报|旅行海报|海报|poster/gi, "")
    .replace(/[，。,.!！?？:：]/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 24);
}

function buildPosterSvg(title: string, subject: string): string {
  const safeTitle = escapeXml(title);
  const safeSubject = escapeXml(subject);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1300" viewBox="0 0 900 1300">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#6cc7e8"/>
      <stop offset="52%" stop-color="#f7cf87"/>
      <stop offset="100%" stop-color="#f6f0de"/>
    </linearGradient>
    <linearGradient id="sea" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#177e9f"/>
      <stop offset="100%" stop-color="#39b7b2"/>
    </linearGradient>
    <filter id="soft" x="-10%" y="-10%" width="120%" height="120%">
      <feGaussianBlur stdDeviation="10"/>
    </filter>
  </defs>
  <rect width="900" height="1300" fill="url(#sky)"/>
  <circle cx="675" cy="260" r="90" fill="#fff0b3" opacity="0.95"/>
  <circle cx="675" cy="260" r="125" fill="#fff0b3" opacity="0.25" filter="url(#soft)"/>
  <path d="M0 610 C130 550 250 660 380 595 C520 525 650 625 900 560 L900 1300 L0 1300Z" fill="url(#sea)"/>
  <path d="M0 720 C140 668 282 770 440 710 C605 648 720 745 900 690" fill="none" stroke="#e9fbff" stroke-width="20" opacity="0.8"/>
  <path d="M0 805 C180 745 300 860 480 795 C635 740 748 845 900 790" fill="none" stroke="#e9fbff" stroke-width="14" opacity="0.65"/>
  <path d="M0 1015 C170 955 300 1115 512 1035 C680 972 770 1070 900 1035 L900 1300 L0 1300Z" fill="#f4d7a1"/>
  <g fill="#0c3440" opacity="0.9">
    <text x="70" y="160" font-size="34" font-family="Arial, 'Microsoft YaHei', sans-serif" letter-spacing="5">TRAVEL POSTER</text>
    <text x="70" y="260" font-size="76" font-weight="800" font-family="Arial, 'Microsoft YaHei', sans-serif">${safeTitle}</text>
    <text x="74" y="335" font-size="34" font-family="Arial, 'Microsoft YaHei', sans-serif">海风 / 日出 / 沙滩 / 慢旅行</text>
  </g>
  <g transform="translate(74 1010)" fill="#12333b">
    <text x="0" y="0" font-size="34" font-weight="700" font-family="Arial, 'Microsoft YaHei', sans-serif">${safeSubject}</text>
    <text x="0" y="56" font-size="26" font-family="Arial, 'Microsoft YaHei', sans-serif">把海边的风景装进口袋，今天就出发。</text>
  </g>
  <rect x="70" y="1135" width="760" height="88" rx="44" fill="#12333b" opacity="0.92"/>
  <text x="450" y="1192" font-size="34" text-anchor="middle" fill="#fff9e6" font-weight="700" font-family="Arial, 'Microsoft YaHei', sans-serif">CITY WALK · COASTLINE · SUNSET</text>
</svg>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "poster";
}

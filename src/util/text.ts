export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function sliceUtf8(text: string, maxBytes: number): string {
  let used = 0;
  let out = "";
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (used + size > maxBytes) break;
    out += char;
    used += size;
  }
  return out;
}

export function splitForWeChat(input: unknown, maxBytes = 1800): string[] {
  const text = String(input ?? "").replace(/\r\n/g, "\n").trim();
  if (!text) return [];
  const chunks: string[] = [];
  for (const block of splitBlocks(text)) {
    if (utf8Bytes(block) <= maxBytes) {
      appendPacked(chunks, block, maxBytes);
      continue;
    }
    for (const piece of splitLongBlock(block, maxBytes)) {
      appendPacked(chunks, piece, maxBytes);
    }
  }
  return chunks;
}

export function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "unknown error");
  return message.replace(/\s+/g, " ").trim();
}

function splitBlocks(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^```/.test(line.trim())) {
      current.push(line);
      inFence = !inFence;
      continue;
    }
    if (!inFence && !line.trim()) {
      if (current.length > 0) {
        blocks.push(current.join("\n").trim());
        current = [];
      }
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current.join("\n").trim());
  return blocks.filter(Boolean);
}

function appendPacked(chunks: string[], block: string, maxBytes: number): void {
  const last = chunks.at(-1);
  if (!last) {
    chunks.push(block);
    return;
  }
  const candidate = `${last}\n\n${block}`;
  if (utf8Bytes(candidate) <= maxBytes) {
    chunks[chunks.length - 1] = candidate;
  } else {
    chunks.push(block);
  }
}

function splitLongBlock(block: string, maxBytes: number): string[] {
  const pieces: string[] = [];
  let rest = block.trim();
  while (rest) {
    const head = sliceUtf8(rest, maxBytes);
    if (!head) break;
    const newline = head.lastIndexOf("\n");
    const space = head.lastIndexOf(" ");
    const cut = newline > maxBytes * 0.55 ? newline : space > maxBytes * 0.55 ? space : head.length;
    const piece = rest.slice(0, cut).trim();
    if (piece) pieces.push(piece);
    rest = rest.slice(cut).trim();
  }
  return pieces;
}

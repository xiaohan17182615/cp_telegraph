export function splitShellArgs(value: string | undefined): string[] {
  const input = String(value ?? "").trim();
  if (!input) return [];
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escape = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] as string;
    const next = input[index + 1];
    if (escape) {
      current += char;
      escape = false;
      continue;
    }
    if (char === "\\" && (next === "\\" || next === "'" || next === '"' || /\s/.test(next ?? ""))) {
      escape = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escape) current += "\\";
  if (quote) throw new Error(`unterminated quote in arguments: ${input}`);
  if (current) args.push(current);
  return args;
}

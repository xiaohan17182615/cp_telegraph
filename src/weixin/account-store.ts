import fs from "node:fs";
import path from "node:path";

export interface StoredWeixinAccount {
  accountId: string;
  token: string;
  baseUrl: string;
  userId?: string;
  savedAt: string;
  syncCursor?: string;
}

export class WeixinAccountStore {
  constructor(private readonly rootDir: string) {}

  listAccountIds(): string[] {
    try {
      if (!fs.existsSync(this.rootDir)) return [];
      return fs.readdirSync(this.rootDir)
        .filter((name) => name.endsWith(".json") && !name.endsWith(".context.json"))
        .map((name) => name.slice(0, -5))
        .sort();
    } catch {
      return [];
    }
  }

  getDefaultAccount(): StoredWeixinAccount | undefined {
    const ids = this.listAccountIds();
    return ids.length > 0 ? this.load(ids.at(-1) as string) : undefined;
  }

  load(accountId: string): StoredWeixinAccount | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.accountPath(accountId), "utf8")) as StoredWeixinAccount;
      if (!parsed.accountId || !parsed.token || !parsed.baseUrl) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  save(account: StoredWeixinAccount): void {
    fs.mkdirSync(this.rootDir, { recursive: true });
    const filePath = this.accountPath(account.accountId);
    fs.writeFileSync(filePath, `${JSON.stringify(account, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Best effort for platforms without POSIX chmod semantics.
    }
  }

  saveSyncCursor(accountId: string, syncCursor: string): void {
    const account = this.load(accountId);
    if (!account) return;
    this.save({ ...account, syncCursor });
  }

  private accountPath(accountId: string): string {
    return path.join(this.rootDir, `${safeAccountId(accountId)}.json`);
  }
}

export function safeAccountId(accountId: string): string {
  return accountId.trim().replace(/[^A-Za-z0-9_.-]+/g, "-") || "weixin-account";
}

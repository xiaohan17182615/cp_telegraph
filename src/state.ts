import fs from "node:fs";
import path from "node:path";

export interface RouteState {
  routeKey: string;
  trusted: boolean;
  pairedAt?: string;
  codexThreadId?: string;
  cwd?: string;
  lastPrompt?: string;
  contextToken?: string;
  updatedAt: string;
}

export interface BridgeStateDocument {
  version: 1;
  routes: RouteState[];
}

export class JsonStateStore {
  constructor(private readonly filePath: string) {}

  getRoute(routeKey: string): RouteState | undefined {
    return this.read().routes.find((route) => route.routeKey === routeKey);
  }

  upsertRoute(route: RouteState): RouteState {
    const doc = this.read();
    const index = doc.routes.findIndex((item) => item.routeKey === route.routeKey);
    const next = { ...route, updatedAt: route.updatedAt || new Date().toISOString() };
    if (index >= 0) doc.routes[index] = next;
    else doc.routes.push(next);
    this.write(doc);
    return next;
  }

  trustRoute(routeKey: string): RouteState {
    const current = this.getRoute(routeKey);
    return this.upsertRoute({
      routeKey,
      trusted: true,
      pairedAt: new Date().toISOString(),
      codexThreadId: current?.codexThreadId,
      cwd: current?.cwd,
      lastPrompt: current?.lastPrompt,
      contextToken: current?.contextToken,
      updatedAt: new Date().toISOString(),
    });
  }

  listRoutes(): RouteState[] {
    return [...this.read().routes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  read(): BridgeStateDocument {
    try {
      if (!fs.existsSync(this.filePath)) return { version: 1, routes: [] };
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as BridgeStateDocument;
      return {
        version: 1,
        routes: Array.isArray(parsed.routes)
          ? parsed.routes.filter((route) => typeof route.routeKey === "string" && route.routeKey)
          : [],
      };
    } catch {
      return { version: 1, routes: [] };
    }
  }

  write(doc: BridgeStateDocument): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // Best effort on Windows and unusual filesystems.
    }
  }
}

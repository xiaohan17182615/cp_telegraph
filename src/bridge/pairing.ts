import crypto from "node:crypto";

export interface PairingChallenge {
  routeKey: string;
  code: string;
  expiresAt: number;
  attempts: number;
}

export class PairingManager {
  private readonly challenges = new Map<string, PairingChallenge>();

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly maxAttempts = 5,
  ) {}

  getOrCreate(routeKey: string): PairingChallenge {
    const existing = this.challenges.get(routeKey);
    if (existing && existing.expiresAt > Date.now() && existing.attempts < this.maxAttempts) return existing;
    const challenge: PairingChallenge = {
      routeKey,
      code: crypto.randomInt(100000, 999999).toString(),
      expiresAt: Date.now() + this.ttlMs,
      attempts: 0,
    };
    this.challenges.set(routeKey, challenge);
    return challenge;
  }

  verify(routeKey: string, code: string): { ok: true } | { ok: false; reason: "missing" | "expired" | "locked" | "wrong" } {
    const challenge = this.challenges.get(routeKey);
    if (!challenge) return { ok: false, reason: "missing" };
    if (challenge.expiresAt <= Date.now()) {
      this.challenges.delete(routeKey);
      return { ok: false, reason: "expired" };
    }
    if (challenge.attempts >= this.maxAttempts) {
      this.challenges.delete(routeKey);
      return { ok: false, reason: "locked" };
    }
    if (challenge.code !== code.trim()) {
      challenge.attempts += 1;
      return { ok: false, reason: "wrong" };
    }
    this.challenges.delete(routeKey);
    return { ok: true };
  }
}

export function parsePairCommand(text: string): string | null {
  const match = text.trim().match(/^\/?pair\s+([0-9]{6})$/i);
  return match?.[1] ?? null;
}

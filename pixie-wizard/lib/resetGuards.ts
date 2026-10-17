import { createHash } from "node:crypto";

export interface ResetGuardInput {
  fingerprint: string;
  confirm: string;
  allowProduction: boolean;
  phrase: string;
  railwayEnvironment?: string;
  nodeEnv?: string;
}

export function databaseFingerprint(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  return createHash("sha256").update(`${url.host}${databaseName}`).digest("hex").slice(0, 8);
}

export function checkResetGuards(input: ResetGuardInput): { ok: true } | { ok: false; error: string } {
  if (input.confirm !== input.fingerprint)
    return { ok: false, error: `confirmation fingerprint mismatch; expected ${input.fingerprint}` };
  const production = Boolean(input.railwayEnvironment) || input.nodeEnv === "production";
  if (production && (!input.allowProduction || input.phrase !== `RESET-${input.fingerprint}`)) {
    return { ok: false, error: `production reset requires --allow-production and --phrase RESET-${input.fingerprint}` };
  }
  return { ok: true };
}

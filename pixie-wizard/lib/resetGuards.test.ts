import { test, expect } from "bun:test";
import { databaseFingerprint, checkResetGuards } from "./resetGuards";

test("wizard fingerprint uses only the database host and database name", () => {
  const first = databaseFingerprint("postgres://user:secret@example.test:5432/pixie");
  const second = databaseFingerprint("postgres://other:credentials@example.test:5432/pixie");
  expect(first).toBe(second);
  expect(first).toMatch(/^[0-9a-f]{8}$/);
});

test("reset guard requires the exact fingerprint", () => {
  const result = checkResetGuards({
    fingerprint: "deadbeef",
    confirm: "badcafe0",
    allowProduction: false,
    phrase: "",
    railwayEnvironment: "",
    nodeEnv: "development",
  });
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/fingerprint/i);
});

test("production guard requires the explicit allow switch and phrase", () => {
  const blocked = checkResetGuards({
    fingerprint: "deadbeef",
    confirm: "deadbeef",
    allowProduction: false,
    phrase: "",
    railwayEnvironment: "production",
    nodeEnv: "production",
  });
  expect(blocked.ok).toBe(false);
  expect(blocked.error).toMatch(/allow-production/i);

  const allowed = checkResetGuards({
    fingerprint: "deadbeef",
    confirm: "deadbeef",
    allowProduction: true,
    phrase: "RESET-deadbeef",
    railwayEnvironment: "production",
    nodeEnv: "production",
  });
  expect(allowed).toEqual({ ok: true });
});

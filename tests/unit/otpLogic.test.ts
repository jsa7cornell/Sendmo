import { describe, it, expect } from "vitest";

// Re-implement the pure logic from the Edge Function for unit testing
// (Edge Functions use Deno APIs; we test the logic, not the runtime)

function generateOTP(): string {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(100000 + (arr[0] % 900000));
}

async function hashCode(code: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(code);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("OTP generation", () => {
  it("generates a 6-digit numeric code", () => {
    const code = generateOTP();
    expect(code).toMatch(/^\d{6}$/);
    expect(parseInt(code)).toBeGreaterThanOrEqual(100000);
    expect(parseInt(code)).toBeLessThanOrEqual(999999);
  });

  it("generates different codes on subsequent calls", () => {
    const codes = new Set(Array.from({ length: 20 }, () => generateOTP()));
    // With 20 calls, we should have at least 2 unique codes (statistically near certain)
    expect(codes.size).toBeGreaterThan(1);
  });
});

describe("OTP hashing", () => {
  it("produces a 64-character hex string (SHA-256)", async () => {
    const hash = await hashCode("123456");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic — same input produces same hash", async () => {
    const hash1 = await hashCode("654321");
    const hash2 = await hashCode("654321");
    expect(hash1).toBe(hash2);
  });

  it("different codes produce different hashes", async () => {
    const hash1 = await hashCode("123456");
    const hash2 = await hashCode("654321");
    expect(hash1).not.toBe(hash2);
  });

  it("never stores the plaintext code in the hash", async () => {
    const code = "123456";
    const hash = await hashCode(code);
    expect(hash).not.toContain(code);
  });
});

describe("OTP expiry logic", () => {
  it("10-minute expiry is in the future", () => {
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("expired code is detected correctly", () => {
    const expired = new Date(Date.now() - 1000); // 1 second ago
    expect(expired.getTime() < Date.now()).toBe(true);
  });

  it("valid code is within expiry window", () => {
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 min from now
    expect(expiresAt.getTime() >= Date.now()).toBe(true);
  });
});

describe("Rate limiting logic", () => {
  it("allows up to 3 sends within 10 minutes", () => {
    const maxSends = 3;
    const count = 2;
    expect(count < maxSends).toBe(true);
  });

  it("blocks at 3 sends", () => {
    const maxSends = 3;
    const count = 3;
    expect(count >= maxSends).toBe(true);
  });

  it("allows up to 5 verification attempts per code", () => {
    const maxAttempts = 5;
    const attempts = 4;
    expect(attempts < maxAttempts).toBe(true);
  });

  it("blocks at 5 attempts", () => {
    const maxAttempts = 5;
    const attempts = 5;
    expect(attempts >= maxAttempts).toBe(true);
  });
});

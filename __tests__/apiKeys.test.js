import { extractApiKey, generateApiKey, hashApiKey } from "../src/lib/apiKeys.js";

const fakeReq = (headers) => ({
  get: (name) => headers[name.toLowerCase()],
});

describe("generateApiKey", () => {
  it("returns a prefixed key, a display prefix and its hash", () => {
    const { key, prefix, keyHash } = generateApiKey();

    expect(key).toMatch(/^kdx_[A-Za-z0-9_-]{32}$/);
    expect(key.startsWith(prefix)).toBe(true);
    expect(prefix).toHaveLength(12);
    expect(keyHash).toBe(hashApiKey(key));
  });

  it("generates unique keys", () => {
    const keys = new Set(Array.from({ length: 50 }, () => generateApiKey().key));
    expect(keys.size).toBe(50);
  });
});

describe("hashApiKey", () => {
  it("is deterministic and does not contain the raw key", () => {
    const hash = hashApiKey("kdx_secret");
    expect(hash).toBe(hashApiKey("kdx_secret"));
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain("secret");
  });
});

describe("extractApiKey", () => {
  it("reads a Bearer token", () => {
    expect(extractApiKey(fakeReq({ authorization: "Bearer kdx_abc" }))).toBe("kdx_abc");
  });

  it("reads the X-API-Key header", () => {
    expect(extractApiKey(fakeReq({ "x-api-key": " kdx_abc " }))).toBe("kdx_abc");
  });

  it("returns null when no key is sent", () => {
    expect(extractApiKey(fakeReq({}))).toBeNull();
    expect(extractApiKey(fakeReq({ authorization: "Bearer " }))).toBeNull();
    expect(extractApiKey(fakeReq({ authorization: "Basic abc" }))).toBeNull();
  });
});

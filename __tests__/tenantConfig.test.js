import { parseTenantConfig } from "../src/lib/tenantConfig.js";

describe("parseTenantConfig", () => {
  it("fills every default from an empty config", () => {
    const config = parseTenantConfig({});

    expect(config.systemPrompt).toEqual(expect.any(String));
    expect(config.fallbackAnswer).toEqual(expect.any(String));
    expect(config.audiences).toEqual([]);
    expect(config.retrieval).toEqual({ topK: 5, minScore: 0.3 });
  });

  it("treats null as an empty config", () => {
    expect(parseTenantConfig(null).retrieval.topK).toBe(5);
  });

  it("keeps overrides and fills missing nested defaults", () => {
    const config = parseTenantConfig({ audiences: ["brand"], retrieval: { topK: 8 } });

    expect(config.audiences).toEqual(["brand"]);
    expect(config.retrieval).toEqual({ topK: 8, minScore: 0.3 });
  });

  it("drops unknown keys", () => {
    expect(parseTenantConfig({ somethingElse: true })).not.toHaveProperty("somethingElse");
  });

  it("rejects invalid values", () => {
    expect(() => parseTenantConfig({ retrieval: { topK: 0 } })).toThrow();
    expect(() => parseTenantConfig({ retrieval: { minScore: 2 } })).toThrow();
  });
});

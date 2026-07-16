import { describe, it, expect } from "vitest";
import { classify } from "./waic-classify";

describe("WAIC Google result classification (regression)", () => {
  it("worldaic.com.cn → official_site / official / high", () => {
    const r = classify({
      title: "世界人工智能大会 WAIC",
      snippet: "上海",
      domain: "worldaic.com.cn",
    });
    expect(r.sourceType).toBe("official_site");
    expect(r.group).toBe("official");
    expect(r.officialConfidence).toBe("high");
    expect(r.entityMatch).toBe(true);
  });

  it("*.worldaic.com.cn → official_subdomain / official / medium", () => {
    const r = classify({
      title: "Participant Guide",
      snippet: "",
      domain: "waica2026.worldaic.com.cn",
    });
    expect(r.sourceType).toBe("official_subdomain");
    expect(r.group).toBe("official");
    expect(r.officialConfidence).toBe("medium");
  });

  it("waic.org (Western Association of Independent Camps) → unrelated / rejected", () => {
    const r = classify({
      title: "WAIC Conference Overview",
      snippet: "Western Association of Independent Camps annual meeting",
      domain: "waic.org",
    });
    expect(r.entityMatch).toBe(false);
    expect(r.sourceType).toBe("unrelated");
    expect(r.group).toBe("rejected");
    expect(r.officialConfidence).toBe("none");
  });

  it("Wikipedia WAIC page → encyclopedia / related", () => {
    const r = classify({
      title: "世界人工智能大会 - 维基百科",
      snippet: "World Artificial Intelligence Conference",
      domain: "zh.wikipedia.org",
    });
    expect(r.sourceType).toBe("encyclopedia");
    expect(r.group).toBe("related");
    expect(r.entityMatch).toBe(true);
    expect(r.officialConfidence).toBe("none");
  });

  it("unrelated look-alike domain without entity evidence → rejected", () => {
    const r = classify({
      title: "Welcome to WAIC",
      snippet: "some webflow test site",
      domain: "waic.webflow.io",
    });
    expect(r.entityMatch).toBe(false);
    expect(r.group).toBe("rejected");
    expect(r.sourceType).not.toBe("official_site");
    expect(r.sourceType).not.toBe("official_subdomain");
  });

  it("rejected entries never enter official or related", () => {
    const cases = [
      { title: "Camps", snippet: "Western Association of Independent Camps", domain: "waic.org" },
      { title: "x", snippet: "y", domain: "waic.webflow.io" },
      { title: "WAIC Camps", snippet: "summer jobs", domain: "waicsummercampjobs.com" },
    ];
    for (const c of cases) {
      const r = classify(c);
      expect(r.group).toBe("rejected");
    }
  });
});

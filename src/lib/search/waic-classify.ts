// Reference implementation of the WAIC Google-result entity/source classification
// used by the browser_eval snippet in src/routes/api/agent.ts.
// Keep this in sync with that snippet; regression tests in
// src/lib/search/waic-classify.test.ts guard the behavior.

export type SourceType =
  | "official_site"
  | "official_subdomain"
  | "government"
  | "education"
  | "media"
  | "encyclopedia"
  | "unrelated";

export type Confidence = "high" | "medium" | "none";

export interface EntityMatch {
  entityMatch: boolean;
  matchedEntity: string | null;
  entityEvidence: string;
}

export const targetEntities = [
  "世界人工智能大会",
  "world artificial intelligence conference",
  "world artificial intelligence",
  "上海人工智能",
  "shanghai artificial intelligence",
  "shanghai ai conference",
  "waic shanghai",
  "waic 上海",
];
export const officialDomains = ["worldaic.com.cn"];
export const disqualifyPhrases = ["western association of independent camps", "independent camps"];
const govTlds = [".gov", ".gov.cn", ".gob.", ".gouv.", ".go.jp", ".gov.uk"];
const eduTlds = [".edu", ".edu.cn", ".ac.uk", ".ac.jp"];
const encyclopediaDomains = [
  "baike.baidu.com",
  "zh.wikipedia.org",
  "en.wikipedia.org",
  "wikipedia.org",
  "baike.sogou.com",
  "zhidao.baidu.com",
  "wiki.mbalib.com",
];
const mediaDomains = [
  "sina.com",
  "sohu.com",
  "163.com",
  "qq.com",
  "xinhuanet.com",
  "people.com.cn",
  "chinadaily.com.cn",
  "nytimes.com",
  "bbc.com",
  "reuters.com",
];

export function matchEntity(title: string, snippet: string, domain: string): EntityMatch {
  const hay = (title + " " + snippet).toLowerCase();
  const dq = disqualifyPhrases.find((p) => hay.includes(p.toLowerCase()));
  if (dq)
    return {
      entityMatch: false,
      matchedEntity: null,
      entityEvidence: `disqualifying phrase in title/snippet: "${dq}"`,
    };
  const hit = targetEntities.find((e) => hay.includes(e.toLowerCase()));
  if (hit)
    return {
      entityMatch: true,
      matchedEntity: hit,
      entityEvidence: `title/snippet contains "${hit}"`,
    };
  const domHit = officialDomains.find((d) => domain === d || domain.endsWith("." + d));
  if (domHit)
    return {
      entityMatch: true,
      matchedEntity: domHit,
      entityEvidence: `domain is confirmed official (${domHit})`,
    };
  return {
    entityMatch: false,
    matchedEntity: null,
    entityEvidence:
      "no target-entity phrase in title/snippet; domain not in confirmed official list",
  };
}

export function classifySource(domain: string, entityMatch: boolean): SourceType {
  if (encyclopediaDomains.some((d) => domain === d || domain.endsWith("." + d)))
    return "encyclopedia";
  if (mediaDomains.some((d) => domain === d || domain.endsWith("." + d))) return "media";
  if (govTlds.some((t) => domain.includes(t))) return "government";
  if (eduTlds.some((t) => domain.includes(t))) return "education";
  if (!entityMatch) return "unrelated";
  if (officialDomains.some((d) => domain === d)) return "official_site";
  if (officialDomains.some((d) => domain.endsWith("." + d))) return "official_subdomain";
  return "unrelated";
}

export function confidenceFromSource(src: SourceType): Confidence {
  if (src === "official_site" || src === "government") return "high";
  if (src === "official_subdomain" || src === "education") return "medium";
  return "none";
}

export type Group = "official" | "related" | "rejected";

export function groupOf(entityMatch: boolean, src: SourceType): Group {
  if (!entityMatch) return "rejected";
  if (src === "official_site" || src === "official_subdomain") return "official";
  if (src === "media" || src === "encyclopedia" || src === "government" || src === "education")
    return "related";
  return "rejected";
}

export function classify(input: { title: string; snippet: string; domain: string }) {
  const em = matchEntity(input.title, input.snippet, input.domain);
  const sourceType = classifySource(input.domain, em.entityMatch);
  return {
    ...em,
    sourceType,
    officialConfidence: em.entityMatch ? confidenceFromSource(sourceType) : ("none" as Confidence),
    group: groupOf(em.entityMatch, sourceType),
  };
}

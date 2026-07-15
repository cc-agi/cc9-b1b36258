import { createServerFn } from "@tanstack/react-start";

export type ExternalModel = {
  id: string;
  owned_by?: string;
};

export const listExternalModels = createServerFn({ method: "GET" }).handler(
  async (): Promise<ExternalModel[]> => {
    const key = process.env.LLM_TOKEN_API_KEY;
    if (!key) throw new Error("Missing LLM_TOKEN_API_KEY");
    const res = await fetch("https://api.llm-token.cn/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`拉取模型列表失败 (${res.status}): ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as { data?: Array<{ id: string; owned_by?: string }> };
    const list = (json.data ?? [])
      .filter((m) => typeof m.id === "string")
      .map((m) => ({ id: m.id, owned_by: m.owned_by }));
    list.sort((a, b) => a.id.localeCompare(b.id));
    return list;
  },
);

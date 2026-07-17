import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export type ExternalModel = {
  id: string;
  owned_by?: string;
};

export type ModelProvider = "llm-token" | "minimax";

export const MODEL_PROVIDERS: Array<{
  id: ModelProvider;
  label: string;
  host: string;
}> = [
  { id: "llm-token", label: "LLM-TOKEN.CN", host: "api.llm-token.cn" },
  { id: "minimax", label: "MINIMAX-M23", host: "minimax-m23.wbzmt.cn" },
];

const PROVIDER_CONFIG: Record<ModelProvider, { baseURL: string; envKey: string }> = {
  "llm-token": {
    baseURL: "https://api.llm-token.cn/v1",
    envKey: "LLM_TOKEN_API_KEY",
  },
  minimax: {
    baseURL: "https://minimax-m23.wbzmt.cn/v1",
    envKey: "MINIMAX_API_KEY",
  },
};

export function getProviderConfig(p: ModelProvider) {
  return PROVIDER_CONFIG[p];
}

const InputSchema = z.object({ provider: z.enum(["llm-token", "minimax"]).optional() }).optional();

export const listExternalModels = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => InputSchema.parse(data))
  .handler(async ({ data }): Promise<ExternalModel[]> => {
    const provider: ModelProvider = data?.provider ?? "llm-token";
    const { baseURL, envKey } = PROVIDER_CONFIG[provider];
    const key = process.env[envKey];
    if (!key) throw new Error(`Missing ${envKey}`);
    const res = await fetch(`${baseURL}/models`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`拉取模型列表失败 (${res.status}): ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      data?: Array<{ id: string; owned_by?: string }>;
    };
    const list = (json.data ?? [])
      .filter((m) => typeof m.id === "string")
      .map((m) => ({ id: m.id, owned_by: m.owned_by }));
    list.sort((a, b) => a.id.localeCompare(b.id));
    return list;
  });

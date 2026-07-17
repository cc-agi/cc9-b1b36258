import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { rotateMcpConnectionCredential } from "@/lib/worker-pairing.functions";

/**
 * 供 rotation_required 的 MCP 连接重新输入凭据。
 * - URL / token 只提交到服务端，写入加密 Secret，不落地到明文列。
 * - 表单在关闭时立即清空 state。
 */
export function RotateCredentialDialog({
  connection,
  onClose,
}: {
  connection: { id: string; name: string };
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const fn = useServerFn(rotateMcpConnectionCredential);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");

  const mut = useMutation({
    mutationFn: () =>
      fn({
        data: {
          id: connection.id,
          url: url.trim(),
          auth_token: token.trim() || undefined,
        },
      }),
    onSuccess: () => {
      toast.success(`${connection.name} 的凭据已重新写入加密存储`);
      qc.invalidateQueries({ queryKey: ["mcp_connections"] });
      qc.invalidateQueries({ queryKey: ["release_readiness"] });
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "轮换失败"),
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="max-w-md w-[92%] p-5 rounded-lg border border-border bg-surface-1 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-3">
          <ShieldAlert className="w-4 h-4 text-warn" />
          <h4 className="text-sm font-semibold">重新输入凭据 · {connection.name}</h4>
        </div>
        <p className="text-[11px] text-muted-foreground leading-relaxed mb-3">
          输入完整 URL（可包含 API Key）；提交后仅写入服务端加密 Secret，
          <code className="font-mono">base_url</code> 列只保留去 query 的公开部分。
          输入框在关闭时会立刻清空。
        </p>
        <label className="block text-[11px] font-medium text-muted-foreground mb-1">
          完整 URL
        </label>
        <input
          type="url"
          autoComplete="off"
          spellCheck={false}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://api.example.com/mcp?key=sk_live_..."
          className="w-full px-2 py-1.5 rounded-md border border-border bg-surface-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-signal/40 mb-3"
        />
        <label className="block text-[11px] font-medium text-muted-foreground mb-1">
          可选 · Bearer Token
        </label>
        <input
          type="password"
          autoComplete="new-password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="仅在 URL 之外需要 Authorization: Bearer 时填写"
          className="w-full px-2 py-1.5 rounded-md border border-border bg-surface-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-signal/40 mb-4"
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-xs border border-border hover:bg-white/5 transition"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => mut.mutate()}
            disabled={mut.isPending || !url.trim()}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-signal/20 hover:bg-signal/30 text-signal border border-signal/40 transition disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {mut.isPending && <Loader2 className="w-3 h-3 animate-spin" />}
            保存到加密存储
          </button>
        </div>
      </div>
    </div>
  );
}

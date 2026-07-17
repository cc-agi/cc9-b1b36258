import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Folder,
  FileText,
  FileImage,
  File as FileIcon,
  ChevronUp,
  RefreshCw,
  Upload,
  FolderPlus,
  Trash2,
  Loader2,
  Download,
  AlertCircle,
  HardDrive,
} from "lucide-react";
import { toast } from "sonner";
import type { SelectedFile } from "./selected-file";

type Entry = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  mtime: number;
  kind: "dir" | "text" | "image" | "binary";
};

type ListResp = { path: string; parent: string; entries: Entry[] };

type Preview =
  | { status: "idle" }
  | { status: "loading"; path: string }
  | {
      status: "ok";
      path: string;
      encoding: "utf8" | "base64";
      kind: "text" | "image" | "binary";
      size: number;
      content: string;
    }
  | { status: "err"; path: string; message: string };

function formatSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function extOf(name: string) {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

function mimeFromExt(name: string) {
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
  };
  return map[extOf(name)] || "application/octet-stream";
}

export function FileBrowser({
  helperBase,
  onSelect,
  selectedPath,
}: {
  helperBase: string;
  onSelect?: (file: SelectedFile | null) => void;
  selectedPath?: string | null;
}) {
  const base = useMemo(() => helperBase.replace(/\/+$/, ""), [helperBase]);
  const [roots, setRoots] = useState<string[]>([]);
  const [cwd, setCwd] = useState<string>("");
  const [list, setList] = useState<ListResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview>({ status: "idle" });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const callJson = useCallback(
    async <T,>(path: string, body?: unknown, method: "GET" | "POST" = "POST"): Promise<T> => {
      const resp = await fetch(`${base}${path}`, {
        method,
        headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
        body: method === "POST" ? JSON.stringify(body || {}) : undefined,
      });
      if (!resp.ok) {
        const t = await resp.text().catch(() => "");
        throw new Error(t || `${resp.status} ${resp.statusText}`);
      }
      return (await resp.json()) as T;
    },
    [base],
  );

  const loadRoots = useCallback(async () => {
    try {
      const r = await callJson<{ roots: { path: string }[] }>("/fs/roots", undefined, "GET");
      const paths = r.roots.map((x) => x.path);
      setRoots(paths);
      if (!cwd && paths[0]) setCwd(paths[0]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [callJson, cwd]);

  const loadList = useCallback(
    async (target: string) => {
      setLoading(true);
      setError(null);
      try {
        const r = await callJson<ListResp>("/fs/list", { path: target });
        setList(r);
        setCwd(r.path);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [callJson],
  );

  useEffect(() => {
    loadRoots();
  }, [loadRoots]);

  useEffect(() => {
    if (cwd) loadList(cwd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  const openEntry = useCallback(
    async (entry: Entry) => {
      if (entry.isDirectory) {
        setCwd(entry.path);
        return;
      }
      setPreview({ status: "loading", path: entry.path });
      try {
        const r = await callJson<{
          encoding: "utf8" | "base64";
          kind: "text" | "image" | "binary";
          size: number;
          content: string;
        }>("/fs/read", { path: entry.path });
        setPreview({ status: "ok", path: entry.path, ...r });
        onSelect?.({
          path: entry.path,
          name: entry.name,
          kind: r.kind,
          encoding: r.encoding,
          size: r.size,
          content: r.content,
        });
      } catch (e) {
        setPreview({
          status: "err",
          path: entry.path,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [callJson, onSelect],
  );

  const goUp = useCallback(() => {
    if (list?.parent && list.parent !== list.path) setCwd(list.parent);
  }, [list]);

  const onUpload = useCallback(
    async (files: FileList | null) => {
      if (!files || !cwd) return;
      for (const f of Array.from(files)) {
        try {
          const buf = await f.arrayBuffer();
          const b64 = btoa(new Uint8Array(buf).reduce((s, b) => s + String.fromCharCode(b), ""));
          await callJson("/fs/write", {
            path: `${cwd.replace(/[/\\]+$/, "")}/${f.name}`,
            encoding: "base64",
            content: b64,
          });
          toast.success(`已上传 ${f.name}`);
        } catch (e) {
          toast.error(`上传 ${f.name} 失败：${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (fileInputRef.current) fileInputRef.current.value = "";
      loadList(cwd);
    },
    [callJson, cwd, loadList],
  );

  const onMkdir = useCallback(async () => {
    const name = window.prompt("新建文件夹名称");
    if (!name) return;
    try {
      await callJson("/fs/mkdir", {
        path: `${cwd.replace(/[/\\]+$/, "")}/${name}`,
      });
      toast.success(`已创建 ${name}`);
      loadList(cwd);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, [callJson, cwd, loadList]);

  const onDelete = useCallback(
    async (entry: Entry) => {
      if (!window.confirm(`确定删除 ${entry.name}?`)) return;
      try {
        await callJson("/fs/delete", { path: entry.path });
        toast.success(`已删除 ${entry.name}`);
        if (preview.status === "ok" && preview.path === entry.path) {
          setPreview({ status: "idle" });
          onSelect?.(null);
        }
        if (selectedPath === entry.path) onSelect?.(null);
        loadList(cwd);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    },
    [callJson, cwd, loadList, preview, onSelect, selectedPath],
  );

  const downloadPreview = useCallback(() => {
    if (preview.status !== "ok") return;
    const name = preview.path.split(/[/\\]/).pop() || "download";
    const blob =
      preview.encoding === "base64"
        ? (() => {
            const bin = atob(preview.content);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            return new Blob([bytes], { type: mimeFromExt(name) });
          })()
        : new Blob([preview.content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }, [preview]);

  return (
    <div className="rounded-lg border border-border bg-surface-2/60 p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <HardDrive className="w-4 h-4 text-muted-foreground shrink-0" />
          <span className="text-sm font-medium">本地文件</span>
          <span className="text-[11px] text-muted-foreground truncate">{cwd || "未连接"}</span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => cwd && loadList(cwd)}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={goUp} disabled={!list}>
            <ChevronUp className="w-3.5 h-3.5" />
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onMkdir} disabled={!cwd}>
            <FolderPlus className="w-3.5 h-3.5" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => fileInputRef.current?.click()}
            disabled={!cwd}
          >
            <Upload className="w-3.5 h-3.5" />
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => onUpload(e.target.files)}
          />
        </div>
      </div>

      {/* Root shortcuts */}
      {roots.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {roots.map((r) => (
            <Button
              key={r}
              type="button"
              size="sm"
              variant={r === cwd ? "secondary" : "outline"}
              className="h-6 px-2 text-[11px] font-mono"
              onClick={() => setCwd(r)}
            >
              {r}
            </Button>
          ))}
        </div>
      )}

      {/* Path input */}
      <div className="flex gap-2">
        <Input
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") loadList(cwd);
          }}
          placeholder="/absolute/path"
          className="h-8 text-xs font-mono"
        />
      </div>

      {error && (
        <div className="flex items-start gap-2 text-xs text-destructive">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* Directory listing */}
        <div className="rounded border border-border bg-background/40 h-64 overflow-auto">
          {list?.entries.length === 0 && (
            <div className="p-3 text-xs text-muted-foreground">空目录</div>
          )}
          <ul className="divide-y divide-border">
            {list?.entries.map((e) => {
              const Icon = e.isDirectory
                ? Folder
                : e.kind === "image"
                  ? FileImage
                  : e.kind === "text"
                    ? FileText
                    : FileIcon;
              return (
                <li
                  key={e.path}
                  className={`flex items-center gap-2 px-2 py-1.5 hover:bg-surface-2/60 cursor-pointer group ${
                    selectedPath === e.path ? "bg-signal/10 ring-1 ring-inset ring-signal/40" : ""
                  }`}
                  onClick={() => openEntry(e)}
                >
                  <Icon
                    className={`w-3.5 h-3.5 shrink-0 ${
                      e.isDirectory ? "text-amber-400" : "text-muted-foreground"
                    }`}
                  />
                  <span className="text-xs truncate flex-1">{e.name}</span>
                  <span className="text-[10px] text-muted-foreground shrink-0">
                    {e.isDirectory ? "" : formatSize(e.size)}
                  </span>
                  <button
                    type="button"
                    className="opacity-0 group-hover:opacity-100 text-destructive"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      onDelete(e);
                    }}
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Preview */}
        <div className="rounded border border-border bg-background/40 h-64 overflow-auto">
          {preview.status === "idle" && (
            <div className="p-3 text-xs text-muted-foreground">
              点击左侧文件预览。文本/图片直接渲染，二进制以 Base64 展示。
            </div>
          )}
          {preview.status === "loading" && (
            <div className="p-3 text-xs text-muted-foreground flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> 读取中…
            </div>
          )}
          {preview.status === "err" && (
            <div className="p-3 text-xs text-destructive flex items-start gap-2">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{preview.message}</span>
            </div>
          )}
          {preview.status === "ok" && (
            <div className="p-2 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-muted-foreground truncate">
                  {preview.path} · {formatSize(preview.size)}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2"
                  onClick={downloadPreview}
                >
                  <Download className="w-3 h-3 mr-1" /> 下载
                </Button>
              </div>
              {preview.kind === "image" ? (
                <img
                  src={`data:${mimeFromExt(preview.path)};base64,${preview.content}`}
                  alt={preview.path}
                  className="max-w-full max-h-48 object-contain mx-auto"
                />
              ) : preview.kind === "text" ? (
                <pre className="text-[11px] font-mono whitespace-pre-wrap break-all bg-surface-2/40 p-2 rounded max-h-48 overflow-auto">
                  {preview.content}
                </pre>
              ) : (
                <pre className="text-[11px] font-mono whitespace-pre-wrap break-all bg-surface-2/40 p-2 rounded max-h-48 overflow-auto text-muted-foreground">
                  {preview.content.slice(0, 4000)}
                  {preview.content.length > 4000 ? "\n…(截断)" : ""}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export type SelectedFile = {
  path: string;
  name: string;
  kind: "text" | "image" | "binary";
  encoding: "utf8" | "base64";
  size: number;
  /** Raw content (utf8 text or base64 binary/image) */
  content: string;
};

/** Replace {{file.*}} tokens in a step field with values from the selected file. */
export function interpolateSelectedFile(input: string | undefined, f: SelectedFile | null): string {
  const s = input ?? "";
  if (!s || !f) return s;
  const dir = f.path.replace(/[/\\][^/\\]+$/, "");
  const normalized = f.path.replace(/\\/g, "/");
  const url = "file://" + (normalized.startsWith("/") ? normalized : "/" + normalized);
  return s
    .replace(/\{\{\s*file\.path\s*\}\}/g, f.path)
    .replace(/\{\{\s*file\.name\s*\}\}/g, f.name)
    .replace(/\{\{\s*file\.dir\s*\}\}/g, dir)
    .replace(/\{\{\s*file\.url\s*\}\}/g, url)
    .replace(/\{\{\s*file\.content\s*\}\}/g, f.kind === "text" ? f.content : "");
}

export const FILE_TOKENS: Array<{ token: string; hint: string }> = [
  { token: "{{file.path}}", hint: "绝对路径" },
  { token: "{{file.name}}", hint: "文件名" },
  { token: "{{file.dir}}", hint: "所在目录" },
  { token: "{{file.url}}", hint: "file:// URL" },
  { token: "{{file.content}}", hint: "文本内容（仅文本）" },
];

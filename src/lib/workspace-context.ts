/**
 * Workspace-as-context store.
 *
 * The workspace is a scope for the model: when enabled, we read text files
 * from the selected folder (local upload or Lovable Cloud bucket) and
 * inject them into every chat send as a bounded context block. The model
 * is instructed to stay within this scope.
 *
 * The store is module-level so the WorkspaceSelector (writer) and the
 * ConsolePage's handleSend (reader) can share state without threading a
 * React context through the whole page tree.
 */

import { useSyncExternalStore } from "react";

export type WorkspaceFile = {
  path: string;
  content: string;
  bytes: number;
};

export type WorkspaceContextSnapshot = {
  enabled: boolean;
  workspaceId: string | null;
  workspaceName: string | null;
  kind: "local" | "cloud" | null;
  files: WorkspaceFile[];
  totalBytes: number;
  skipped: string[]; // files skipped because of type or budget
  updatedAt: number;
};

const EMPTY: WorkspaceContextSnapshot = {
  enabled: false,
  workspaceId: null,
  workspaceName: null,
  kind: null,
  files: [],
  totalBytes: 0,
  skipped: [],
  updatedAt: 0,
};

let snapshot: WorkspaceContextSnapshot = EMPTY;
const listeners = new Set<() => void>();

export function getWorkspaceContext(): WorkspaceContextSnapshot {
  return snapshot;
}

export function setWorkspaceContext(next: WorkspaceContextSnapshot) {
  snapshot = next;
  for (const l of listeners) l();
}

export function clearWorkspaceContext() {
  setWorkspaceContext(EMPTY);
}

export function subscribeWorkspaceContext(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useWorkspaceContext(): WorkspaceContextSnapshot {
  return useSyncExternalStore(
    subscribeWorkspaceContext,
    getWorkspaceContext,
    getWorkspaceContext,
  );
}

/* ---------------- helpers ---------------- */

// Total bytes we're willing to inject into a single prompt.
export const WS_CONTEXT_BUDGET = 120 * 1024; // 120 KB

const TEXT_EXT = new Set([
  "md", "mdx", "markdown", "txt", "rst",
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "json", "yaml", "yml", "toml", "ini", "env",
  "html", "htm", "css", "scss", "sass", "less",
  "py", "rb", "go", "rs", "java", "kt", "swift",
  "c", "h", "cpp", "hpp", "cc", "cs",
  "sh", "bash", "zsh", "ps1", "bat",
  "sql", "graphql", "gql", "proto",
  "csv", "tsv", "xml", "svg", "log",
  "vue", "svelte", "astro",
]);

export function isTextFile(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return TEXT_EXT.has(name.slice(dot + 1).toLowerCase());
}

/** Read text files from an in-memory folder-upload snapshot, bounded. */
export async function collectLocalFolderContext(
  files: File[],
  folderName: string,
  budget = WS_CONTEXT_BUDGET,
): Promise<{ files: WorkspaceFile[]; skipped: string[]; totalBytes: number }> {
  const out: WorkspaceFile[] = [];
  const skipped: string[] = [];
  let used = 0;

  // Prefer smaller files first so the budget covers as many as possible.
  const sorted = [...files].sort((a, b) => a.size - b.size);

  for (const f of sorted) {
    const rel = f.webkitRelativePath || f.name;
    const strippedPath =
      rel.startsWith(`${folderName}/`) ? rel.slice(folderName.length + 1) : rel;
    if (!isTextFile(f.name)) {
      skipped.push(strippedPath);
      continue;
    }
    if (used + f.size > budget) {
      skipped.push(strippedPath);
      continue;
    }
    try {
      const content = await f.text();
      out.push({ path: strippedPath, content, bytes: f.size });
      used += f.size;
    } catch {
      skipped.push(strippedPath);
    }
  }
  return { files: out, skipped, totalBytes: used };
}

/**
 * Fetch text files from Lovable Cloud storage via signed URLs.
 * `signDownload` is a wrapper around `createCloudSignedDownloadUrl`.
 */
export async function collectCloudFolderContext(
  names: string[],
  signDownload: (name: string) => Promise<{ signedUrl: string }>,
  sizes: Record<string, number> = {},
  budget = WS_CONTEXT_BUDGET,
): Promise<{ files: WorkspaceFile[]; skipped: string[]; totalBytes: number }> {
  const out: WorkspaceFile[] = [];
  const skipped: string[] = [];
  let used = 0;

  const textNames = names.filter((n) => isTextFile(n));
  const sorted = textNames.sort((a, b) => (sizes[a] ?? 0) - (sizes[b] ?? 0));

  for (const name of sorted) {
    const guess = sizes[name] ?? 0;
    if (guess && used + guess > budget) {
      skipped.push(name);
      continue;
    }
    try {
      const { signedUrl } = await signDownload(name);
      const res = await fetch(signedUrl);
      if (!res.ok) {
        skipped.push(name);
        continue;
      }
      const text = await res.text();
      const bytes = new Blob([text]).size;
      if (used + bytes > budget) {
        skipped.push(name);
        continue;
      }
      out.push({ path: name, content: text, bytes });
      used += bytes;
    } catch {
      skipped.push(name);
    }
  }
  for (const n of names) if (!isTextFile(n) && !skipped.includes(n)) skipped.push(n);
  return { files: out, skipped, totalBytes: used };
}

/** Compose the prompt preamble that gets prepended to the user's message. */
export function buildContextPreamble(snap: WorkspaceContextSnapshot): string {
  if (!snap.enabled || snap.files.length === 0) return "";
  const header =
    `【工作区上下文 · ${snap.workspaceName ?? "workspace"}】\n` +
    `作用范围规则:接下来的回答只能基于以下 ${snap.files.length} 个文件的内容进行分析、优化或创作。\n` +
    `- 不得引用工作区之外的文件或来源。\n` +
    `- 若用户需要引用其它内容,请先明确要求用户提供。\n` +
    `- 生成的新内容必须与这些文件所属的项目/上下文保持一致。\n`;

  const body = snap.files
    .map(
      (f) =>
        `\n===== FILE: ${f.path} =====\n${f.content.slice(0, 40_000)}\n===== END: ${f.path} =====`,
    )
    .join("\n");

  const skipNote = snap.skipped.length
    ? `\n\n(已省略 ${snap.skipped.length} 个非文本或超出预算的文件)`
    : "";

  return `${header}${body}${skipNote}\n\n---\n用户请求:\n`;
}

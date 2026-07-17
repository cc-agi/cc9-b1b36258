/**
 * Sentinel runtime error catalog (P0-R3).
 * Every error code that can surface in agent_runs.error_code, worker_heartbeats.last_error_code,
 * or diagnostics has a machine-readable code + Chinese explanation + suggested action.
 *
 * Used by:
 *   - WorkerPairingPanel (显示错误 + 修复建议)
 *   - diagnostics.functions.ts (一键诊断返回)
 *   - orchestrator.server.ts (可选：blocked/failed 时挑一个 code)
 */
export type SentinelErrorEntry = {
  code: string;
  title: string; // 简短的中文标题
  detail: string; // 更详细的中文解释
  action: string; // 用户可以做什么
  severity: "info" | "warn" | "error";
};

export const SENTINEL_ERRORS = {
  // -------- Worker / Helper --------
  WORKER_OFFLINE: {
    code: "WORKER_OFFLINE",
    title: "Helper 未在线",
    detail: "本地 Sentinel Helper 最近 10 秒内没有心跳。任务不会执行。",
    action: "在 Windows 上运行 start-sentinel.bat 启动 Helper，然后重试任务。",
    severity: "warn",
  },
  WORKER_OFFLINE_TIMEOUT: {
    code: "WORKER_OFFLINE_TIMEOUT",
    title: "长时间无 Helper 认领",
    detail: "任务已在队列中超过 5 分钟仍未被任何 Helper 认领，已自动标记为 blocked。",
    action: "启动 Helper 后使用「重试任务」。",
    severity: "warn",
  },
  LEASE_EXPIRED: {
    code: "LEASE_EXPIRED",
    title: "Helper 心跳丢失 / 租约过期",
    detail: "Worker 领取任务后停止发送心跳，或租约过期。副作用未知，任务已标记 timed_out。",
    action: "先检查 Helper 是否崩溃（diagnose-sentinel.bat），确认后可选择重试。",
    severity: "error",
  },
  NO_PROGRESS_TIMEOUT: {
    code: "NO_PROGRESS_TIMEOUT",
    title: "任务停止推进",
    detail: "任务在 running 状态下 3 分钟没有任何新事件，视为卡死并标记为 timed_out。",
    action: "查看事件日志找出最后一个步骤，必要时使用 repair-sentinel.bat 重启浏览器再重试。",
    severity: "error",
  },
  HELPER_TOO_OLD: {
    code: "HELPER_TOO_OLD",
    title: "Helper 版本过低",
    detail: "本地 Helper 低于当前要求的最低版本，无法认领任务。",
    action: "运行 helper\\install-helper.ps1 更新 Helper，然后重新配对。",
    severity: "warn",
  },

  // -------- Chrome / CDP --------
  CDP_UNREACHABLE: {
    code: "CDP_UNREACHABLE",
    title: "Chrome 调试端口不可达",
    detail: "127.0.0.1:9222 拒绝连接。可能 Chrome 未启动，或未开启 --remote-debugging-port。",
    action: "运行 repair-sentinel.bat；它会重新以受控参数启动专用 Chrome。",
    severity: "error",
  },
  CDP_CONNECT_TIMEOUT: {
    code: "CDP_CONNECT_TIMEOUT",
    title: "连接 Chrome 超时",
    detail: "CDP 端口回应缓慢或无响应，通常是 Chrome 未完全就绪或被防火墙拦截。",
    action: "等待几秒再重试；仍失败则运行 repair-sentinel.bat。",
    severity: "warn",
  },

  // -------- Browser tools --------
  CLICK_DENIED_KEYWORD: {
    code: "CLICK_DENIED_KEYWORD",
    title: "点击被安全策略拦截",
    detail: "目标元素文本包含高风险关键词（提交/支付/删除等），Sentinel 只做只读浏览，不会自动执行。",
    action: "调整任务目标，改为只读浏览或人工确认后再执行。",
    severity: "info",
  },
  CLICK_NOT_FOUND: {
    code: "CLICK_NOT_FOUND",
    title: "点击目标不存在",
    detail: "选择器在当前页面找不到匹配元素。可能页面还没加载完成，或结构已变化。",
    action: "让任务先执行 browser_wait_for，或直接用 browser_inspect_candidates 观察。",
    severity: "info",
  },
  CLICK_NOT_NAVIGATIONAL: {
    code: "CLICK_NOT_NAVIGATIONAL",
    title: "拒绝非导航点击",
    detail: "目标不是导航元素（表单提交按钮、非 <a> 非 role=link/tab 元素等），已拒绝。",
    action: "改用 browser_goto 或点击真正的导航链接。",
    severity: "info",
  },
  TOOL_NOT_WHITELISTED: {
    code: "TOOL_NOT_WHITELISTED",
    title: "工具未在白名单",
    detail: "Orchestrator 或 Helper 拒绝执行非只读工具。",
    action: "该操作已被安全边界阻止，不需要修复。",
    severity: "info",
  },
  HELPER_EXCEPTION: {
    code: "HELPER_EXCEPTION",
    title: "Helper 执行时抛出异常",
    detail: "Helper 在执行浏览器工具时未捕获错误。",
    action: "查看 helper.log；必要时 repair-sentinel.bat 后重试。",
    severity: "error",
  },
  HELPER_STEP_CAP: {
    code: "HELPER_STEP_CAP",
    title: "达到单轮执行上限",
    detail: "Helper 单次任务循环达到 40 步安全上限。",
    action: "缩小任务范围，或分成多个更小的任务。",
    severity: "warn",
  },

  // -------- Orchestrator --------
  MODEL_UNAVAILABLE: {
    code: "MODEL_UNAVAILABLE",
    title: "AI 模型暂不可用",
    detail: "Lovable AI Gateway 未返回结果。",
    action: "稍后重试；持续失败请联系管理员。",
    severity: "error",
  },
  OWNER_CANCELLED: {
    code: "OWNER_CANCELLED",
    title: "任务已被取消",
    detail: "Owner 手动取消了该任务。",
    action: "如需继续，请重新创建任务。",
    severity: "info",
  },
} as const satisfies Record<string, SentinelErrorEntry>;

export type SentinelErrorCode = keyof typeof SENTINEL_ERRORS;

export function explainError(
  code: string | null | undefined,
): SentinelErrorEntry | { code: string; title: string; detail: string; action: string; severity: "warn" } {
  if (!code) return { code: "UNKNOWN", title: "未知错误", detail: "", action: "", severity: "warn" };
  const known = (SENTINEL_ERRORS as Record<string, SentinelErrorEntry>)[code];
  if (known) return known;
  return {
    code,
    title: code,
    detail: "未登记的错误码；请查看事件日志了解上下文。",
    action: "查看 helper.log 与 agent_events；必要时运行 diagnose-sentinel.bat。",
    severity: "warn",
  };
}

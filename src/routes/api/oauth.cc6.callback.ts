import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/oauth/cc6/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const err = url.searchParams.get("error");

        if (err) return html(400, `<p>OAuth error: ${escapeHtml(err)}</p>`);
        if (!code || !state) return html(400, `<p>Missing code / state</p>`);

        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { decryptJson } = await import("@/lib/mcp/crypto.server");
          const { exchangeCode } = await import("@/lib/mcp/oauth.server");
          const { saveConnection } = await import("@/lib/mcp/connections.server");
          const { clearSession } = await import("@/lib/mcp/rpc.server");
          const { CC6 } = await import("@/lib/mcp/config");

          const { data: pending, error: pErr } = await supabaseAdmin
            .from("mcp_oauth_pending")
            .select("*")
            .eq("state", state)
            .maybeSingle();
          if (pErr) throw pErr;
          if (!pending) return html(400, `<p>Unknown or expired state</p>`);

          const ageMs = Date.now() - new Date(pending.created_at).getTime();
          if (ageMs > 10 * 60 * 1000) {
            await supabaseAdmin.from("mcp_oauth_pending").delete().eq("state", state);
            return html(400, `<p>Authorization request expired. Please try again.</p>`);
          }

          const client = decryptJson<{
            client_id: string;
            client_secret?: string;
            redirect_uris: string[];
          }>(pending.client_registration_ciphertext);

          const tokens = await exchangeCode({
            client,
            code,
            redirectUri: pending.redirect_uri,
            codeVerifier: pending.code_verifier,
          });

          await saveConnection({ userId: pending.user_id, client, tokens });
          await supabaseAdmin.from("mcp_oauth_pending").delete().eq("state", state);
          clearSession(pending.user_id);

          return html(
            200,
            `<p>Connected to ${escapeHtml(CC6.name)}. You can close this window.</p>
             <script>
               try { window.opener && window.opener.postMessage({ type: "cc6-connected" }, "*"); } catch (e) {}
               setTimeout(function () { window.close(); }, 400);
             </script>`,
          );
        } catch (e) {
          return html(
            500,
            `<p>Failed to complete OAuth: ${escapeHtml(String((e as Error).message))}</p>`,
          );
        }
      },
    },
  },
});

function html(status: number, body: string): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>cc6 OAuth</title>
     <style>body{font-family:system-ui;padding:24px;background:#0a0a0a;color:#e6e6e6}</style>
     </head><body>${body}</body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c,
  );
}

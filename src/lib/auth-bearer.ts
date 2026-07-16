import { createMiddleware } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";

/**
 * Project-specific bearer attacher. Replaces the generated `attachSupabaseAuth`
 * because we want to:
 *
 * 1. Avoid firing a tokenless RPC when the client has no session — the server
 *    would 401 with `Unauthorized: No authorization header provided` and
 *    surface as a blank RUNTIME_ERROR page.
 * 2. Redirect to /auth immediately so the UX matches what `_authenticated`
 *    would have done, instead of leaving the user on a broken screen.
 */
export const attachBearerOrRedirect = createMiddleware({ type: "function" }).client(
  async ({ next }) => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;

    if (!token) {
      // No session — abort the RPC and send the user to sign-in.
      if (typeof window !== "undefined" && window.location.pathname !== "/auth") {
        window.location.replace("/auth");
      }
      throw new Error("未登录，正在跳转到登录页…");
    }

    return next({
      headers: { Authorization: `Bearer ${token}` },
    });
  },
);

// /apps/hajirai/signed-in (through the app proxy): where Shopify's sign-in
// lands when the chat opened it. See app/lib/signed-in-page.js.
import { signedInPage } from "../lib/signed-in-page.js";

export const loader = async ({ request }) => {
  const back = new URL(request.url).searchParams.get("back") || "/";
  return new Response(signedInPage(back), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" },
  });
};

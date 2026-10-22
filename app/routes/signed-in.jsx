// /apps/hajirai/signed-in (through the app proxy): where Shopify's sign-in
// lands when the chat opened it. See app/lib/signed-in-page.js.
import { authenticate } from "../shopify.server";
import { signedInPage } from "../lib/signed-in-page.js";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  // ?check=1: is this browser signed in to the store now? (The chat asks when
  // the shopper comes back from the sign-in window.) Only the app proxy's
  // signed customer id counts.
  if (url.searchParams.get("check")) {
    let signedIn = false;
    try {
      const { session } = await authenticate.public.appProxy(request);
      signedIn = Boolean(session && url.searchParams.get("logged_in_customer_id"));
    } catch (e) {
      if (e instanceof Response) signedIn = false;
    }
    return Response.json({ signedIn }, { headers: { "Cache-Control": "private, no-store" } });
  }
  const back = url.searchParams.get("back") || "/";
  return new Response(signedInPage(back), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" },
  });
};

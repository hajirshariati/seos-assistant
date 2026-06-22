import { forwardRef } from "react";
import { Link, Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider as ShopifyAppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import { Box, Text } from "@shopify/polaris";
import { NavMenu } from "@shopify/app-bridge-react";
import enTranslations from "@shopify/polaris/locales/en.json";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { authenticate } from "../shopify.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

// Polaris components that take a `url` prop (Button, Banner action, ActionList,
// …) render plain <a href>. Inside the embedded admin iframe a full-page
// navigation drops the App Bridge session token, so the next request hits
// authenticate.admin() with no session and bounces to the OAuth login page.
// Routing in-app paths through react-router's Link keeps the navigation
// client-side and preserves the session.
const PolarisLink = forwardRef(function PolarisLink(
  { children, url = "", external, target, download, ...rest },
  ref,
) {
  const isProtocolUrl = /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(url);
  // mailto:/tel:/sms: must escape the iframe so the OS handler runs —
  // top-level navigation to those schemes is blocked by Shopify's frame policy.
  const isHandoffScheme = /^(mailto|tel|sms):/i.test(url);
  if (external || download || isProtocolUrl) {
    const newTab = external || isHandoffScheme;
    return (
      <a
        ref={ref}
        href={url}
        target={newTab ? "_blank" : target}
        rel={newTab ? "noopener noreferrer" : undefined}
        download={download}
        {...rest}
      >
        {children}
      </a>
    );
  }
  return (
    <Link ref={ref} to={url} {...rest}>
      {children}
    </Link>
  );
});

export default function App() {
  const { apiKey } = useLoaderData();
  return (
    <ShopifyAppProvider isEmbeddedApp apiKey={apiKey}>
      <PolarisAppProvider i18n={enTranslations} linkComponent={PolarisLink}>
        {/* SEoS design language over Polaris — one theme layer in the parent
            layout so every subpage matches the home/analytics design without
            rewriting each page: brand-green fills and focus rings, hairline
            16px cards, pill buttons, softened inputs. Token overrides win
            because this inline style renders after the Polaris stylesheet. */}
        <style>{`
          :root {
            --p-color-bg-fill-brand: #2D6B4F;
            --p-color-bg-fill-brand-hover: #34795b;
            --p-color-bg-fill-brand-active: #275e45;
            --p-color-bg-fill-brand-selected: #2D6B4F;
            --p-color-bg-fill-brand-disabled: rgba(45,107,79,0.4);
            --p-color-border-focus: rgba(45,107,79,0.8);
            --p-color-text-link: #2D6B4F;
            --p-color-text-link-hover: #245741;
            --p-color-icon-emphasis: #2D6B4F;
            --p-color-border-emphasis: #2D6B4F;
            --p-color-bg-surface-selected: rgba(45,107,79,0.08);
          }
          /* Cards — white sheet, 16px radius, hairline + soft shadow,
             matching .seos-card on the home page. */
          .Polaris-ShadowBevel,
          .Polaris-ShadowBevel::before {
            border-radius: 16px !important;
          }
          .Polaris-ShadowBevel::before {
            box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 0 0 1px rgba(0,0,0,0.07) !important;
          }
          /* Headings carry the brand ink color. */
          .Polaris-Text--headingXs, .Polaris-Text--headingSm, .Polaris-Text--headingMd,
          .Polaris-Text--headingLg, .Polaris-Text--headingXl, .Polaris-Text--heading2xl {
            color: #1a2e26;
          }
          /* Buttons — pill silhouettes like the home CTAs. Segmented
             groups keep their compact joined radius. */
          .Polaris-Button {
            border-radius: 999px !important;
          }
          .Polaris-ButtonGroup--variantSegmented .Polaris-Button {
            border-radius: 8px !important;
          }
          .Polaris-Button--variantPrimary:not(.Polaris-Button--toneCritical) {
            background: linear-gradient(180deg, #34795b, #2D6B4F);
            box-shadow: 0 1px 2px rgba(26,46,38,0.28), inset 0 1px 0 rgba(255,255,255,0.12);
          }
          .Polaris-Button--variantPrimary:not(.Polaris-Button--toneCritical):hover {
            background: linear-gradient(180deg, #3a8a66, #2f7053);
          }
          /* Inputs — softer 10px corners. */
          .Polaris-TextField__Backdrop,
          .Polaris-Select__Backdrop,
          .Polaris-DropZone {
            border-radius: 10px !important;
          }
          .Polaris-Badge { border-radius: 999px; }
          .Polaris-Banner--withinPage { border-radius: 14px; }
          /* Filled status banners (success / critical / info) sit on a
             saturated background — their title, body text and icons must stay
             white. The brand heading-ink rule above otherwise renders the
             banner title near-black, which is unreadable on the green/red fill. */
          .Polaris-Banner--textSuccessOnBgFill .Polaris-Text--root,
          .Polaris-Banner--textCriticalOnBgFill .Polaris-Text--root,
          .Polaris-Banner--textInfoOnBgFill .Polaris-Text--root,
          .Polaris-Banner--textSuccessOnBgFill *,
          .Polaris-Banner--textCriticalOnBgFill *,
          .Polaris-Banner--textInfoOnBgFill * { color: #fff !important; }
          .Polaris-Banner--textSuccessOnBgFill svg, .Polaris-Banner--textSuccessOnBgFill path,
          .Polaris-Banner--textCriticalOnBgFill svg, .Polaris-Banner--textCriticalOnBgFill path,
          .Polaris-Banner--textInfoOnBgFill svg, .Polaris-Banner--textInfoOnBgFill path { fill: #fff !important; }
                  /* ── Mobile responsiveness (admin) ── */
          @media (max-width: 768px) {
            .Polaris-Page { padding-left: 14px !important; padding-right: 14px !important; overflow-x: clip; }
            .dd, .dx, .settings { overflow-wrap: anywhere; word-break: break-word; }
            .dd .rmeta { white-space: normal !important; flex-wrap: wrap !important; row-gap: 4px; }
            .dd .cbmsg { white-space: normal !important; }
            .seos-card-grid { grid-template-columns: 1fr !important; }
            .dd .cols, .dd .two { grid-template-columns: 1fr !important; }
            .seos-pagefoot { gap: 8px 14px !important; }
            .seos-pagefoot-value { white-space: normal !important; }
            .seos-testchat { width: 100% !important; }
          }
      `}</style>
        <NavMenu>
          <Link to="/app" rel="home">SEoS Assistant</Link>
          <Link to="/app/rules">Rules</Link>
          <Link to="/app/knowledge">Knowledge</Link>
          <Link to="/app/catalog">Catalog</Link>
          <Link to="/app/recommenders">Smart Recommenders</Link>
          <Link to="/app/analytics">Analytics</Link>
          <Link to="/app/api-keys">Settings</Link>
        </NavMenu>
        <Outlet />
        <div
          style={{
            marginTop: "40px",
            padding: "18px 16px 22px",
            textAlign: "center",
            borderTop: "1px solid rgba(0,0,0,0.07)",
          }}
        >
          <Text as="p" tone="subdued" variant="bodySm" alignment="center">
            SEoS Assistant by Aetrex Technology ·{" "}
            <a
              href="/privacy"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "inherit", textDecoration: "underline", textUnderlineOffset: "2px" }}
            >
              Privacy policy
            </a>
          </Text>
        </div>
      </PolarisAppProvider>
    </ShopifyAppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};

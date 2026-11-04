// Stand-in for @shopify/app-bridge-react in the admin preview: no title bar,
// no App Bridge; toasts and id tokens are no-ops.
export function TitleBar() { return null; }
export function NavMenu() { return null; }
export function useAppBridge() {
  return { idToken: async () => "preview", toast: { show() {} } };
}

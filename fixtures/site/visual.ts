import { layout } from "./html.ts";
import type { Response, Route } from "./pages.ts";

/**
 * A page whose bug only shows in the picture: a badge covers a button's label. No other oracle sees it; the DOM is
 * fine. Neither the home page nor the lab links here, so other runs never reach it; tests start at `/lab/visual`.
 */
const page = (title: string, body: string): Response => ({
  status: 200,
  headers: { "content-type": "text/html; charset=utf-8" },
  body: layout(title, body),
});

const checkout = (badgeStyle: string) => `<style>
  .checkout { position: relative; display: flex; gap: 1rem; align-items: center; }
  .checkout button { padding: 0.5rem 1rem; font-size: 1rem; }
  .badge { padding: 0.4rem 0.8rem; background: #ffd400; color: #111; ${badgeStyle} }
</style>
<p>Your basket is ready.</p>
<div class="checkout">
  <button type="button">Pay now</button>
  <span class="badge">Free shipping over 50 euros</span>
</div>`;

export function visualRoutes(): Route[] {
  return [
    {
      method: "GET",
      path: "/lab/visual",
      handle: () =>
        page(
          "Checkout",
          // Seeded bug: the badge is positioned over the button and covers its label.
          `${checkout("position: absolute; left: 0; top: 0;")}
<p><a href="/lab/visual/clean">Checkout with the fixed layout</a></p>`,
        ),
    },
    {
      method: "GET",
      path: "/lab/visual/clean",
      handle: () => page("Fixed checkout", `${checkout("")}\n<p><a href="/lab/visual">Back to the checkout</a></p>`),
    },
  ];
}

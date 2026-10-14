import { randomUUID } from "node:crypto";
import type { Request, Response, Route, SiteState } from "../fixtures/site/pages.ts";
import {
  accountBody,
  cartBody,
  crashBody,
  type Line,
  landingBody,
  loginBody,
  orderBody,
  PRODUCTS,
  shopBody,
  shopLayout,
  total,
} from "./shop-view.ts";

/**
 * Monkey Market: a styled demo shop under /demo with its own login, cart and checkout. Like the lab, the home page
 * does not link here and the shop does not link back, so the main site's five seeded bugs stay exactly five and a run
 * started at /demo only finds the shop's own bug.
 */

/** The one coupon the checkout knows. */
export const SHOP_COUPON = "MONKEY10";

const SHOP_COOKIE = "shop_sid";
const MAX_QUANTITY = 9;

/** Per-session cart: product id to quantity. */
type Cart = Map<string, number>;

interface Shop {
  state: SiteState;
  carts: Map<string, Cart>;
  orders: number;
}

const html = (body: string): Response => ({
  status: 200,
  headers: { "content-type": "text/html; charset=utf-8" },
  body,
});

const redirect = (location: string, headers: Record<string, string> = {}): Response => ({
  status: 303,
  headers: { location, ...headers },
});

interface Shopper {
  user: string;
  cart: Cart;
}

function session(shop: Shop, request: Request): Shopper | undefined {
  const sid = request.cookies[SHOP_COOKIE];
  const user = sid === undefined ? undefined : shop.state.sessions.get(sid);
  if (sid === undefined || user === undefined) return undefined;
  const cart = shop.carts.get(sid) ?? new Map<string, number>();
  shop.carts.set(sid, cart);
  return { user, cart };
}

function lines(cart: Cart): Line[] {
  return PRODUCTS.flatMap((product) => {
    const quantity = cart.get(product.id) ?? 0;
    return quantity > 0 ? [{ product, quantity }] : [];
  });
}

const itemCount = (cart: Cart): number => [...cart.values()].reduce((sum, n) => sum + n, 0);

function page(shop: Shop, request: Request, title: string, body: string): Response {
  const current = session(shop, request);
  const nav = current === undefined ? { items: 0 } : { user: current.user, items: itemCount(current.cart) };
  return html(shopLayout(title, body, nav));
}

/** Wraps a handler that needs a signed-in shopper; without a session it redirects to the shop login. */
function signedIn(shop: Shop, handle: (request: Request, current: Shopper) => Response) {
  return (request: Request): Response => {
    const current = session(shop, request);
    return current === undefined ? redirect("/demo/login") : handle(request, current);
  };
}

function logIn(shop: Shop, request: Request): Response {
  const { username, password } = shop.state.credentials;
  if (request.form.get("username") !== username || request.form.get("password") !== password) {
    // 200 with a message, like the main login: a 401 would be an unseeded http4xx finding.
    return page(shop, request, "Sign in", loginBody("Wrong username or password."));
  }
  const sid = randomUUID();
  shop.state.sessions.set(sid, username);
  return redirect("/demo/shop", { "set-cookie": `${SHOP_COOKIE}=${sid}; Path=/demo; HttpOnly; SameSite=Lax` });
}

function logOut(shop: Shop, request: Request): Response {
  const sid = request.cookies[SHOP_COOKIE];
  if (sid !== undefined) {
    shop.state.sessions.delete(sid);
    shop.carts.delete(sid);
  }
  return redirect("/demo", { "set-cookie": `${SHOP_COOKIE}=; Path=/demo; HttpOnly; SameSite=Lax; Max-Age=0` });
}

function addToCart(request: Request, cart: Cart): Response {
  const id = request.form.get("product") ?? "";
  if (PRODUCTS.some((p) => p.id === id)) {
    const wanted = Number.parseInt(request.form.get("quantity") ?? "", 10);
    const quantity = Number.isNaN(wanted) ? 1 : Math.min(Math.max(wanted, 1), MAX_QUANTITY);
    cart.set(id, Math.min((cart.get(id) ?? 0) + quantity, MAX_QUANTITY));
  }
  return redirect("/demo/cart");
}

function checkOut(shop: Shop, request: Request, cart: Cart): Response {
  const bought = lines(cart);
  if (bought.length === 0) return redirect("/demo/cart");
  // Seeded bug: the receipt mailer crashes on an email address without a domain, including an empty one.
  const domain = (request.form.get("email") ?? "").split("@")[1] ?? "";
  if (domain.trim() === "") return { ...page(shop, request, "Checkout failed", crashBody()), status: 500 };
  const coupon = (request.form.get("coupon") ?? "").trim().toUpperCase();
  if (coupon !== "" && coupon !== SHOP_COUPON) {
    return page(shop, request, "Cart", cartBody(bought, "This coupon code is not valid."));
  }
  const amount = coupon === SHOP_COUPON ? Math.round(total(bought) * 0.9) : total(bought);
  cart.clear();
  shop.orders++;
  return page(shop, request, "Order placed", orderBody(shop.orders, request.form.get("name") ?? "", amount));
}

/** All routes of the demo shop. */
export function shopRoutes(state: SiteState): Route[] {
  const shop: Shop = { state, carts: new Map(), orders: 0 };
  return [
    { method: "GET", path: "/demo", handle: (request) => page(shop, request, "Fresh fruit", landingBody()) },
    {
      method: "GET",
      path: "/demo/login",
      handle: (request) =>
        session(shop, request) === undefined ? page(shop, request, "Sign in", loginBody()) : redirect("/demo/shop"),
    },
    { method: "POST", path: "/demo/login", handle: (request) => logIn(shop, request) },
    { method: "POST", path: "/demo/logout", handle: (request) => logOut(shop, request) },
    {
      method: "GET",
      path: "/demo/shop",
      handle: signedIn(shop, (request, { user }) => page(shop, request, "Shop", shopBody(user))),
    },
    {
      method: "GET",
      path: "/demo/account",
      handle: signedIn(shop, (request, { user }) => page(shop, request, "Account", accountBody(user, shop.orders))),
    },
    { method: "POST", path: "/demo/cart", handle: signedIn(shop, (request, { cart }) => addToCart(request, cart)) },
    {
      method: "GET",
      path: "/demo/cart",
      handle: signedIn(shop, (request, { cart }) => page(shop, request, "Cart", cartBody(lines(cart)))),
    },
    {
      method: "POST",
      path: "/demo/cart/remove",
      handle: signedIn(shop, (request, { cart }) => {
        cart.delete(request.form.get("product") ?? "");
        return redirect("/demo/cart");
      }),
    },
    {
      method: "POST",
      path: "/demo/checkout",
      handle: signedIn(shop, (request, { cart }) => checkOut(shop, request, cart)),
    },
    // A reload or a navigation to a form target must not end on the main site's 404 page, which links home.
    ...["/demo/cart/remove", "/demo/checkout", "/demo/logout"].map(
      (path): Route => ({ method: "GET", path, handle: () => redirect("/demo/cart") }),
    ),
  ];
}

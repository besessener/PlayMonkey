import { escapeHtml } from "../fixtures/site/html.ts";

export interface Product {
  id: string;
  name: string;
  blurb: string;
  /** Price in cents. */
  price: number;
  color: string;
}

export const PRODUCTS: Product[] = [
  { id: "banana", name: "Bananas", blurb: "A bunch of six, perfectly ripe.", price: 249, color: "#ffd54f" },
  { id: "mango", name: "Mangoes", blurb: "Two sweet mangoes per pack.", price: 399, color: "#ffb74d" },
  { id: "coconut", name: "Coconut", blurb: "Fresh, with a straw included.", price: 299, color: "#bcaaa4" },
  { id: "pineapple", name: "Pineapple", blurb: "Golden, juicy and heavy.", price: 349, color: "#fff176" },
  { id: "kiwi", name: "Kiwis", blurb: "A box of eight, soft and tangy.", price: 279, color: "#aed581" },
  { id: "papaya", name: "Papaya", blurb: "Big, orange and ready to eat.", price: 459, color: "#ff8a65" },
];

/** A cart line: a product and its quantity. */
export interface Line {
  product: Product;
  quantity: number;
}

export const price = (cents: number): string => `€${(cents / 100).toFixed(2)}`;

export const total = (lines: Line[]): number => lines.reduce((sum, l) => sum + l.product.price * l.quantity, 0);

// No fixed widths anywhere: the overflow oracle must stay silent on every shop page.
const STYLE = `
  :root { --ink: #1d1b2f; --muted: #6b6880; --brand: #ff7a3d; --brand2: #ffb547; --bg: #f6f4fb; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, sans-serif; background: var(--bg); color: var(--ink); line-height: 1.5;
    overflow-wrap: anywhere; }
  .top { background: linear-gradient(135deg, #2b1d4e, #5b2a86); color: #fff; }
  .bar, main { max-width: 64rem; margin: 0 auto; padding: 1rem 1.25rem; }
  .bar { display: flex; flex-wrap: wrap; gap: 1rem; align-items: center; justify-content: space-between; }
  .brand { font-weight: 800; font-size: 1.3rem; color: #fff; text-decoration: none; }
  .brand span { color: var(--brand2); }
  .links { display: flex; flex-wrap: wrap; gap: 1rem; align-items: center; }
  .links a { color: #fff; text-decoration: none; }
  .links form { margin: 0; }
  .pill { background: rgba(255,255,255,.18); border-radius: 999px; padding: .1rem .6rem; margin-left: .25rem; }
  main { padding-top: 2rem; padding-bottom: 2rem; }
  .hero { background: linear-gradient(135deg, var(--brand), var(--brand2)); color: #fff; border-radius: 1.25rem;
    padding: 3rem 2rem; box-shadow: 0 12px 40px rgba(255,122,61,.35); }
  .hero h1 { font-size: clamp(1.8rem, 4vw, 3rem); margin: 0 0 .5rem; line-height: 1.15; }
  .btn { display: inline-block; border: 0; border-radius: .75rem; padding: .7rem 1.2rem; font: inherit;
    font-weight: 600; cursor: pointer; background: var(--ink); color: #fff; text-decoration: none; }
  .btn:hover { filter: brightness(1.15); }
  .btn.light { background: #fff; color: var(--ink); }
  .btn.ghost { background: transparent; color: #fff; border: 1px solid rgba(255,255,255,.6); padding: .35rem .9rem; }
  .btn.small { padding: .35rem .8rem; font-size: .9rem; background: #ece8f6; color: var(--ink); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr)); gap: 1.25rem; margin-top: 1.5rem; }
  .card, .panel { background: #fff; border-radius: 1rem; padding: 1.25rem; box-shadow: 0 6px 24px rgba(43,29,78,.08); }
  .card { display: flex; flex-direction: column; gap: .6rem; }
  .card h2 { margin: 0; font-size: 1.15rem; }
  .card form.add { margin-top: auto; display: flex; gap: .5rem; align-items: end; }
  .split { display: grid; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); gap: 1.25rem; align-items: start; }
  .split h2 { margin: 0; }
  .checkout label { margin-top: .5rem; }
  .thumb { height: 8rem; border-radius: .75rem; display: grid; place-items: center; font-size: 3rem; font-weight: 800;
    color: rgba(0,0,0,.3); }
  .price { font-weight: 700; font-size: 1.1rem; }
  .muted { color: var(--muted); }
  .panel { max-width: 30rem; margin: 0 auto; padding: 1.75rem; }
  label { display: block; font-weight: 600; margin-top: .9rem; }
  input { display: block; width: 100%; margin-top: .3rem; padding: .6rem .75rem; border: 1px solid #d8d4e6;
    border-radius: .6rem; font: inherit; background: #fff; }
  input:focus { outline: 2px solid var(--brand); border-color: transparent; }
  .card label { margin: 0; font-size: .85rem; }
  .card input { width: 4.5rem; }
  .alert, .note { padding: .75rem 1rem; border-radius: .6rem; }
  .alert { background: #fde8e8; color: #9b1c1c; }
  .note { background: #fff4e5; color: #8a4b00; }
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
  th, td { padding: .6rem .4rem; text-align: left; border-bottom: 1px solid #eee; }
  td form { margin: 0; }
  .sum { font-size: 1.2rem; font-weight: 800; text-align: right; }
  footer { text-align: center; color: var(--muted); padding: 2rem 1rem; font-size: .9rem; }
`;

/** The shop's own layout: no link to the main fixture site, so a run started at /demo stays in the shop. */
export function shopLayout(title: string, body: string, nav: { user?: string; items: number }): string {
  const links =
    nav.user === undefined
      ? '<a href="/demo/login">Sign in</a>'
      : `<a href="/demo/shop">Shop</a>
    <a href="/demo/cart">Cart <span class="pill">${nav.items}</span></a>
    <a class="btn ghost" href="/demo/account">${escapeHtml(nav.user)}</a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Monkey Market</title>
<link rel="icon" href="data:,">
<style>${STYLE}</style>
</head>
<body>
<header class="top"><div class="bar">
  <a class="brand" href="/demo">Monkey<span>Market</span></a>
  <nav class="links" aria-label="Shop">${links}</nav>
</div></header>
<main>
${body}
</main>
<footer>Monkey Market is a demo shop of the PlayMonkey fixture site. Nothing here is real.</footer>
</body>
</html>
`;
}

export function landingBody(): string {
  const perks = [
    ["Same-day delivery", "Ordered before noon, swinging at your door by dinner."],
    ["Hand-picked", "Every piece of fruit is checked by a very picky monkey."],
    ["Coupons", "Use MONKEY10 at checkout for ten percent off."],
  ];
  const cards = perks.map(([t, d]) => `<div class="card"><h2>${t}</h2><p class="muted">${d}</p></div>`).join("\n");
  return `<section class="hero">
  <h1>Fresh tropical fruit, delivered.</h1>
  <p>Bananas, mangoes, coconuts and more. Sign in and fill your basket.</p>
  <a class="btn light" href="/demo/shop">Start shopping</a>
</section>
<div class="grid">
${cards}
</div>`;
}

export function loginBody(error?: string): string {
  const alert = error === undefined ? "" : `<p class="alert" role="alert">${escapeHtml(error)}</p>`;
  return `<section class="panel">
  <h1>Welcome back</h1>
  <p class="muted">Sign in to see today's prices.</p>
  ${alert}
  <form method="post" action="/demo/login">
    <label>Username <input name="username" autocomplete="username"></label>
    <label>Password <input name="password" type="password" autocomplete="current-password"></label>
    <p><button class="btn" type="submit">Sign in</button></p>
  </form>
</section>`;
}

function productCard(product: Product): string {
  return `<article class="card">
  <div class="thumb" style="background: ${product.color};" aria-hidden="true">${product.name.charAt(0)}</div>
  <h2>${product.name}</h2>
  <p class="muted">${product.blurb}</p>
  <p class="price">${price(product.price)}</p>
  <form class="add" method="post" action="/demo/cart">
    <input type="hidden" name="product" value="${product.id}">
    <label>Qty <input name="quantity" type="number" min="1" max="9" value="1" aria-label="Quantity of ${product.name}"></label>
    <button class="btn" type="submit" aria-label="Add ${product.name} to cart">Add to cart</button>
  </form>
</article>`;
}

export function shopBody(user: string): string {
  return `<h1>Hello, ${escapeHtml(user)}</h1>
<p class="muted">Today's fruit, fresh from the market.</p>
<div class="grid">
${PRODUCTS.map(productCard).join("\n")}
</div>`;
}

export function accountBody(user: string, orders: number): string {
  return `<section class="panel">
  <h1>Your account</h1>
  <p>Signed in as <strong>${escapeHtml(user)}</strong>. Orders placed in this shop: ${orders}.</p>
  <form method="post" action="/demo/logout"><button class="btn" type="submit">Sign out</button></form>
</section>`;
}

function cartRow({ product, quantity }: Line): string {
  return `<tr><td>${product.name}</td><td>${quantity}</td><td>${price(product.price * quantity)}</td>
  <td><form method="post" action="/demo/cart/remove"><input type="hidden" name="product" value="${product.id}">
  <button class="btn small" type="submit" aria-label="Remove ${product.name}">Remove</button></form></td></tr>`;
}

export function cartBody(lines: Line[], error?: string): string {
  if (lines.length === 0) {
    return `<section class="panel"><h1>Your cart is empty</h1>
<p class="muted">Nothing in here yet.</p><a class="btn" href="/demo/shop">Browse fruit</a></section>`;
  }
  // novalidate: the browser must not block submissions, so the server-side bug stays reachable.
  // Side by side, so "Place order" is above the fold of the default viewport.
  return `<h1>Your cart</h1>
<div class="split">
<section class="card">
  <table>
    <thead><tr><th>Item</th><th>Qty</th><th>Price</th><th><span class="muted">Action</span></th></tr></thead>
    <tbody>${lines.map(cartRow).join("\n")}</tbody>
  </table>
  <p class="sum">Total ${price(total(lines))}</p>
  <p class="note">Tip: MONKEY10 takes ten percent off.</p>
</section>
<section class="card">
  <h2>Checkout</h2>
  ${error === undefined ? "" : `<p class="alert" role="alert">${escapeHtml(error)}</p>`}
  <form class="checkout" method="post" action="/demo/checkout" novalidate>
    <label>Full name <input name="name" autocomplete="name"></label>
    <label>Email <input name="email" type="email" autocomplete="email"></label>
    <label>Coupon code <input name="coupon"></label>
    <p><button class="btn" type="submit">Place order</button></p>
  </form>
</section>
</div>`;
}

export function orderBody(order: number, name: string, amount: number): string {
  const who = name.trim() === "" ? "" : `, ${escapeHtml(name)}`;
  return `<section class="hero">
  <h1>Thank you${who}!</h1>
  <p>Order #${order} is on its way. You paid ${price(amount)}.</p>
  <a class="btn light" href="/demo/shop">Keep shopping</a>
</section>`;
}

export function crashBody(): string {
  return `<section class="panel"><h1>Something went wrong</h1>
<p class="muted">The checkout failed. Please try again later.</p><a class="btn" href="/demo/cart">Back to the cart</a></section>`;
}

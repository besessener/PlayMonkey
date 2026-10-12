const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escapes text for HTML content and attribute values. Every echoed input must go through this. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

/** Wraps page content in the shared layout. `title` is escaped; `body` is trusted HTML. */
export function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="data:,">
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; line-height: 1.5; }
  label { display: block; margin-top: 0.75rem; }
  .error { color: #b00020; }
</style>
</head>
<body>
<nav><a href="/">Home</a></nav>
<main>
<h1>${escapeHtml(title)}</h1>
${body}
</main>
</body>
</html>
`;
}

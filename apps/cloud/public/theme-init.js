// Apply the saved theme before first paint so the page never flashes the wrong palette.
// An external file because the CSP allows no inline script; the root layout loads it with the request's nonce.
// Kept in sync with src/components/theme-provider.tsx. The key is shared with the Godmode dashboard under /d/….
(function () {
  var t = "light";
  try {
    t = localStorage.getItem("godmode-theme") || "light";
  } catch (e) {}
  if (t === "system") t = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  if (t !== "dark") t = "light";
  var r = document.documentElement;
  r.classList.toggle("dark", t === "dark");
  r.dataset.theme = t;
  r.style.colorScheme = t;
  // Paper / anthracite — the --background tokens in src/app/globals.css.
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", t === "dark" ? "#1c1b19" : "#faf9f5");
})();

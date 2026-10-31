// Apply the saved theme before first paint so the window never flashes the wrong palette.
// Kept in sync with src/components/theme-provider.tsx.
(function () {
  var t = "light";
  var p = "paper";
  var css = "";
  try {
    t = localStorage.getItem("godmode-theme") || "light";
    if (t !== "dark" && t !== "system") t = "light";
    p = localStorage.getItem("godmode-palette") || "paper";
    css = localStorage.getItem("godmode-palette-css") || "";
  } catch (e) {}
  if (t === "system") t = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  var r = document.documentElement;
  if (t === "dark") r.classList.add("dark");
  r.dataset.theme = t;
  r.dataset.palette = p;
  r.style.colorScheme = t;
  if (css) {
    var s = document.createElement("style");
    s.id = "gm-palette";
    s.textContent = css;
    document.head.appendChild(s);
  }
})();

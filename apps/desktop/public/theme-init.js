// Apply the saved theme before first paint so the window never flashes the wrong palette.
// Kept in sync with src/components/theme-provider.tsx.
(function () {
  var t = "light";
  try {
    t = localStorage.getItem("godmode-theme") || "light";
  } catch (e) {}
  if (t === "system") t = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  var r = document.documentElement;
  if (t === "dark") r.classList.add("dark");
  r.dataset.theme = t;
  r.style.colorScheme = t;
})();

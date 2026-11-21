// The look of Quire: same as the device, light, dark, warm (sepia pages) or greyscale.
// The choice is kept in this browser; index.html applies it before the page is drawn, so there's no flash.
const KEY = "quire-theme";
const THEMES = new Set(["system", "light", "dark", "warm", "grey"]);

function apply(theme) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

function saved() {
  try { const t = localStorage.getItem(KEY); return THEMES.has(t) ? t : "system"; } catch { return "system"; }
}

/** Wire the theme menu: its items carry data-theme-choice; the chosen one is aria-checked. */
export function createThemeMenu(menu) {
  const mark = (theme) => {
    for (const item of menu.querySelectorAll("[data-theme-choice]")) {
      item.setAttribute("aria-checked", String(item.dataset.themeChoice === theme));
    }
  };
  mark(saved());
  menu.addEventListener("click", (e) => {
    const theme = e.target.closest("[data-theme-choice]")?.dataset.themeChoice;
    if (!THEMES.has(theme)) return;
    apply(theme);
    mark(theme);
    try {
      if (theme === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, theme);
    } catch { /* storage blocked: this visit only */ }
  });
}

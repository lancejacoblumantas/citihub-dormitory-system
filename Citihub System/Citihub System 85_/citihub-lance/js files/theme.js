//  GLOBAL THEME SYSTEM

function applyTheme(theme) {
    const html = document.documentElement;

    if (theme === "light") {
        html.classList.remove("dark");
    } 
    else if (theme === "dark") {
        html.classList.add("dark");
    } 
    else if (theme === "system") {
        html.classList.remove("dark");
    }
}

//  Load saved theme on EVERY page
const savedTheme = localStorage.getItem("theme") || "system";
applyTheme(savedTheme);

//  Listen to system changes
const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

mediaQuery.addEventListener("change", () => {
    if (localStorage.getItem("theme") === "system") {
        applyTheme("system");
    }
});
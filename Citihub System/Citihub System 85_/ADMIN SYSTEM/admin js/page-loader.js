(function () {
    const startedAt = Date.now();
    const MIN_VISIBLE_MS = 220;

    function getLoader() {
        return document.getElementById("pageLoadingOverlay");
    }

    function hideLoaderNow() {
        const loader = getLoader();
        if (loader) {
            loader.style.display = "none";
        }
    }

    window.hidePageLoader = function () {
        const elapsed = Date.now() - startedAt;
        const delay = Math.max(0, MIN_VISIBLE_MS - elapsed);
        window.setTimeout(hideLoaderNow, delay);
    };

    window.showPageLoader = function () {
        const loader = getLoader();
        if (loader) {
            loader.style.display = "flex";
        }
    };

    window.addEventListener("load", function () {
        if (document.body?.dataset.loaderMode !== "manual") {
            window.hidePageLoader();
        }
    });
})();

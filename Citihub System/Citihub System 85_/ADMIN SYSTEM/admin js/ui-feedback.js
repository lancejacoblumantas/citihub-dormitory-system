function showFormalAlert(message) {
    let style = document.getElementById("formal-toast-style");

    if (!style) {
        style = document.createElement("style");
        style.id = "formal-toast-style";
        style.textContent = `
            .formal-toast {
                position: fixed;
                bottom: 28px;
                right: 28px;
                background: #1a1a2e;
                color: #ffffff;
                padding: 12px 20px;
                border-radius: 10px;
                font-size: 13.5px;
                font-weight: 500;
                box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
                z-index: 99999;
                opacity: 0;
                transform: translateY(12px);
                transition: opacity 0.25s, transform 0.25s;
                pointer-events: none;
                max-width: min(420px, calc(100vw - 32px));
                line-height: 1.5;
            }

            .formal-toast.show {
                opacity: 1;
                transform: translateY(0);
            }
        `;
        document.head.appendChild(style);
    }

    let toast = document.getElementById("globalFormalToast");

    if (!toast) {
        toast = document.createElement("div");
        toast.id = "globalFormalToast";
        toast.className = "formal-toast";
        document.body.appendChild(toast);
    }

    toast.textContent = message;
    toast.classList.add("show");

    clearTimeout(toast.hideTimer);
    toast.hideTimer = setTimeout(() => {
        toast.classList.remove("show");
    }, 3500);
}

function ensureAdminLoadingStyle() {
    let style = document.getElementById("admin-loading-button-style");

    if (style) {
        return;
    }

    style = document.createElement("style");
    style.id = "admin-loading-button-style";
    style.textContent = `
        .admin-btn-loading {
            display: inline-flex !important;
            align-items: center;
            justify-content: center;
            gap: 8px;
            opacity: 0.82;
            cursor: wait !important;
            pointer-events: none;
        }

        .admin-btn-spinner {
            width: 14px;
            height: 14px;
            border: 2px solid rgba(255,255,255,0.42);
            border-top-color: currentColor;
            border-radius: 50%;
            animation: adminBtnSpin 0.75s linear infinite;
            flex-shrink: 0;
        }

        .tbl-btn .admin-btn-spinner,
        .modal-cancel-btn .admin-btn-spinner,
        .ticket-quick-btn .admin-btn-spinner {
            border-color: rgba(107,114,128,0.28);
            border-top-color: currentColor;
        }

        @keyframes adminBtnSpin {
            to { transform: rotate(360deg); }
        }
    `;
    document.head.appendChild(style);
}

function setAdminButtonLoading(button, label = "Working...") {
    if (!button) {
        return;
    }

    ensureAdminLoadingStyle();

    if (!button.dataset.originalHtml) {
        button.dataset.originalHtml = button.innerHTML;
    }

    button.disabled = true;
    button.classList.add("admin-btn-loading");
    button.innerHTML = `<span class="admin-btn-spinner" aria-hidden="true"></span><span>${label}</span>`;
}

function restoreAdminButton(button) {
    if (!button) {
        return;
    }

    button.disabled = false;
    button.classList.remove("admin-btn-loading");

    if (button.dataset.originalHtml) {
        button.innerHTML = button.dataset.originalHtml;
    }
}

async function callAdminApi(path, payload = {}) {
    const user = firebase.auth().currentUser;
    if (!user) {
        throw new Error("You must be signed in as an administrator.");
    }

    const baseUrl = window.CITIHUB_API_BASE_URL || "http://localhost:4000";
    const token = await user.getIdToken();
    const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify(payload || {})
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(result.error || "The admin request failed.");
    }

    return result;
}

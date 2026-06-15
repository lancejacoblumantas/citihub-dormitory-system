const complaintState = {
    user: null,
    userData: null,
    unsubscribe: null,
    submitting: false
};

let complaintToastTimer = null;

function showToast(message) {
    const toast = document.getElementById("toast");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(complaintToastTimer);
    complaintToastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function escapeHtmlWithBreaks(value) {
    return escapeHtml(value).replace(/\n/g, "<br>");
}

function getInitials(name) {
    return String(name || "CT")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part.charAt(0).toUpperCase())
        .join("") || "CT";
}

function formatLabel(value) {
    return String(value || "")
        .split(/[_\s-]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
}

function getDate(timestamp) {
    if (!timestamp) return null;
    if (typeof timestamp.toDate === "function") return timestamp.toDate();
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(timestamp) {
    const date = getDate(timestamp);
    if (!date) return "Awaiting timestamp";
    return new Intl.DateTimeFormat("en-PH", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit"
    }).format(date);
}

async function callComplaintApi(path, payload) {
    const user = firebase.auth().currentUser;
    if (!user) {
        throw new Error("You must be signed in to continue.");
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
        throw new Error(result.error || "Unable to submit report.");
    }

    return result;
}

function setApprovedAccess(isApproved) {
    const lockedCard = document.getElementById("lockedCard");
    const layout = document.getElementById("complaintLayout");
    if (lockedCard) lockedCard.style.display = isApproved ? "none" : "";
    if (layout) layout.style.display = isApproved ? "" : "none";
}

function renderComplaints(reports) {
    const list = document.getElementById("complaintHistory");
    if (!list) return;

    if (!reports.length) {
        list.innerHTML = `<div class="empty-state">No reports submitted yet.</div>`;
        return;
    }

    list.innerHTML = reports.map((report) => {
        const status = String(report.status || "open").replace(/_/g, "-");
        const category = formatLabel(report.category || "other");
        const location = [report.reportedTenantRoom, report.reportedTenantBed].filter(Boolean).join(", ") || "Location not specified";
        return `
            <article class="report-item">
                <div class="report-item-top">
                    <div>
                        <div class="report-title">${escapeHtml(report.subject || "Complaint Report")}</div>
                        <div class="report-meta">${escapeHtml(category)} | ${escapeHtml(location)}</div>
                    </div>
                    <span class="status-pill ${escapeHtml(status)}">${escapeHtml(formatLabel(report.status || "open"))}</span>
                </div>
                <div class="report-desc">${escapeHtmlWithBreaks(report.description || "No details provided.")}</div>
                ${report.adminNote ? `<div class="report-note"><strong>Admin note</strong><br>${escapeHtmlWithBreaks(report.adminNote)}</div>` : ""}
                <div class="report-time">Updated ${formatDate(report.updatedAt || report.createdAt)}</div>
            </article>
        `;
    }).join("");
}

function subscribeToComplaints(userId) {
    if (complaintState.unsubscribe) {
        complaintState.unsubscribe();
        complaintState.unsubscribe = null;
    }

    complaintState.unsubscribe = db.collection("tenantComplaints")
        .where("userId", "==", userId)
        .onSnapshot((snapshot) => {
            const reports = [];
            snapshot.forEach((doc) => reports.push({ id: doc.id, ...doc.data() }));
            reports.sort((left, right) => {
                const leftDate = getDate(left.updatedAt || left.createdAt);
                const rightDate = getDate(right.updatedAt || right.createdAt);
                return (rightDate?.getTime?.() || 0) - (leftDate?.getTime?.() || 0);
            });
            renderComplaints(reports);
        }, (error) => {
            console.error("Failed to load complaint reports:", error);
            showToast("Unable to load your reports right now.");
        });
}

function resetForm() {
    document.getElementById("reportedTenantName").value = "";
    document.getElementById("reportedTenantRoom").value = "";
    document.getElementById("reportedTenantBed").value = "";
    document.getElementById("complaintSubject").value = "";
    document.getElementById("complaintDescription").value = "";
    document.getElementById("complaintCategory").value = "unauthorized_visit";
}

async function submitComplaint(event) {
    event.preventDefault();
    if (complaintState.submitting) return;

    const subject = document.getElementById("complaintSubject")?.value.trim() || "";
    const description = document.getElementById("complaintDescription")?.value.trim() || "";
    const submitBtn = document.getElementById("submitComplaintBtn");

    if (!subject || !description) {
        showToast("Please complete the subject and details before submitting.");
        return;
    }

    complaintState.submitting = true;
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Submitting...";
    }

    try {
        await callComplaintApi("/api/complaints/create", {
            category: document.getElementById("complaintCategory")?.value || "other",
            reportedTenantName: document.getElementById("reportedTenantName")?.value || "",
            reportedTenantRoom: document.getElementById("reportedTenantRoom")?.value || "",
            reportedTenantBed: document.getElementById("reportedTenantBed")?.value || "",
            subject,
            description
        });

        resetForm();
        showToast("Your report has been submitted to the admin team.");
    } catch (error) {
        console.error("Failed to submit complaint:", error);
        showToast(error.message || "Unable to submit your report right now.");
    } finally {
        complaintState.submitting = false;
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = "Submit Report";
        }
    }
}

auth.onAuthStateChanged(async (user) => {
    if (!user) {
        window.location.href = "intro.html";
        return;
    }

    complaintState.user = user;

    try {
        const profileSnap = await db.collection("users").doc(user.uid).get();
        if (!profileSnap.exists) {
            setApprovedAccess(false);
            showToast("Your tenant profile could not be found.");
            window.hidePageLoader?.();
            return;
        }

        const profile = profileSnap.data() || {};
        complaintState.userData = profile;
        const avatar = document.getElementById("complaintAvatar");
        if (avatar) {
            avatar.textContent = getInitials(profile.fullName || profile.username || user.email);
        }

        const isApproved = profile.status === "approved";
        setApprovedAccess(isApproved);
        if (isApproved) {
            subscribeToComplaints(user.uid);
        }
        window.hidePageLoader?.();
    } catch (error) {
        console.error("Failed to initialize complaint page:", error);
        setApprovedAccess(false);
        window.hidePageLoader?.();
    }
});

document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("complaintForm")?.addEventListener("submit", submitComplaint);
});

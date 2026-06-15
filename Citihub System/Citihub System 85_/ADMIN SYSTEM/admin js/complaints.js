requireAdminAccess();

const complaintAdminState = {
    reports: [],
    filteredReports: [],
    selectedReportId: null,
    unsubscribe: null
};

function showToast(message) {
    const toast = document.getElementById("toast");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toast.hideTimer);
    toast.hideTimer = setTimeout(() => toast.classList.remove("show"), 3000);
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

function getReportDate(timestamp) {
    if (!timestamp) return null;
    if (typeof timestamp.toDate === "function") return timestamp.toDate();
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(timestamp) {
    const date = getReportDate(timestamp);
    if (!date) return "Awaiting timestamp";
    return new Intl.DateTimeFormat("en-PH", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit"
    }).format(date);
}

function formatLabel(value) {
    return String(value || "")
        .split(/[_\s-]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
}

function escapeCsv(value) {
    const text = String(value ?? "");
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadTextFile(filename, content, type = "text/csv;charset=utf-8") {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

function getExportDateStamp() {
    return new Date().toISOString().slice(0, 10);
}

function getVisibleComplaintReports() {
    return complaintAdminState.filteredReports.length || complaintAdminState.reports.length
        ? complaintAdminState.filteredReports
        : [];
}

function downloadComplaintsCsv() {
    const reports = getVisibleComplaintReports();
    if (!reports.length) {
        showToast("There are no complaint reports to export using the current filters.");
        return;
    }

    const headers = [
        "Subject",
        "Reporter",
        "Reporter Email",
        "Reporter Room",
        "Reported Tenant",
        "Reported Room",
        "Category",
        "Status",
        "Action Taken",
        "Description",
        "Admin Note",
        "Submitted",
        "Updated",
        "Record ID"
    ];

    const lines = [
        headers.map(escapeCsv).join(","),
        ...reports.map((report) => [
            report.subject || "Complaint Report",
            report.reporterName || "Tenant",
            report.reporterEmail || "",
            report.reporterRoom || "",
            report.reportedTenantName || "",
            [report.reportedTenantRoom, report.reportedTenantBed].filter(Boolean).join(", "),
            formatLabel(report.category || "other"),
            formatLabel(report.status || "open"),
            formatLabel(report.violationAction || "none"),
            report.description || "",
            report.adminNote || "",
            formatDate(report.createdAt),
            formatDate(report.updatedAt || report.createdAt),
            report.id
        ].map(escapeCsv).join(","))
    ];

    downloadTextFile(`citihub_complaints_${getExportDateStamp()}.csv`, lines.join("\n"));
    showToast("Complaint Reports CSV export has been downloaded.");
}

function downloadComplaintsPdf() {
    const reports = getVisibleComplaintReports();
    if (!reports.length) {
        showToast("There are no complaint reports to export using the current filters.");
        return;
    }

    if (!window.jspdf?.jsPDF) {
        const content = [
            "CITIHUB DORMITORY - COMPLAINT REPORTS",
            "=".repeat(46),
            `Generated: ${new Date().toLocaleString()}`,
            `Reports included: ${reports.length}`,
            "",
            ...reports.map((report) => `${formatDate(report.updatedAt || report.createdAt)} | ${report.reporterName || "Tenant"} | ${report.subject || "Complaint Report"} | ${formatLabel(report.status || "open")} | ${formatLabel(report.violationAction || "none")}`)
        ].join("\n");
        downloadTextFile(`citihub_complaints_${getExportDateStamp()}.txt`, content, "text/plain;charset=utf-8");
        showToast("PDF generator was unavailable, so a text report was downloaded.");
        return;
    }

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: "landscape" });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    let y = 38;

    const ensureSpace = () => {
        if (y > pageHeight - 18) {
            pdf.addPage();
            y = 18;
        }
    };

    const counts = reports.reduce((acc, report) => {
        const status = report.status || "open";
        acc[status] = (acc[status] || 0) + 1;
        return acc;
    }, {});

    pdf.setFillColor(26, 122, 74);
    pdf.rect(0, 0, pageWidth, 28, "F");
    pdf.setTextColor(255, 255, 255);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(16);
    pdf.text("CITIHUB DORMITORY", 14, 13);
    pdf.setFontSize(10);
    pdf.setFont("helvetica", "normal");
    pdf.text("Complaint Reports", 14, 21);
    pdf.setTextColor(26, 26, 46);

    pdf.setFontSize(10);
    pdf.text(`Generated: ${new Date().toLocaleString()}`, 14, y); y += 8;
    pdf.text(`Shown: ${reports.length}   Open: ${counts.open || 0}   In Review: ${counts.in_review || 0}   Resolved: ${counts.resolved || 0}   Dismissed: ${counts.dismissed || 0}`, 14, y); y += 12;

    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(9);
    pdf.text("Reporter", 14, y);
    pdf.text("Reported Tenant", 58, y);
    pdf.text("Subject", 106, y);
    pdf.text("Category", 158, y);
    pdf.text("Status", 196, y);
    pdf.text("Action", 232, y);
    pdf.text("Updated", 262, y);
    y += 5;
    pdf.setDrawColor(229, 231, 235);
    pdf.line(14, y, pageWidth - 14, y);
    y += 7;
    pdf.setFont("helvetica", "normal");

    reports.forEach((report) => {
        ensureSpace();
        pdf.text(String(report.reporterName || "Tenant").slice(0, 20), 14, y);
        pdf.text(String(report.reportedTenantName || "N/A").slice(0, 22), 58, y);
        pdf.text(String(report.subject || "Complaint Report").slice(0, 24), 106, y);
        pdf.text(formatLabel(report.category || "other").slice(0, 16), 158, y);
        pdf.text(formatLabel(report.status || "open").slice(0, 16), 196, y);
        pdf.text(formatLabel(report.violationAction || "none").slice(0, 14), 232, y);
        pdf.text(formatDate(report.updatedAt || report.createdAt).slice(0, 18), 262, y);
        y += 7;
    });

    pdf.setFontSize(8);
    pdf.setTextColor(107, 114, 128);
    pdf.text("Generated by CitiHub Admin Complaints", 14, pageHeight - 8);
    pdf.save(`citihub_complaints_${getExportDateStamp()}.pdf`);
    showToast("Complaint Reports PDF export has been downloaded.");
}

function getClassName(value) {
    return String(value || "none").toLowerCase().replace(/_/g, "-").replace(/\s+/g, "-");
}

function renderStats(reports) {
    document.getElementById("statOpenComplaints").textContent = String(reports.filter((report) => report.status === "open").length);
    document.getElementById("statReviewComplaints").textContent = String(reports.filter((report) => report.status === "in_review").length);
    document.getElementById("statResolvedComplaints").textContent = String(reports.filter((report) => report.status === "resolved").length);
    document.getElementById("statDismissedComplaints").textContent = String(reports.filter((report) => report.status === "dismissed").length);
}

function syncStatusFilterCards() {
    const selectedStatus = document.getElementById("complaintStatusFilter")?.value || "all";
    document.querySelectorAll(".complaint-stat-filter").forEach((card) => {
        card.classList.toggle("active", card.dataset.statusFilter === selectedStatus);
    });
}

function buildComplaintList(reports) {
    const container = document.getElementById("complaintList");
    if (!container) return;

    container.innerHTML = "";
    if (!reports.length) {
        container.innerHTML = `<div class="ticket-list-empty">No complaint reports match the current filters.</div>`;
        return;
    }

    reports.forEach((report) => {
        const item = document.createElement("div");
        const statusClass = getClassName(report.status || "open");
        const actionClass = getClassName(report.violationAction || "none");
        const location = [report.reportedTenantRoom, report.reportedTenantBed].filter(Boolean).join(", ") || report.reporterRoom || "No room specified";

        item.className = `ticket-item${complaintAdminState.selectedReportId === report.id ? " active" : ""}`;
        item.dataset.reportId = report.id;
        item.innerHTML = `
            <div class="ticket-item-top">
                <div>
                    <div class="ticket-item-subject">${escapeHtml(report.subject || "Complaint Report")}</div>
                    <div class="ticket-item-meta">${escapeHtml(report.reporterName || "Tenant")} | ${escapeHtml(location)}</div>
                </div>
                <div class="ticket-badge-row">
                    <span class="ticket-status-badge ${statusClass}">${escapeHtml(formatLabel(report.status || "open"))}</span>
                    <span class="ticket-action-badge ${actionClass}">${escapeHtml(formatLabel(report.violationAction || "none"))}</span>
                </div>
            </div>
            <div class="ticket-item-preview">${escapeHtmlWithBreaks(report.description || "No details provided.")}</div>
            <div class="ticket-item-time">Updated ${formatDate(report.updatedAt || report.createdAt)}</div>
        `;

        item.addEventListener("click", () => openComplaint(report.id));
        container.appendChild(item);
    });
}

function renderComplaintDetail(report) {
    const container = document.getElementById("complaintDetail");
    if (!container) return;

    if (!report) {
        container.innerHTML = `<div class="ticket-detail-empty">Select a report from the left to review the complaint and update its status.</div>`;
        return;
    }

    const statusClass = getClassName(report.status || "open");
    const actionClass = getClassName(report.violationAction || "none");

    container.innerHTML = `
        <div class="ticket-detail-head">
            <div>
                <div class="ticket-detail-title">${escapeHtml(report.subject || "Complaint Report")}</div>
                <div class="ticket-detail-sub">Submitted by ${escapeHtml(report.reporterName || "Tenant")} (${escapeHtml(report.reporterEmail || "No email provided")})</div>
            </div>
            <div class="ticket-detail-badges">
                <span class="ticket-status-badge ${statusClass}">${escapeHtml(formatLabel(report.status || "open"))}</span>
                <span class="ticket-action-badge ${actionClass}">${escapeHtml(formatLabel(report.violationAction || "none"))}</span>
            </div>
        </div>

        <div class="ticket-detail-grid">
            <div class="ticket-detail-field">
                <div class="ticket-detail-label">Reporter</div>
                <div class="ticket-detail-value">${escapeHtml(report.reporterName || "Tenant")}</div>
            </div>
            <div class="ticket-detail-field">
                <div class="ticket-detail-label">Reporter Room</div>
                <div class="ticket-detail-value">${escapeHtml(report.reporterRoom || "No room assigned")}</div>
            </div>
            <div class="ticket-detail-field">
                <div class="ticket-detail-label">Reported Tenant</div>
                <div class="ticket-detail-value">${escapeHtml(report.reportedTenantName || "Not specified")}</div>
            </div>
            <div class="ticket-detail-field">
                <div class="ticket-detail-label">Reported Location</div>
                <div class="ticket-detail-value">${escapeHtml([report.reportedTenantRoom, report.reportedTenantBed].filter(Boolean).join(", ") || "Not specified")}</div>
            </div>
            <div class="ticket-detail-field">
                <div class="ticket-detail-label">Category</div>
                <div class="ticket-detail-value">${escapeHtml(formatLabel(report.category || "other"))}</div>
            </div>
            <div class="ticket-detail-field">
                <div class="ticket-detail-label">Submitted</div>
                <div class="ticket-detail-value">${formatDate(report.createdAt)}</div>
            </div>
        </div>

        <div>
            <div class="ticket-detail-label">Report Details</div>
            <div class="ticket-detail-desc">${escapeHtmlWithBreaks(report.description || "No details provided.")}</div>
        </div>

        <div class="ticket-detail-grid">
            <div class="modal-field">
                <label class="modal-label" for="complaintStatusSelect">Status</label>
                <select class="modal-select" id="complaintStatusSelect">
                    <option value="open">Open</option>
                    <option value="in_review">In Review</option>
                    <option value="resolved">Resolved</option>
                    <option value="dismissed">Dismissed</option>
                </select>
            </div>
            <div class="modal-field">
                <label class="modal-label" for="complaintActionSelect">Action Taken</label>
                <select class="modal-select" id="complaintActionSelect">
                    <option value="none">No Action Yet</option>
                    <option value="verbal_warning">Verbal Warning</option>
                    <option value="memo_penalty">Memo + P200 Penalty</option>
                    <option value="termination_recommended">Ban / Termination Review</option>
                </select>
            </div>
        </div>

        <div class="modal-field">
            <label class="modal-label" for="complaintAdminNote">Admin Note</label>
            <textarea class="modal-textarea ticket-detail-note" id="complaintAdminNote" rows="5" placeholder="Add an update, evidence note, or resolution message for the reporter.">${escapeHtml(report.adminNote || "")}</textarea>
        </div>

        <div class="ticket-detail-actions">
            <button class="ticket-quick-btn" type="button" id="markReviewBtn">Mark In Review</button>
            <button class="ticket-quick-btn" type="button" id="dismissReportBtn">Dismiss</button>
            <button class="primary-btn" type="button" id="saveComplaintBtn">Save Update</button>
        </div>
    `;

    document.getElementById("complaintStatusSelect").value = report.status || "open";
    document.getElementById("complaintActionSelect").value = report.violationAction || "none";
    document.getElementById("saveComplaintBtn").addEventListener("click", async (event) => saveComplaintUpdate("", event.currentTarget));
    document.getElementById("markReviewBtn").addEventListener("click", async (event) => saveComplaintUpdate("in_review", event.currentTarget));
    document.getElementById("dismissReportBtn").addEventListener("click", async (event) => saveComplaintUpdate("dismissed", event.currentTarget));
}

function openComplaint(reportId) {
    const report = complaintAdminState.filteredReports.find((entry) => entry.id === reportId)
        || complaintAdminState.reports.find((entry) => entry.id === reportId);
    if (!report) return;

    complaintAdminState.selectedReportId = reportId;
    buildComplaintList(complaintAdminState.filteredReports);
    renderComplaintDetail(report);
}

function applyFilters() {
    const search = String(document.getElementById("complaintSearchInput")?.value || "").trim().toLowerCase();
    const status = document.getElementById("complaintStatusFilter")?.value || "all";
    const action = document.getElementById("complaintActionFilter")?.value || "all";

    complaintAdminState.filteredReports = complaintAdminState.reports.filter((report) => {
        const haystack = [
            report.reporterName,
            report.reporterEmail,
            report.reporterRoom,
            report.reportedTenantName,
            report.reportedTenantRoom,
            report.reportedTenantBed,
            report.subject,
            report.description,
            report.category
        ].join(" ").toLowerCase();

        return (!search || haystack.includes(search))
            && (status === "all" || report.status === status)
            && (action === "all" || (report.violationAction || "none") === action);
    });

    syncStatusFilterCards();
    buildComplaintList(complaintAdminState.filteredReports);

    if (!complaintAdminState.filteredReports.some((report) => report.id === complaintAdminState.selectedReportId)) {
        complaintAdminState.selectedReportId = complaintAdminState.filteredReports[0]?.id || null;
    }

    if (complaintAdminState.selectedReportId) {
        openComplaint(complaintAdminState.selectedReportId);
    } else {
        renderComplaintDetail(null);
    }
}

async function saveComplaintUpdate(forcedStatus = "", triggerButton = null) {
    const reportId = complaintAdminState.selectedReportId;
    if (!reportId) return;

    const currentReport = complaintAdminState.reports.find((report) => report.id === reportId);
    if (!currentReport) return;

    const status = forcedStatus || document.getElementById("complaintStatusSelect")?.value || currentReport.status || "open";
    const violationAction = document.getElementById("complaintActionSelect")?.value || currentReport.violationAction || "none";
    const adminNote = document.getElementById("complaintAdminNote")?.value.trim() || "";

    try {
        setAdminButtonLoading?.(triggerButton, forcedStatus ? "Updating..." : "Saving...");
        await callAdminApi("/api/complaints/admin/update", {
            complaintId: reportId,
            status,
            violationAction,
            adminNote
        });
        showToast("Complaint report updated and reporter notified.");
    } catch (error) {
        console.error("Failed to update complaint report:", error);
        showToast("Unable to update the selected complaint right now.");
    } finally {
        restoreAdminButton?.(triggerButton);
    }
}

function subscribeToComplaints() {
    if (complaintAdminState.unsubscribe) {
        complaintAdminState.unsubscribe();
        complaintAdminState.unsubscribe = null;
    }

    complaintAdminState.unsubscribe = db.collection("tenantComplaints")
        .onSnapshot((snapshot) => {
            const reports = [];
            snapshot.forEach((doc) => reports.push({ id: doc.id, ...doc.data() }));
            reports.sort((left, right) => {
                const leftDate = getReportDate(left.updatedAt || left.createdAt);
                const rightDate = getReportDate(right.updatedAt || right.createdAt);
                return (rightDate?.getTime?.() || 0) - (leftDate?.getTime?.() || 0);
            });

            complaintAdminState.reports = reports;
            renderStats(reports);
            applyFilters();
        }, (error) => {
            console.error("Failed to load complaint reports:", error);
            showToast("Unable to load complaint reports right now.");
        });
}

document.addEventListener("DOMContentLoaded", () => {
    const avatarContainer = document.querySelector(".avatar-container");
    avatarContainer?.addEventListener("click", function (event) {
        this.classList.toggle("open");
        event.stopPropagation();
    });
    document.addEventListener("click", () => avatarContainer?.classList.remove("open"));
    document.getElementById("btnLogout")?.addEventListener("click", logoutAdmin);
    document.getElementById("topbarLogoutBtn")?.addEventListener("click", logoutAdmin);
    document.getElementById("complaintSearchInput")?.addEventListener("input", applyFilters);
    document.getElementById("complaintStatusFilter")?.addEventListener("change", applyFilters);
    document.getElementById("complaintActionFilter")?.addEventListener("change", applyFilters);
    document.getElementById("downloadComplaintsPdfBtn")?.addEventListener("click", downloadComplaintsPdf);
    document.getElementById("downloadComplaintsCsvBtn")?.addEventListener("click", downloadComplaintsCsv);
    document.querySelectorAll(".complaint-stat-filter").forEach((card) => {
        card.addEventListener("click", () => {
            const statusFilter = card.dataset.statusFilter || "all";
            const statusSelect = document.getElementById("complaintStatusFilter");
            if (!statusSelect) return;
            statusSelect.value = statusSelect.value === statusFilter ? "all" : statusFilter;
            applyFilters();
        });
    });
    subscribeToComplaints();
});

requireAdminAccess();

const transientAdminState = {
    rows: [],
    filteredRows: [],
    modalRow: null
};

function formatCurrency(amount) {
    return new Intl.NumberFormat("en-PH", {
        style: "currency",
        currency: "PHP"
    }).format(Number(amount || 0));
}

function formatDate(value) {
    const date = value?.toDate?.() || new Date(`${value}T00:00:00`);
    if (Number.isNaN(date.getTime())) {
        return "Unavailable";
    }

    return new Intl.DateTimeFormat("en-PH", {
        month: "short",
        day: "numeric",
        year: "numeric"
    }).format(date);
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function getInitials(name) {
    return String(name || "TB")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part.charAt(0).toUpperCase())
        .join("") || "TB";
}

function formatStatus(status) {
    return String(status || "pending")
        .replace(/_/g, " ")
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function showToast(message) {
    const toast = document.getElementById("toast");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toast.hideTimer);
    toast.hideTimer = setTimeout(() => toast.classList.remove("show"), 3000);
}

function formatDateTime(value) {
    if (!value) {
        return "";
    }

    const date = value?.toDate?.() || new Date(value);
    if (Number.isNaN(date.getTime())) {
        return "";
    }

    return new Intl.DateTimeFormat("en-PH", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit"
    }).format(date);
}

function escapeTransientCsv(value) {
    const text = String(value ?? "");
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadTransientTextFile(filename, content, type = "text/csv;charset=utf-8") {
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

function getTransientExportDateStamp() {
    return new Date().toISOString().slice(0, 10);
}

function getVisibleTransientRows() {
    return transientAdminState.filteredRows.length || transientAdminState.rows.length
        ? transientAdminState.filteredRows
        : [];
}

function downloadTransientCsv() {
    const rows = getVisibleTransientRows();
    if (!rows.length) {
        showToast("There are no Transient Bed requests to export using the current filters.");
        return;
    }

    const headers = [
        "Reference ID",
        "Guest",
        "Email",
        "Phone",
        "Gender",
        "Check-in",
        "Check-out",
        "Nights",
        "Room",
        "Bed",
        "Room Type",
        "Rate Per Day",
        "Total Amount",
        "Payment Status",
        "Status",
        "Applicant Type",
        "Emergency Contact",
        "Emergency Phone",
        "Reason",
        "Created At",
        "Record ID"
    ];

    const lines = [
        headers.map(escapeTransientCsv).join(","),
        ...rows.map((row) => [
            row.referenceId || "",
            row.fullName || "Guest",
            row.email || "",
            row.phone || "",
            row.gender || "",
            formatDate(row.checkInDate),
            formatDate(row.checkOutDate),
            row.nights || 0,
            row.room || "",
            row.bed || "",
            row.roomType || "",
            Number(row.ratePerDay || 0).toFixed(2),
            Number(row.totalAmount || 0).toFixed(2),
            formatStatus(row.paymentStatus || "unpaid"),
            formatStatus(row.status),
            String(row.applicantType || "").replace("type-", ""),
            row.emergencyName || "",
            row.emergencyPhone || "",
            row.reason || "",
            formatDateTime(row.createdAt),
            row.id || ""
        ].map(escapeTransientCsv).join(","))
    ];

    downloadTransientTextFile(`citihub_transient_beds_${getTransientExportDateStamp()}.csv`, lines.join("\n"));
    showToast("Transient Beds CSV export has been downloaded.");
}

function downloadTransientPdf() {
    const rows = getVisibleTransientRows();
    if (!rows.length) {
        showToast("There are no Transient Bed requests to export using the current filters.");
        return;
    }

    if (!window.jspdf?.jsPDF) {
        const content = [
            "CITIHUB DORMITORY - TRANSIENT BEDS REPORT",
            "=".repeat(48),
            `Generated: ${new Date().toLocaleString()}`,
            `Requests included: ${rows.length}`,
            "",
            ...rows.map((row) => `${row.fullName || "Guest"} | ${formatDate(row.checkInDate)} - ${formatDate(row.checkOutDate)} | Room ${row.room || ""}, Bed ${row.bed || ""} | ${formatCurrency(row.totalAmount)} | ${formatStatus(row.paymentStatus || "unpaid")} | ${formatStatus(row.status)}`)
        ].join("\n");
        downloadTransientTextFile(`citihub_transient_beds_${getTransientExportDateStamp()}.txt`, content, "text/plain;charset=utf-8");
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

    const paidRevenue = rows
        .filter((row) => row.paymentStatus === "paid")
        .reduce((sum, row) => sum + Number(row.totalAmount || 0), 0);

    pdf.setFillColor(26, 122, 74);
    pdf.rect(0, 0, pageWidth, 28, "F");
    pdf.setTextColor(255, 255, 255);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(16);
    pdf.text("CITIHUB DORMITORY", 14, 13);
    pdf.setFontSize(10);
    pdf.setFont("helvetica", "normal");
    pdf.text("Transient Beds Report", 14, 21);
    pdf.setTextColor(26, 26, 46);

    pdf.setFontSize(10);
    pdf.text(`Generated: ${new Date().toLocaleString()}`, 14, y); y += 8;
    pdf.text(`Requests included: ${rows.length}   Paid revenue: ${formatCurrency(paidRevenue)}`, 14, y); y += 12;

    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(9);
    pdf.text("Guest", 14, y);
    pdf.text("Stay", 70, y);
    pdf.text("Bedspace", 128, y);
    pdf.text("Amount", 174, y);
    pdf.text("Payment", 212, y);
    pdf.text("Status", 248, y);
    y += 5;
    pdf.setDrawColor(229, 231, 235);
    pdf.line(14, y, pageWidth - 14, y);
    y += 7;
    pdf.setFont("helvetica", "normal");

    rows.forEach((row) => {
        ensureSpace();
        pdf.text(String(row.fullName || "Guest").slice(0, 28), 14, y);
        pdf.text(`${formatDate(row.checkInDate)} - ${formatDate(row.checkOutDate)}`.slice(0, 28), 70, y);
        pdf.text(`R${row.room || ""} B${row.bed || ""} ${row.roomType || ""}`.slice(0, 22), 128, y);
        pdf.text(formatCurrency(row.totalAmount).slice(0, 18), 174, y);
        pdf.text(formatStatus(row.paymentStatus || "unpaid").slice(0, 16), 212, y);
        pdf.text(formatStatus(row.status).slice(0, 20), 248, y);
        y += 7;
    });

    pdf.setFontSize(8);
    pdf.setTextColor(107, 114, 128);
    pdf.text("Generated by CitiHub Admin Transient Beds", 14, pageHeight - 8);
    pdf.save(`citihub_transient_beds_${getTransientExportDateStamp()}.pdf`);
    showToast("Transient Beds PDF report has been downloaded.");
}

function updateStats(rows) {
    document.getElementById("statPending").textContent = String(rows.filter((row) => row.status === "pending").length);
    document.getElementById("statApproved").textContent = String(rows.filter((row) => row.status === "approved").length);
    document.getElementById("statCheckedIn").textContent = String(rows.filter((row) => row.status === "checked_in").length);
    document.getElementById("statRevenue").textContent = formatCurrency(
        rows
            .filter((row) => row.paymentStatus === "paid")
            .reduce((sum, row) => sum + Number(row.totalAmount || 0), 0)
    );
}

function getActions(row) {
    const viewButton = `<button class="tbl-btn" data-action="view" data-id="${row.id}">View</button>`;

    if (row.status === "pending") {
        return `
            ${viewButton}
            <button class="tbl-btn" data-action="approve" data-id="${row.id}">Approve</button>
            <button class="tbl-btn danger" data-action="reject" data-id="${row.id}">Reject</button>
        `;
    }

    if (row.status === "approved") {
        if (row.paymentStatus !== "paid") {
            return `
                ${viewButton}
                <span class="transient-sub">Waiting for payment</span>
                <button class="tbl-btn danger" data-action="cancelled" data-id="${row.id}">Cancel</button>
            `;
        }

        return `
            ${viewButton}
            <button class="tbl-btn" data-action="checked_in" data-id="${row.id}">Check In</button>
            <button class="tbl-btn danger" data-action="cancelled" data-id="${row.id}">Cancel</button>
        `;
    }

    if (row.status === "checked_in") {
        return `
            ${viewButton}
            <button class="tbl-btn" data-action="checked_out" data-id="${row.id}">Check Out</button>
        `;
    }

    if (row.status === "pending_payment") {
        return `
            ${viewButton}
            <span class="transient-sub">Waiting for payment</span>
        `;
    }

    if (row.status === "cancelled") {
        return `
            ${viewButton}
            <button class="tbl-btn danger" data-action="delete" data-id="${row.id}">Delete</button>
        `;
    }

    return `
        ${viewButton}
        <span class="transient-sub">No action</span>
    `;
}

function renderTable(rows) {
    const body = document.getElementById("transientTableBody");
    if (!body) return;

    if (!rows.length) {
        body.innerHTML = `<tr><td colspan="7">No Transient Bed requests found.</td></tr>`;
        return;
    }

    body.innerHTML = rows.map((row) => `
        <tr>
            <td>
                <div class="td-name">${escapeHtml(row.fullName || "Guest")}</div>
                <div class="td-email">${escapeHtml(row.email || "No email")}</div>
            </td>
            <td>
                <div class="transient-stay">${formatDate(row.checkInDate)} - ${formatDate(row.checkOutDate)}</div>
                <div class="transient-sub">${row.nights || 0} ${Number(row.nights) === 1 ? "day" : "days"} - ${escapeHtml(row.referenceId || row.id)}</div>
            </td>
            <td>
                <span class="room-type-tag ${row.roomType === "premium" ? "teal" : "green"}">${escapeHtml(row.roomType || "standard")}</span>
                <div class="transient-sub">Room ${escapeHtml(row.room || "")}, Bed ${escapeHtml(row.bed || "")}</div>
            </td>
            <td>
                <div class="td-amount">${formatCurrency(row.totalAmount)}</div>
                <div class="transient-sub">${formatCurrency(row.ratePerDay)}/day</div>
            </td>
            <td>${escapeHtml(formatStatus(row.paymentStatus || "unpaid"))}</td>
            <td><span class="status-pill ${escapeHtml(row.status || "pending")}">${escapeHtml(formatStatus(row.status))}</span></td>
            <td><div class="transient-actions">${getActions(row)}</div></td>
        </tr>
    `).join("");

    body.querySelectorAll("button[data-action]").forEach((button) => {
        button.addEventListener("click", async () => {
            await handleTransientAction(button.dataset.id, button.dataset.action, button);
        });
    });
}

function applyFilters() {
    const query = String(document.getElementById("transientSearch")?.value || "").toLowerCase().trim();
    const status = document.getElementById("transientStatusFilter")?.value || "all";

    transientAdminState.filteredRows = transientAdminState.rows.filter((row) => {
        const haystack = [
            row.fullName,
            row.email,
            row.room,
            row.bed,
            row.referenceId,
            row.roomType
        ].join(" ").toLowerCase();

        const matchesQuery = !query || haystack.includes(query);
        const matchesStatus = status === "all" || row.status === status;
        return matchesQuery && matchesStatus;
    });

    renderTable(transientAdminState.filteredRows);
}

async function handleTransientAction(id, action, button) {
    if (!id || !action) return;

    if (action === "view") {
        const row = transientAdminState.rows.find((item) => item.id === id);
        if (row) {
            openTransientModal(row);
        }
        return;
    }

    if (action === "delete") {
        const row = transientAdminState.rows.find((item) => item.id === id);
        const confirmed = await confirmTransientDelete(
            `Delete cancelled Transient Bed request ${row?.referenceId || id} permanently? This will also remove the uploaded documents and cannot be undone.`
        );
        if (!confirmed) return;

        try {
            setAdminButtonLoading?.(button, "Deleting...");
            await callAdminApi("/api/transient-beds/admin/delete", { bookingId: id });
            showToast("Cancelled Transient Bed request was deleted permanently.");
            closeTransientModal();
        } catch (error) {
            console.error("Transient Bed permanent delete failed:", error);
            showToast(error.message || "Unable to delete Transient Bed request.");
        } finally {
            restoreAdminButton?.(button);
        }
        return;
    }

    let reason = "";
    if (action === "cancelled" || action === "reject") {
        reason = prompt(action === "reject" ? "Reason for rejecting this Transient Bed request:" : "Reason for cancelling this Transient Bed booking:");
        if (!reason) return;
    }

    try {
        setAdminButtonLoading?.(button, "Saving...");
        if (action === "approve") {
            await callAdminApi("/api/transient-beds/admin/approve", { bookingId: id });
        } else {
            await callAdminApi("/api/transient-beds/admin/status", {
                bookingId: id,
                status: action === "reject" ? "rejected" : action,
                reason
            });
        }
        showToast("Transient Bed updated successfully.");
        closeTransientModal();
    } catch (error) {
        console.error("Transient Bed action failed:", error);
        showToast(error.message || "Unable to update Transient Bed request.");
    } finally {
        restoreAdminButton?.(button);
    }
}

function createDetailItem(label, value) {
    return `
        <div class="transient-detail-item">
            <div class="transient-detail-label">${escapeHtml(label)}</div>
            <div class="transient-detail-value">${escapeHtml(value || "Not provided")}</div>
        </div>
    `;
}

function renderTransientDocuments(documents = []) {
    const list = document.getElementById("transientModalDocuments");
    if (!list) return;

    if (!documents.length) {
        list.innerHTML = `<div class="transient-sub">No uploaded documents were attached to this request.</div>`;
        return;
    }

    list.innerHTML = documents.map((doc) => {
        const files = Array.isArray(doc.files) ? doc.files : [];
        const fileLinks = files.length
            ? files.map((file) => `
                <a class="transient-doc-link" href="${escapeHtml(file.url || "#")}" target="_blank" rel="noopener noreferrer">
                    ${escapeHtml(file.name || "Open file")}
                </a>
            `).join("")
            : `<span class="transient-sub">No files uploaded.</span>`;

        return `
            <div class="transient-doc-card">
                <div class="transient-doc-title">${escapeHtml(doc.label || "Document")}</div>
                <div class="transient-doc-files">${fileLinks}</div>
            </div>
        `;
    }).join("");
}

function getTransientModalFooter(row) {
    const closeButton = `<button type="button" class="tbl-btn" onclick="closeTransientModal()">Close</button>`;
    if (row.status === "pending") {
        return `
            ${closeButton}
            <button type="button" class="tbl-btn danger" data-modal-action="reject" data-id="${row.id}">Reject</button>
            <button type="button" class="tbl-btn" data-modal-action="approve" data-id="${row.id}">Approve</button>
        `;
    }

    if (row.status === "approved") {
        const checkInButton = row.paymentStatus === "paid"
            ? `<button type="button" class="tbl-btn" data-modal-action="checked_in" data-id="${row.id}">Check In</button>`
            : `<span class="transient-sub">Waiting for payment</span>`;
        return `
            ${closeButton}
            <button type="button" class="tbl-btn danger" data-modal-action="cancelled" data-id="${row.id}">Cancel</button>
            ${checkInButton}
        `;
    }

    if (row.status === "checked_in") {
        return `
            ${closeButton}
            <button type="button" class="tbl-btn" data-modal-action="checked_out" data-id="${row.id}">Check Out</button>
        `;
    }

    if (row.status === "cancelled") {
        return `
            ${closeButton}
            <button type="button" class="tbl-btn danger" data-modal-action="delete" data-id="${row.id}">Delete Permanently</button>
        `;
    }

    return closeButton;
}

function confirmTransientDelete(message) {
    const overlay = document.getElementById("transientDeleteConfirm");
    const text = document.getElementById("transientConfirmText");
    const cancelBtn = document.getElementById("transientConfirmCancel");
    const deleteBtn = document.getElementById("transientConfirmDelete");

    if (!overlay || !text || !cancelBtn || !deleteBtn) {
        return Promise.resolve(window.confirm(message));
    }

    text.textContent = message;
    overlay.classList.add("open");

    return new Promise((resolve) => {
        const close = (result) => {
            overlay.classList.remove("open");
            cancelBtn.removeEventListener("click", handleCancel);
            deleteBtn.removeEventListener("click", handleDelete);
            overlay.removeEventListener("click", handleOverlay);
            document.removeEventListener("keydown", handleKeydown);
            resolve(result);
        };

        const handleCancel = () => close(false);
        const handleDelete = () => close(true);
        const handleOverlay = (event) => {
            if (event.target === overlay) {
                close(false);
            }
        };
        const handleKeydown = (event) => {
            if (event.key === "Escape") {
                close(false);
            }
        };

        cancelBtn.addEventListener("click", handleCancel);
        deleteBtn.addEventListener("click", handleDelete);
        overlay.addEventListener("click", handleOverlay);
        document.addEventListener("keydown", handleKeydown);
    });
}

function openTransientModal(row) {
    transientAdminState.modalRow = row;
    document.getElementById("transientModalRef").textContent = row.referenceId || row.id;
    document.getElementById("transientModalAvatar").textContent = getInitials(row.fullName || row.email);
    document.getElementById("transientModalName").textContent = row.fullName || "Guest";
    document.getElementById("transientModalEmail").textContent = row.email || "No email";

    const status = document.getElementById("transientModalStatus");
    if (status) {
        status.className = `status-pill ${row.status || "pending"}`;
        status.textContent = formatStatus(row.status);
    }

    const details = document.getElementById("transientModalDetails");
    if (details) {
        details.innerHTML = [
            createDetailItem("Stay Dates", `${formatDate(row.checkInDate)} - ${formatDate(row.checkOutDate)}`),
            createDetailItem("Total Stay", `${row.nights || 0} ${Number(row.nights) === 1 ? "day" : "days"}`),
            createDetailItem("Bedspace", `Room ${row.room || ""}, Bed ${row.bed || ""}`),
            createDetailItem("Room Type", formatStatus(row.roomType || "standard")),
            createDetailItem("Daily Rate", formatCurrency(row.ratePerDay)),
            createDetailItem("Total Amount", formatCurrency(row.totalAmount)),
            createDetailItem("Payment Status", formatStatus(row.paymentStatus || "unpaid")),
            createDetailItem("Phone", row.phone || ""),
            createDetailItem("Gender", row.gender || ""),
            createDetailItem("Birth Date", row.birthDate || ""),
            createDetailItem("Address", row.address || ""),
            createDetailItem("Applicant Type", String(row.applicantType || "").replace("type-", "")),
            createDetailItem("Emergency Contact", row.emergencyName || ""),
            createDetailItem("Relationship", row.relationship || ""),
            createDetailItem("Emergency Phone", row.emergencyPhone || ""),
            createDetailItem("Alternative Number", row.emergencyAlt || ""),
            createDetailItem("Emergency Address", row.emergencyAddress || "")
        ].join("");
    }

    renderTransientDocuments(row.documents || []);

    const reasonBlock = document.getElementById("transientModalReasonBlock");
    const reasonText = document.getElementById("transientModalReason");
    if (reasonBlock && reasonText) {
        const reason = String(row.reason || "").trim();
        reasonBlock.style.display = reason ? "block" : "none";
        reasonText.textContent = reason;
    }

    const footer = document.getElementById("transientModalFooter");
    if (footer) {
        footer.innerHTML = getTransientModalFooter(row);
        footer.querySelectorAll("[data-modal-action]").forEach((button) => {
            button.addEventListener("click", () => handleTransientAction(button.dataset.id, button.dataset.modalAction, button));
        });
    }

    document.getElementById("transientViewModal")?.classList.add("open");
    document.body.style.overflow = "hidden";
}

function closeTransientModal() {
    transientAdminState.modalRow = null;
    document.getElementById("transientViewModal")?.classList.remove("open");
    document.body.style.overflow = "";
}

function handleTransientModalOverlay(event) {
    if (event.target === document.getElementById("transientViewModal")) {
        closeTransientModal();
    }
}

window.closeTransientModal = closeTransientModal;
window.handleTransientModalOverlay = handleTransientModalOverlay;

function subscribeTransientBeds() {
    db.collection("transientBedBookings")
        .onSnapshot((snapshot) => {
            transientAdminState.rows = snapshot.docs
                .map((doc) => ({ id: doc.id, ...doc.data() }))
                .sort((left, right) => {
                    const leftDate = left.createdAt?.toDate?.() || new Date(0);
                    const rightDate = right.createdAt?.toDate?.() || new Date(0);
                    return rightDate - leftDate;
                });

            updateStats(transientAdminState.rows);
            applyFilters();
        }, (error) => {
            console.error("Failed to load Transient Bed requests:", error);
            showToast("Unable to load Transient Bed requests.");
        });
}

function bindChrome() {
    const avatarContainer = document.querySelector(".avatar-container");
    avatarContainer?.addEventListener("click", function (event) {
        this.classList.toggle("open");
        event.stopPropagation();
    });
    document.addEventListener("click", () => avatarContainer?.classList.remove("open"));
    document.getElementById("btnLogout")?.addEventListener("click", logoutAdmin);
    document.getElementById("topbarLogoutBtn")?.addEventListener("click", logoutAdmin);
}

document.addEventListener("DOMContentLoaded", () => {
    bindChrome();
    document.getElementById("transientSearch")?.addEventListener("input", applyFilters);
    document.getElementById("transientStatusFilter")?.addEventListener("change", applyFilters);
    document.getElementById("downloadTransientPdfBtn")?.addEventListener("click", downloadTransientPdf);
    document.getElementById("downloadTransientCsvBtn")?.addEventListener("click", downloadTransientCsv);
    subscribeTransientBeds();
});

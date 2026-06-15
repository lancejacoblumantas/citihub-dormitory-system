requireAdminAccess();

const transferAdminState = {
    rows: [],
    filteredRows: []
};

function formatCurrency(amount) {
    return new Intl.NumberFormat("en-PH", {
        style: "currency",
        currency: "PHP"
    }).format(Number(amount || 0));
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function formatStatus(status) {
    return String(status || "pending_admin")
        .replace(/_/g, " ")
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function showTransferToast(message) {
    if (typeof showToast === "function") {
        showToast(message);
        return;
    }

    const toast = document.getElementById("toast");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 3000);
}

function formatTransferDate(value) {
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

function escapeTransferCsv(value) {
    const text = String(value ?? "");
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadTransferTextFile(filename, content, type = "text/csv;charset=utf-8") {
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

function getTransferExportDateStamp() {
    return new Date().toISOString().slice(0, 10);
}

function getVisibleTransferRows() {
    return transferAdminState.filteredRows.length || transferAdminState.rows.length
        ? transferAdminState.filteredRows
        : [];
}

function downloadTransferCsv() {
    const rows = getVisibleTransferRows();
    if (!rows.length) {
        showTransferToast("There are no transfer requests to export using the current filters.");
        return;
    }

    const headers = [
        "Reference ID",
        "Tenant",
        "Email",
        "Current Room",
        "Current Bed",
        "Current Type",
        "Current Monthly Rate",
        "Target Room",
        "Target Bed",
        "Target Type",
        "Target Monthly Rate",
        "Transfer Kind",
        "Fee Amount",
        "Status",
        "Payment ID",
        "Admin Note",
        "Created At",
        "Completed At",
        "Record ID"
    ];

    const lines = [
        headers.map(escapeTransferCsv).join(","),
        ...rows.map((row) => [
            row.referenceId || "",
            row.tenantName || "Tenant",
            row.tenantEmail || "",
            row.currentRoom || "",
            row.currentBed || "",
            row.currentType || "",
            Number(row.currentMonthlyRate || 0).toFixed(2),
            row.targetRoom || "",
            row.targetBed || "",
            row.targetType || "",
            Number(row.targetMonthlyRate || 0).toFixed(2),
            row.transferKind || "",
            Number(row.feeAmount || 0).toFixed(2),
            formatStatus(row.status),
            row.paymentId || row.transferPaymentId || "",
            row.adminNote || row.rejectionReason || row.expirationReason || "",
            formatTransferDate(row.createdAt),
            formatTransferDate(row.completedAt),
            row.id || ""
        ].map(escapeTransferCsv).join(","))
    ];

    downloadTransferTextFile(`citihub_transfer_requests_${getTransferExportDateStamp()}.csv`, lines.join("\n"));
    showTransferToast("Transfer Requests CSV export has been downloaded.");
}

function downloadTransferPdf() {
    const rows = getVisibleTransferRows();
    if (!rows.length) {
        showTransferToast("There are no transfer requests to export using the current filters.");
        return;
    }

    if (!window.jspdf?.jsPDF) {
        const content = [
            "CITIHUB DORMITORY - TRANSFER REQUESTS REPORT",
            "=".repeat(54),
            `Generated: ${new Date().toLocaleString()}`,
            `Requests included: ${rows.length}`,
            "",
            ...rows.map((row) => `${row.tenantName || "Tenant"} | Room ${row.currentRoom || ""}, Bed ${row.currentBed || ""} -> Room ${row.targetRoom || ""}, Bed ${row.targetBed || ""} | ${formatCurrency(row.feeAmount)} | ${formatStatus(row.status)}`)
        ].join("\n");
        downloadTransferTextFile(`citihub_transfer_requests_${getTransferExportDateStamp()}.txt`, content, "text/plain;charset=utf-8");
        showTransferToast("PDF generator was unavailable, so a text report was downloaded.");
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

    pdf.setFillColor(26, 122, 74);
    pdf.rect(0, 0, pageWidth, 28, "F");
    pdf.setTextColor(255, 255, 255);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(16);
    pdf.text("CITIHUB DORMITORY", 14, 13);
    pdf.setFontSize(10);
    pdf.setFont("helvetica", "normal");
    pdf.text("Transfer Requests Report", 14, 21);
    pdf.setTextColor(26, 26, 46);

    pdf.setFontSize(10);
    pdf.text(`Generated: ${new Date().toLocaleString()}`, 14, y); y += 8;
    pdf.text(`Requests included: ${rows.length}`, 14, y); y += 12;

    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(9);
    pdf.text("Tenant", 14, y);
    pdf.text("Current", 72, y);
    pdf.text("Target", 122, y);
    pdf.text("Fee", 172, y);
    pdf.text("Kind", 208, y);
    pdf.text("Status", 242, y);
    y += 5;
    pdf.setDrawColor(229, 231, 235);
    pdf.line(14, y, pageWidth - 14, y);
    y += 7;
    pdf.setFont("helvetica", "normal");

    rows.forEach((row) => {
        ensureSpace();
        pdf.text(String(row.tenantName || "Tenant").slice(0, 28), 14, y);
        pdf.text(`R${row.currentRoom || ""} B${row.currentBed || ""}`.slice(0, 20), 72, y);
        pdf.text(`R${row.targetRoom || ""} B${row.targetBed || ""}`.slice(0, 20), 122, y);
        pdf.text(formatCurrency(row.feeAmount).slice(0, 16), 172, y);
        pdf.text(String(row.transferKind || "").slice(0, 16), 208, y);
        pdf.text(formatStatus(row.status).slice(0, 24), 242, y);
        y += 7;
    });

    pdf.setFontSize(8);
    pdf.setTextColor(107, 114, 128);
    pdf.text("Generated by CitiHub Admin Transfer Requests", 14, pageHeight - 8);
    pdf.save(`citihub_transfer_requests_${getTransferExportDateStamp()}.pdf`);
    showTransferToast("Transfer Requests PDF report has been downloaded.");
}

function updateStats(rows) {
    document.getElementById("transferStatPending").textContent = String(rows.filter((row) => row.status === "pending_admin").length);
    document.getElementById("transferStatPayment").textContent = String(rows.filter((row) => row.status === "approved_pending_payment").length);
    document.getElementById("transferStatCompleted").textContent = String(rows.filter((row) => row.status === "completed").length);
}

function getActions(row) {
    if (row.status === "pending_admin") {
        return `
            <button class="tbl-btn" data-action="approve" data-id="${row.id}">Approve</button>
            <button class="tbl-btn danger" data-action="reject" data-id="${row.id}">Reject</button>
        `;
    }

    if (row.status === "approved_pending_payment") {
        return `<span class="transfer-sub">Waiting for tenant payment</span>`;
    }

    if (row.status === "completed") {
        return `<span class="transfer-sub">Transfer completed</span>`;
    }

    if (row.status === "rejected") {
        return `<button class="tbl-btn danger" data-action="delete" data-id="${row.id}">Delete Permanently</button>`;
    }

    if (row.status === "expired") {
        return `<span class="transfer-sub">${escapeHtml(row.expirationReason || "Payment window expired")}</span>`;
    }

    return `<span class="transfer-sub">No action</span>`;
}

function renderTable(rows) {
    const body = document.getElementById("transferTableBody");
    if (!body) return;

    if (!rows.length) {
        body.innerHTML = `<tr><td colspan="6">No transfer requests found.</td></tr>`;
        return;
    }

    body.innerHTML = rows.map((row) => `
        <tr>
            <td>
                <div class="td-name">${escapeHtml(row.tenantName || "Tenant")}</div>
                <div class="td-email">${escapeHtml(row.tenantEmail || "No email")}</div>
            </td>
            <td>
                <div class="transfer-route">Room ${escapeHtml(row.currentRoom)}, Bed ${escapeHtml(row.currentBed)}</div>
                <div class="transfer-sub">${escapeHtml(row.currentType || "standard")} - ${formatCurrency(row.currentMonthlyRate)}/mo</div>
            </td>
            <td>
                <div class="transfer-route">Room ${escapeHtml(row.targetRoom)}, Bed ${escapeHtml(row.targetBed)}</div>
                <div class="transfer-sub">${escapeHtml(row.targetType || "standard")} - ${formatCurrency(row.targetMonthlyRate)}/mo</div>
            </td>
            <td>
                <div class="td-amount">${formatCurrency(row.feeAmount)}</div>
                <div class="transfer-sub">${row.transferKind === "upgrade" ? "Upgrade fee" : "Same type transfer"}</div>
            </td>
            <td><span class="status-pill ${escapeHtml(row.status || "pending_admin")}">${escapeHtml(formatStatus(row.status))}</span></td>
            <td><div class="transfer-actions">${getActions(row)}</div></td>
        </tr>
    `).join("");

    body.querySelectorAll("button[data-action]").forEach((button) => {
        button.addEventListener("click", async () => {
            await handleTransferAction(button.dataset.id, button.dataset.action, button);
        });
    });
}

function applyFilters() {
    const query = String(document.getElementById("transferSearch")?.value || "").trim().toLowerCase();
    const status = document.getElementById("transferStatusFilter")?.value || "all";

    transferAdminState.filteredRows = transferAdminState.rows.filter((row) => {
        const haystack = [
            row.tenantName,
            row.tenantEmail,
            row.currentRoom,
            row.currentBed,
            row.targetRoom,
            row.targetBed,
            row.status
        ].join(" ").toLowerCase();

        return (!query || haystack.includes(query)) && (status === "all" || row.status === status);
    });

    renderTable(transferAdminState.filteredRows);
}

async function handleTransferAction(id, action, button) {
    if (!id || !action) return;

    try {
        if (action === "delete") {
            await deleteTransferPermanently(id, button);
            return;
        }

        setAdminButtonLoading?.(button, "Saving...");
        if (action === "approve") {
            await callAdminApi("/api/transfers/admin/approve", { transferRequestId: id });
            showTransferToast("Transfer request approved. Tenant can now pay the fee.");
            await loadTransfers();
        } else if (action === "reject") {
            const adminNote = prompt("Reason for rejecting this transfer request:");
            if (!adminNote) return;
            await callAdminApi("/api/transfers/admin/reject", { transferRequestId: id, adminNote });
            showTransferToast("Transfer request rejected.");
            await loadTransfers();
        }
    } catch (error) {
        console.error("Transfer action failed:", error);
        showTransferToast(error.message || "Unable to update transfer request.");
    } finally {
        restoreAdminButton?.(button);
    }
}

function confirmTransferDelete(row) {
    const overlay = document.getElementById("transferDeleteConfirm");
    const text = document.getElementById("transferConfirmText");
    const checkbox = document.getElementById("transferConfirmDeleteInvoices");
    const cancelBtn = document.getElementById("transferConfirmCancel");
    const deleteBtn = document.getElementById("transferConfirmDelete");

    const message = `Delete this rejected transfer request for ${row?.tenantName || "this tenant"} permanently? This cannot be undone.`;
    if (!overlay || !text || !checkbox || !cancelBtn || !deleteBtn) {
        const confirmed = window.confirm(message);
        return Promise.resolve({ confirmed, deleteBillingInvoices: false });
    }

    text.textContent = message;
    checkbox.checked = false;
    overlay.classList.add("open");

    return new Promise((resolve) => {
        const close = (confirmed) => {
            const deleteBillingInvoices = confirmed && checkbox.checked;
            overlay.classList.remove("open");
            cancelBtn.removeEventListener("click", handleCancel);
            deleteBtn.removeEventListener("click", handleDelete);
            overlay.removeEventListener("click", handleOverlay);
            document.removeEventListener("keydown", handleKeydown);
            checkbox.checked = false;
            resolve({ confirmed, deleteBillingInvoices });
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
        deleteBtn.focus();
    });
}

async function deleteTransferPermanently(id, button) {
    const row = transferAdminState.rows.find((item) => item.id === id);
    const choice = await confirmTransferDelete(row);
    if (!choice.confirmed) {
        return;
    }

    try {
        setAdminButtonLoading?.(button, "Deleting...");
        const result = await callAdminApi("/api/transfers/admin/delete", {
            transferRequestId: id,
            deleteBillingInvoices: choice.deleteBillingInvoices
        });
        showTransferToast(result.deletedBillingInvoices
            ? `Transfer request and ${result.deletedBillingInvoices} billing invoice(s) were deleted permanently.`
            : "Transfer request was deleted permanently.");
        await loadTransfers();
    } catch (error) {
        console.error("Permanent transfer delete failed:", error);
        showTransferToast(error.message || "Unable to delete transfer request.");
    } finally {
        restoreAdminButton?.(button);
    }
}

async function loadTransfers() {
    try {
        const result = await callAdminApi("/api/transfers/admin/list", {});
        transferAdminState.rows = Array.isArray(result.transfers) ? result.transfers : [];
        updateStats(transferAdminState.rows);
        applyFilters();
    } catch (error) {
        console.error("Failed to load transfer requests:", error);
        const body = document.getElementById("transferTableBody");
        if (body) {
            body.innerHTML = `<tr><td colspan="6">Unable to load transfer requests right now.</td></tr>`;
        }
    } finally {
        window.hidePageLoader?.();
    }
}

document.addEventListener("DOMContentLoaded", async () => {
    const adminData = await requireAdminAccess();
    if (!adminData) return;

    document.getElementById("transferSearch")?.addEventListener("input", applyFilters);
    document.getElementById("transferStatusFilter")?.addEventListener("change", applyFilters);
    document.getElementById("downloadTransferPdfBtn")?.addEventListener("click", downloadTransferPdf);
    document.getElementById("downloadTransferCsvBtn")?.addEventListener("click", downloadTransferCsv);
    await loadTransfers();

    document.querySelectorAll("#btnLogout").forEach((button) => {
        button.addEventListener("click", logoutAdmin);
    });
});

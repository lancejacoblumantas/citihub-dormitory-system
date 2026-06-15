requireAdminAccess();

const historyState = {
    records: [],
    selectedAction: "all"
};

document.querySelector(".avatar-container").addEventListener("click", function (e) {
    this.classList.toggle("open");
    e.stopPropagation();
});

document.addEventListener("click", () => {
    document.querySelector(".avatar-container").classList.remove("open");
});

function formatHistoryDate(timestamp) {
    if (!timestamp) {
        return "N/A";
    }

    const date = typeof timestamp.toDate === "function" ? timestamp.toDate() : new Date(timestamp);
    if (Number.isNaN(date.getTime())) {
        return "N/A";
    }

    return date.toLocaleString();
}

function formatActionLabel(action) {
    return String(action || "unknown_action")
        .replace(/_/g, " ")
        .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatModuleLabel(moduleName) {
    return String(moduleName || "System")
        .replace(/[_-]/g, " ")
        .replace(/\b\w/g, (char) => char.toUpperCase());
}

function getActionTone(action) {
    const value = String(action || "").toLowerCase();

    if (/(approve|paid|create|send|resolve|complete|check_in)/.test(value)) {
        return "success";
    }

    if (/(reject|cancel|delete|terminate|block|remove)/.test(value)) {
        return "danger";
    }

    if (/(maintenance|update|edit|mark|bulk|assign|status)/.test(value)) {
        return "warning";
    }

    if (/(message|announcement|history|read|log)/.test(value)) {
        return "info";
    }

    return "neutral";
}

function getModuleTone(moduleName) {
    const value = String(moduleName || "").toLowerCase();

    if (value.includes("booking")) return "booking";
    if (value.includes("payment") || value.includes("billing")) return "payment";
    if (value.includes("room") || value.includes("maintenance")) return "room";
    if (value.includes("complaint")) return "complaint";
    if (value.includes("message") || value.includes("announcement")) return "message";
    return "system";
}

function escapeHistoryText(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function escapeHistoryCsv(value) {
    const text = String(value ?? "");
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadHistoryTextFile(filename, content, type = "text/csv;charset=utf-8") {
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

function getHistoryExportDateStamp() {
    return new Date().toISOString().slice(0, 10);
}

function showHistoryNotice(message) {
    if (typeof showFormalAlert === "function") {
        showFormalAlert(message);
        return;
    }

    window.alert(message);
}

function downloadHistoryCsv() {
    const records = getFilteredHistoryRecords();
    if (!records.length) {
        showHistoryNotice("There are no admin history records to export using the current filter.");
        return;
    }

    const headers = ["Admin", "Admin ID", "Module", "Action", "Target", "Details", "Date & Time", "Record ID"];
    const lines = [
        headers.map(escapeHistoryCsv).join(","),
        ...records.map((record) => {
            const data = record.data || {};
            return [
                data.adminName || "Admin",
                data.adminId || data.adminUid || "",
                formatModuleLabel(data.module),
                formatActionLabel(data.action),
                data.targetName || data.targetId || "N/A",
                data.details || "No details recorded.",
                formatHistoryDate(data.createdAt),
                record.id
            ].map(escapeHistoryCsv).join(",");
        })
    ];

    downloadHistoryTextFile(`citihub_admin_history_${getHistoryExportDateStamp()}.csv`, lines.join("\n"));
    showHistoryNotice("Admin History CSV export has been downloaded.");
}

function downloadHistoryPdf() {
    const records = getFilteredHistoryRecords();
    if (!records.length) {
        showHistoryNotice("There are no admin history records to export using the current filter.");
        return;
    }

    if (!window.jspdf?.jsPDF) {
        const content = [
            "CITIHUB DORMITORY - ADMIN HISTORY REPORT",
            "=".repeat(50),
            `Generated: ${new Date().toLocaleString()}`,
            `Records included: ${records.length}`,
            "",
            ...records.map((record) => {
                const data = record.data || {};
                return `${formatHistoryDate(data.createdAt)} | ${data.adminName || "Admin"} | ${formatModuleLabel(data.module)} | ${formatActionLabel(data.action)} | ${data.targetName || data.targetId || "N/A"} | ${data.details || "No details recorded."}`;
            })
        ].join("\n");
        downloadHistoryTextFile(`citihub_admin_history_${getHistoryExportDateStamp()}.txt`, content, "text/plain;charset=utf-8");
        showHistoryNotice("PDF generator was unavailable, so a text report was downloaded.");
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
    pdf.text("Admin History Report", 14, 21);
    pdf.setTextColor(26, 26, 46);

    pdf.setFontSize(10);
    pdf.text(`Generated: ${new Date().toLocaleString()}`, 14, y); y += 8;
    pdf.text(`Records included: ${records.length}`, 14, y); y += 12;

    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(9);
    pdf.text("Date", 14, y);
    pdf.text("Admin", 58, y);
    pdf.text("Module", 104, y);
    pdf.text("Action", 142, y);
    pdf.text("Target", 188, y);
    pdf.text("Details", 232, y);
    y += 5;
    pdf.setDrawColor(229, 231, 235);
    pdf.line(14, y, pageWidth - 14, y);
    y += 7;
    pdf.setFont("helvetica", "normal");

    records.forEach((record) => {
        const data = record.data || {};
        ensureSpace();
        pdf.text(formatHistoryDate(data.createdAt).slice(0, 22), 14, y);
        pdf.text(String(data.adminName || "Admin").slice(0, 20), 58, y);
        pdf.text(formatModuleLabel(data.module).slice(0, 16), 104, y);
        pdf.text(formatActionLabel(data.action).slice(0, 20), 142, y);
        pdf.text(String(data.targetName || data.targetId || "N/A").slice(0, 20), 188, y);
        pdf.text(String(data.details || "No details recorded.").slice(0, 32), 232, y);
        y += 7;
    });

    pdf.setFontSize(8);
    pdf.setTextColor(107, 114, 128);
    pdf.text("Generated by CitiHub Admin History", 14, pageHeight - 8);
    pdf.save(`citihub_admin_history_${getHistoryExportDateStamp()}.pdf`);
    showHistoryNotice("Admin History PDF report has been downloaded.");
}

function renderHistoryRow(record) {
    const data = record.data || {};
    const tr = document.createElement("tr");
    const actionTone = getActionTone(data.action);
    const moduleTone = getModuleTone(data.module);

    tr.innerHTML = `
        <td>${escapeHistoryText(data.adminName || "Admin")}</td>
        <td><span class="history-module-chip ${moduleTone}">${escapeHistoryText(formatModuleLabel(data.module))}</span></td>
        <td><span class="history-action-badge ${actionTone}">${escapeHistoryText(formatActionLabel(data.action))}</span></td>
        <td>${escapeHistoryText(data.targetName || data.targetId || "N/A")}</td>
        <td>${escapeHistoryText(data.details || "No details recorded.")}</td>
        <td>${escapeHistoryText(formatHistoryDate(data.createdAt))}</td>
    `;

    return tr;
}

function getActionValue(data) {
    return String(data?.action || "unknown_action").trim() || "unknown_action";
}

function updateActionFilterOptions() {
    const filter = document.getElementById("historyActionFilter");
    if (!filter) return;

    const currentValue = historyState.selectedAction;
    const actions = [...new Set(historyState.records.map((record) => getActionValue(record.data)))]
        .sort((left, right) => formatActionLabel(left).localeCompare(formatActionLabel(right)));

    filter.innerHTML = `<option value="all">All admin actions</option>`;
    actions.forEach((action) => {
        const option = document.createElement("option");
        option.value = action;
        option.textContent = formatActionLabel(action);
        filter.appendChild(option);
    });

    filter.value = actions.includes(currentValue) ? currentValue : "all";
    historyState.selectedAction = filter.value;
}

function getFilteredHistoryRecords() {
    if (historyState.selectedAction === "all") {
        return historyState.records;
    }

    return historyState.records.filter((record) => getActionValue(record.data) === historyState.selectedAction);
}

function updateHistoryCount(filteredRecords) {
    const countEl = document.getElementById("historyFilterCount");
    if (!countEl) return;

    const total = historyState.records.length;
    const visible = filteredRecords.length;
    const actionLabel = historyState.selectedAction === "all"
        ? "all admin actions"
        : formatActionLabel(historyState.selectedAction);

    countEl.textContent = `Showing ${visible} of ${total} records for ${actionLabel}`;
}

function renderHistoryTable() {
    const tbody = document.getElementById("historyTableBody");
    if (!tbody) return;

    const filteredRecords = getFilteredHistoryRecords();
    tbody.innerHTML = "";

    if (!historyState.records.length) {
        tbody.innerHTML = `
            <tr>
                <td colspan="6" class="history-empty-note">No admin activity recorded yet.</td>
            </tr>
        `;
        updateHistoryCount(filteredRecords);
        return;
    }

    if (!filteredRecords.length) {
        tbody.innerHTML = `
            <tr>
                <td colspan="6" class="history-empty-note">No records match this action filter.</td>
            </tr>
        `;
        updateHistoryCount(filteredRecords);
        return;
    }

    filteredRecords.forEach((record) => {
        tbody.appendChild(renderHistoryRow(record));
    });
    updateHistoryCount(filteredRecords);
}

function loadAdminHistory() {
    const tbody = document.getElementById("historyTableBody");

    if (!tbody) {
        return;
    }

    db.collection("adminHistory")
        .orderBy("createdAt", "desc")
        .limit(100)
        .onSnapshot((snapshot) => {
            historyState.records = snapshot.docs.map((doc) => ({
                id: doc.id,
                data: doc.data() || {}
            }));
            updateActionFilterOptions();
            renderHistoryTable();
        }, (error) => {
            console.error("Failed to load admin history:", error);
            tbody.innerHTML = `
                <tr>
                    <td colspan="6" class="history-empty-note">Unable to load admin history right now.</td>
                </tr>
            `;
        });
}

document.getElementById("historyActionFilter")?.addEventListener("change", (event) => {
    historyState.selectedAction = event.target.value;
    renderHistoryTable();
});

document.getElementById("historyFilterReset")?.addEventListener("click", () => {
    historyState.selectedAction = "all";
    const filter = document.getElementById("historyActionFilter");
    if (filter) {
        filter.value = "all";
    }
    renderHistoryTable();
});

document.getElementById("downloadHistoryPdfBtn")?.addEventListener("click", downloadHistoryPdf);
document.getElementById("downloadHistoryCsvBtn")?.addEventListener("click", downloadHistoryCsv);

loadAdminHistory();

document.querySelectorAll("#btnLogout").forEach((button) => {
    button.addEventListener("click", logoutAdmin);
});

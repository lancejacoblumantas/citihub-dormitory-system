requireAdminAccess();

const maintenanceAdminState = {
    tickets: [],
    filteredTickets: [],
    selectedTicketId: null,
    unsubscribe: null
};

function showToast(message) {
    const toast = document.getElementById("toast");
    if (!toast) {
        return;
    }

    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toast.hideTimer);
    toast.hideTimer = setTimeout(() => {
        toast.classList.remove("show");
    }, 3000);
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

function getTicketDate(timestamp) {
    if (!timestamp) {
        return null;
    }

    if (typeof timestamp.toDate === "function") {
        return timestamp.toDate();
    }

    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(timestamp) {
    const date = getTicketDate(timestamp);
    if (!date) {
        return "Awaiting timestamp";
    }

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

function getVisibleMaintenanceTickets() {
    return maintenanceAdminState.filteredTickets.length || maintenanceAdminState.tickets.length
        ? maintenanceAdminState.filteredTickets
        : [];
}

function downloadMaintenanceCsv() {
    const tickets = getVisibleMaintenanceTickets();
    if (!tickets.length) {
        showToast("There are no maintenance tickets to export using the current filters.");
        return;
    }

    const headers = [
        "Subject",
        "Tenant",
        "Tenant Email",
        "Room",
        "Category",
        "Priority",
        "Status",
        "Description",
        "Admin Note",
        "Submitted",
        "Updated",
        "Record ID"
    ];

    const lines = [
        headers.map(escapeCsv).join(","),
        ...tickets.map((ticket) => [
            ticket.subject || "Untitled Ticket",
            ticket.tenantName || "Tenant",
            ticket.tenantEmail || "",
            ticket.room || "",
            formatLabel(ticket.category || "other concern"),
            formatLabel(ticket.priority || "medium"),
            formatLabel(ticket.status || "open"),
            ticket.description || "",
            ticket.adminNote || "",
            formatDate(ticket.createdAt),
            formatDate(ticket.updatedAt || ticket.createdAt),
            ticket.id
        ].map(escapeCsv).join(","))
    ];

    downloadTextFile(`citihub_maintenance_${getExportDateStamp()}.csv`, lines.join("\n"));
    showToast("Maintenance CSV export has been downloaded.");
}

function downloadMaintenancePdf() {
    const tickets = getVisibleMaintenanceTickets();
    if (!tickets.length) {
        showToast("There are no maintenance tickets to export using the current filters.");
        return;
    }

    if (!window.jspdf?.jsPDF) {
        const content = [
            "CITIHUB DORMITORY - MAINTENANCE REPORT",
            "=".repeat(46),
            `Generated: ${new Date().toLocaleString()}`,
            `Tickets included: ${tickets.length}`,
            "",
            ...tickets.map((ticket) => `${formatDate(ticket.updatedAt || ticket.createdAt)} | ${ticket.tenantName || "Tenant"} | ${ticket.room || "No room"} | ${ticket.subject || "Untitled Ticket"} | ${formatLabel(ticket.priority || "medium")} | ${formatLabel(ticket.status || "open")}`)
        ].join("\n");
        downloadTextFile(`citihub_maintenance_${getExportDateStamp()}.txt`, content, "text/plain;charset=utf-8");
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

    const counts = tickets.reduce((acc, ticket) => {
        const status = ticket.status || "open";
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
    pdf.text("Maintenance Tickets", 14, 21);
    pdf.setTextColor(26, 26, 46);

    pdf.setFontSize(10);
    pdf.text(`Generated: ${new Date().toLocaleString()}`, 14, y); y += 8;
    pdf.text(`Shown: ${tickets.length}   Open: ${counts.open || 0}   In Progress: ${counts.in_progress || 0}   Resolved: ${counts.resolved || 0}`, 14, y); y += 12;

    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(9);
    pdf.text("Tenant", 14, y);
    pdf.text("Room", 58, y);
    pdf.text("Subject", 92, y);
    pdf.text("Category", 148, y);
    pdf.text("Priority", 190, y);
    pdf.text("Status", 224, y);
    pdf.text("Updated", 258, y);
    y += 5;
    pdf.setDrawColor(229, 231, 235);
    pdf.line(14, y, pageWidth - 14, y);
    y += 7;
    pdf.setFont("helvetica", "normal");

    tickets.forEach((ticket) => {
        ensureSpace();
        pdf.text(String(ticket.tenantName || "Tenant").slice(0, 20), 14, y);
        pdf.text(String(ticket.room || "No room").slice(0, 14), 58, y);
        pdf.text(String(ticket.subject || "Untitled Ticket").slice(0, 26), 92, y);
        pdf.text(formatLabel(ticket.category || "other").slice(0, 18), 148, y);
        pdf.text(formatLabel(ticket.priority || "medium").slice(0, 12), 190, y);
        pdf.text(formatLabel(ticket.status || "open").slice(0, 14), 224, y);
        pdf.text(formatDate(ticket.updatedAt || ticket.createdAt).slice(0, 18), 258, y);
        y += 7;
    });

    pdf.setFontSize(8);
    pdf.setTextColor(107, 114, 128);
    pdf.text("Generated by CitiHub Admin Maintenance", 14, pageHeight - 8);
    pdf.save(`citihub_maintenance_${getExportDateStamp()}.pdf`);
    showToast("Maintenance PDF export has been downloaded.");
}

function getStatusClass(status) {
    return String(status || "open").toLowerCase().replace(/\s+/g, "-");
}

function getInitials(name) {
    return String(name || "User")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part.charAt(0).toUpperCase())
        .join("") || "U";
}

function bindAvatarDropdown() {
    const avatarContainer = document.querySelector(".avatar-container");
    if (!avatarContainer) {
        return;
    }

    avatarContainer.addEventListener("click", function (event) {
        this.classList.toggle("open");
        event.stopPropagation();
    });

    document.addEventListener("click", () => {
        avatarContainer.classList.remove("open");
    });
}

function renderStats(tickets) {
    const openCount = tickets.filter((ticket) => ticket.status === "open").length;
    const progressCount = tickets.filter((ticket) => ticket.status === "in_progress").length;
    const resolvedCount = tickets.filter((ticket) => ticket.status === "resolved").length;

    document.getElementById("statOpenTickets").textContent = String(openCount);
    document.getElementById("statProgressTickets").textContent = String(progressCount);
    document.getElementById("statResolvedTickets").textContent = String(resolvedCount);
}

function buildTicketList(tickets) {
    const container = document.getElementById("maintenanceTicketList");
    if (!container) {
        return;
    }

    container.innerHTML = "";

    if (!tickets.length) {
        container.innerHTML = `<div class="ticket-list-empty">No maintenance tickets match the current filters.</div>`;
        return;
    }

    tickets.forEach((ticket) => {
        const item = document.createElement("div");
        const statusClass = getStatusClass(ticket.status);
        const priorityClass = String(ticket.priority || "medium").toLowerCase();

        item.className = `ticket-item${maintenanceAdminState.selectedTicketId === ticket.id ? " active" : ""}`;
        item.dataset.ticketId = ticket.id;
        item.innerHTML = `
            <div class="ticket-item-top">
                <div>
                    <div class="ticket-item-subject">${escapeHtml(ticket.subject || "Untitled Ticket")}</div>
                    <div class="ticket-item-meta">${escapeHtml(ticket.tenantName || "Tenant")} | ${escapeHtml(ticket.room || "No room assigned")}</div>
                </div>
                <div class="ticket-badge-row">
                    <span class="ticket-status-badge ${statusClass}">${escapeHtml(formatLabel(ticket.status || "open"))}</span>
                    <span class="ticket-priority-badge ${priorityClass}">${escapeHtml(formatLabel(ticket.priority || "medium"))}</span>
                </div>
            </div>
            <div class="ticket-item-preview">${escapeHtmlWithBreaks(ticket.description || "No details provided.")}</div>
            <div class="ticket-item-time">Updated ${formatDate(ticket.updatedAt || ticket.createdAt)}</div>
        `;

        item.addEventListener("click", () => {
            openTicket(ticket.id);
        });

        container.appendChild(item);
    });
}

function renderTicketDetail(ticket) {
    const container = document.getElementById("maintenanceTicketDetail");
    if (!container) {
        return;
    }

    if (!ticket) {
        container.innerHTML = `<div class="ticket-detail-empty">Select a ticket from the left to review the concern and update its status.</div>`;
        return;
    }

    const statusClass = getStatusClass(ticket.status);
    const priorityClass = String(ticket.priority || "medium").toLowerCase();

    container.innerHTML = `
        <div class="ticket-detail-head">
            <div>
                <div class="ticket-detail-title">${escapeHtml(ticket.subject || "Untitled Ticket")}</div>
                <div class="ticket-detail-sub">Submitted by ${escapeHtml(ticket.tenantName || "Tenant")} (${escapeHtml(ticket.tenantEmail || "No email provided")})</div>
            </div>
            <div class="ticket-detail-badges">
                <span class="ticket-status-badge ${statusClass}">${escapeHtml(formatLabel(ticket.status || "open"))}</span>
                <span class="ticket-priority-badge ${priorityClass}">${escapeHtml(formatLabel(ticket.priority || "medium"))}</span>
            </div>
        </div>

        <div class="ticket-detail-grid">
            <div class="ticket-detail-field">
                <div class="ticket-detail-label">Tenant</div>
                <div class="ticket-detail-value">${escapeHtml(ticket.tenantName || "Tenant")}</div>
            </div>
            <div class="ticket-detail-field">
                <div class="ticket-detail-label">Room</div>
                <div class="ticket-detail-value">${escapeHtml(ticket.room || "No room assigned")}</div>
            </div>
            <div class="ticket-detail-field">
                <div class="ticket-detail-label">Category</div>
                <div class="ticket-detail-value">${escapeHtml(formatLabel(ticket.category || "other concern"))}</div>
            </div>
            <div class="ticket-detail-field">
                <div class="ticket-detail-label">Submitted</div>
                <div class="ticket-detail-value">${formatDate(ticket.createdAt)}</div>
            </div>
        </div>

        <div>
            <div class="ticket-detail-label">Description</div>
            <div class="ticket-detail-desc">${escapeHtmlWithBreaks(ticket.description || "No details provided.")}</div>
        </div>

        <div class="modal-field">
            <label class="modal-label" for="ticketStatusSelect">Status</label>
            <select class="modal-select" id="ticketStatusSelect">
                <option value="open">Open</option>
                <option value="in_progress">In Progress</option>
                <option value="resolved">Resolved</option>
            </select>
        </div>

        <div class="modal-field">
            <label class="modal-label" for="ticketAdminNote">Admin Note</label>
            <textarea class="modal-textarea ticket-detail-note" id="ticketAdminNote" rows="5" placeholder="Add an internal update or a resolution note for the tenant.">${escapeHtml(ticket.adminNote || "")}</textarea>
        </div>

        <div class="ticket-detail-actions">
            <button class="ticket-quick-btn" type="button" id="markInProgressBtn">Mark In Progress</button>
            <button class="ticket-quick-btn" type="button" id="markResolvedBtn">Mark Resolved</button>
            <button class="primary-btn" type="button" id="saveTicketBtn">Save Update</button>
        </div>
    `;

    document.getElementById("ticketStatusSelect").value = ticket.status || "open";
    document.getElementById("saveTicketBtn").addEventListener("click", async (event) => {
        await saveTicketUpdate("", event.currentTarget);
    });
    document.getElementById("markInProgressBtn").addEventListener("click", async (event) => {
        await saveTicketUpdate("in_progress", event.currentTarget);
    });
    document.getElementById("markResolvedBtn").addEventListener("click", async (event) => {
        await saveTicketUpdate("resolved", event.currentTarget);
    });
}

function openTicket(ticketId) {
    const ticket = maintenanceAdminState.filteredTickets.find((entry) => entry.id === ticketId)
        || maintenanceAdminState.tickets.find((entry) => entry.id === ticketId);

    if (!ticket) {
        return;
    }

    maintenanceAdminState.selectedTicketId = ticketId;
    buildTicketList(maintenanceAdminState.filteredTickets);
    renderTicketDetail(ticket);
}

function applyFilters() {
    const search = String(document.getElementById("ticketSearchInput")?.value || "").trim().toLowerCase();
    const status = document.getElementById("ticketStatusFilter")?.value || "all";
    const priority = document.getElementById("ticketPriorityFilter")?.value || "all";

    maintenanceAdminState.filteredTickets = maintenanceAdminState.tickets.filter((ticket) => {
        const haystack = [
            ticket.tenantName,
            ticket.tenantEmail,
            ticket.subject,
            ticket.description,
            ticket.room,
            ticket.category
        ].join(" ").toLowerCase();

        const matchesSearch = !search || haystack.includes(search);
        const matchesStatus = status === "all" || ticket.status === status;
        const matchesPriority = priority === "all" || ticket.priority === priority;

        return matchesSearch && matchesStatus && matchesPriority;
    });

    buildTicketList(maintenanceAdminState.filteredTickets);

    if (!maintenanceAdminState.filteredTickets.some((ticket) => ticket.id === maintenanceAdminState.selectedTicketId)) {
        maintenanceAdminState.selectedTicketId = maintenanceAdminState.filteredTickets[0]?.id || null;
    }

    if (maintenanceAdminState.selectedTicketId) {
        openTicket(maintenanceAdminState.selectedTicketId);
    } else {
        renderTicketDetail(null);
    }
}

async function saveTicketUpdate(forcedStatus = "", triggerButton = null) {
    const ticketId = maintenanceAdminState.selectedTicketId;
    if (!ticketId) {
        return;
    }

    const currentTicket = maintenanceAdminState.tickets.find((ticket) => ticket.id === ticketId);
    if (!currentTicket) {
        return;
    }

    const statusSelect = document.getElementById("ticketStatusSelect");
    const adminNote = document.getElementById("ticketAdminNote");
    const nextStatus = forcedStatus || statusSelect?.value || currentTicket.status || "open";
    const nextNote = adminNote?.value.trim() || "";

    try {
        const loadingLabel = forcedStatus === "resolved"
            ? "Resolving..."
            : forcedStatus === "in_progress"
                ? "Updating..."
                : "Saving...";
        setAdminButtonLoading?.(triggerButton, loadingLabel);
        await callAdminApi("/api/admin/maintenance/update", {
            ticketId,
            status: nextStatus,
            adminNote: nextNote
        });

        showToast("Maintenance ticket updated successfully.");
    } catch (error) {
        console.error("Failed to update maintenance ticket:", error);
        showToast("Unable to update the selected maintenance ticket right now.");
    } finally {
        restoreAdminButton?.(triggerButton);
    }
}

function subscribeToTickets() {
    if (maintenanceAdminState.unsubscribe) {
        maintenanceAdminState.unsubscribe();
        maintenanceAdminState.unsubscribe = null;
    }

    maintenanceAdminState.unsubscribe = db.collection("maintenanceTickets")
        .onSnapshot((snapshot) => {
            const tickets = [];

            snapshot.forEach((doc) => {
                tickets.push({
                    id: doc.id,
                    ...doc.data()
                });
            });

            tickets.sort((left, right) => {
                const leftDate = getTicketDate(left.updatedAt || left.createdAt);
                const rightDate = getTicketDate(right.updatedAt || right.createdAt);

                if (leftDate && rightDate) {
                    return rightDate - leftDate;
                }

                if (rightDate) {
                    return 1;
                }

                if (leftDate) {
                    return -1;
                }

                return 0;
            });

            maintenanceAdminState.tickets = tickets;
            renderStats(tickets);
            applyFilters();
        }, (error) => {
            console.error("Failed to load maintenance tickets:", error);
            showToast("Unable to load maintenance tickets right now.");
        });
}

document.addEventListener("DOMContentLoaded", () => {
    bindAvatarDropdown();
    document.getElementById("btnLogout")?.addEventListener("click", logoutAdmin);
    document.getElementById("topbarLogoutBtn")?.addEventListener("click", logoutAdmin);
    document.getElementById("ticketSearchInput")?.addEventListener("input", applyFilters);
    document.getElementById("ticketStatusFilter")?.addEventListener("change", applyFilters);
    document.getElementById("ticketPriorityFilter")?.addEventListener("change", applyFilters);
    document.getElementById("downloadMaintenancePdfBtn")?.addEventListener("click", downloadMaintenancePdf);
    document.getElementById("downloadMaintenanceCsvBtn")?.addEventListener("click", downloadMaintenanceCsv);
    subscribeToTickets();
});

const adminAccessReady = requireAdminAccess();

const tenantsState = {
    rows: [],
    selectedTenant: null
};

document.querySelector(".avatar-container").addEventListener("click", function (event) {
    this.classList.toggle("open");
    event.stopPropagation();
});

document.addEventListener("click", () => {
    document.querySelector(".avatar-container").classList.remove("open");
});

function showToast(msg) {
    const toast = document.getElementById("toast");
    toast.textContent = msg;
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 3000);
}

function formatDate(timestamp) {
    if (!timestamp) {
        return "";
    }

    const date = typeof timestamp.toDate === "function" ? timestamp.toDate() : new Date(timestamp);
    if (Number.isNaN(date.getTime())) {
        return "";
    }

    return date.toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric"
    });
}

function parseTenantDate(value) {
    if (!value) {
        return null;
    }

    const date = typeof value.toDate === "function"
        ? value.toDate()
        : new Date(`${String(value).slice(0, 10)}T00:00:00`);

    if (Number.isNaN(date.getTime())) {
        return null;
    }

    return date;
}

function getMonthKeyFromDate(value) {
    const date = parseTenantDate(value);
    if (!date) {
        return "";
    }

    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function parseMoney(value) {
    const parsed = Number(String(value || "").replace(/[^\d.]/g, ""));
    return Number.isFinite(parsed) ? parsed : 0;
}

function formatCurrency(value) {
    return new Intl.NumberFormat("en-PH", {
        style: "currency",
        currency: "PHP",
        maximumFractionDigits: 0
    }).format(Number(value || 0));
}

function getSelectedHistoryMonth() {
    const input = document.getElementById("tenantHistoryMonth");
    if (input?.value) {
        return input.value;
    }

    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function setupTenantHistoryMonth() {
    const input = document.getElementById("tenantHistoryMonth");
    if (!input) {
        return;
    }

    input.value = "";
    input.addEventListener("change", filterTenants);
}

function clearTenantMonthFilter() {
    const input = document.getElementById("tenantHistoryMonth");
    if (input) {
        input.value = "";
    }

    filterTenants();
}

function escapeCsv(value) {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadTextFile(filename, text, type = "text/csv;charset=utf-8") {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

function getVisibleTenantRows() {
    return tenantsState.rows.filter((row) => row.element.style.display !== "none");
}

async function getBillingInvoicesForMonth(billingMonth) {
    const snapshot = await db.collection("billingInvoices")
        .where("billingMonth", "==", billingMonth)
        .get();

    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

function getTenantBillingStatus(data) {
    if (data.manualBillingHold === true) {
        return {
            label: "Billing Hold",
            className: "overdue",
            note: data.manualBillingHoldReason || "Manual hold active"
        };
    }

    if (data.delinquentAccount || data.billingStatus === "delinquent") {
        return {
            label: "Delinquent",
            className: "overdue",
            note: "Past grace period"
        };
    }

    if (data.contractAlertStatus === "expiring_soon") {
        const days = Number(data.contractDaysUntilExpiration || 0);
        return {
            label: "Expiring Soon",
            className: "pending",
            note: `Contract ends ${formatDate(data.contractEndAt || data.contractEndDate) || "soon"}${Number.isFinite(days) ? ` (${days} day${days === 1 ? "" : "s"} left)` : ""}`
        };
    }

    return {
        label: "Active",
        className: "approved",
        note: ""
    };
}

function updateTenantStats() {
    const total = tenantsState.rows.length;
    const standard = tenantsState.rows.filter((row) => row.typeKey === "standard").length;
    const premium = tenantsState.rows.filter((row) => row.typeKey === "premium").length;
    const revenue = tenantsState.rows.reduce((sum, row) => sum + parseMoney(row.rate), 0);

    const setText = (id, value) => {
        const element = document.getElementById(id);
        if (element) {
            element.textContent = value;
        }
    };

    setText("tenantStatTotal", String(total));
    setText("tenantStatStandard", String(standard));
    setText("tenantStatPremium", String(premium));
    setText("tenantStatRevenue", formatCurrency(revenue));
}

function updateVisibleTenantCount(visibleCount) {
    const countEl = document.getElementById("tenantVisibleCount");
    const emptyState = document.getElementById("tenantEmptyState");

    if (countEl) {
        countEl.textContent = `Showing ${visibleCount} of ${tenantsState.rows.length} tenant${tenantsState.rows.length === 1 ? "" : "s"}`;
    }

    if (emptyState) {
        emptyState.style.display = visibleCount ? "none" : "flex";
    }
}

function renderTenantRows(snapshot, tableBody) {
    tableBody.innerHTML = "";
    tenantsState.rows = [];
    updateTenantStats();
    updateVisibleTenantCount(0);

    snapshot.forEach((doc) => {
        const data = doc.data();

        if (data.status !== "approved") {
            return;
        }

        const firstName = data.firstName || "";
        const lastName = data.lastName || "";
        const fullName = `${firstName} ${lastName}`.trim();
        const initials = `${firstName[0] || ""}${lastName[0] || ""}`.toUpperCase();
        const roomLabel = data.room ? `Room ${data.room}` : "";
        const typeKey = String(data.type || "").toLowerCase();
        const typeLabel = typeKey === "premium" ? "Premium" : "Standard";
        const billingStatus = getTenantBillingStatus(data);
        const moveInSource = data.contractStartAt || data.contractStartDate || data.moveInDate || data.createdAt;
        const moveInDate = formatDate(moveInSource);
        const moveInMonth = getMonthKeyFromDate(moveInSource);
        const contractEnd = formatDate(data.contractEndAt || data.contractEndDate);
        const outstandingBalance = Number(data.delinquentOutstandingBalance || 0);

        const row = document.createElement("tr");
        row.dataset.type = typeKey;

        row.innerHTML = `
            <td>
                <div class="td-tenant">
                    <div class="td-avatar green">${initials}</div>
                    <div>
                        <div class="td-name">${fullName}</div>
                        <div class="td-email">${data.email || ""}</div>
                    </div>
                </div>
            </td>
            <td class="td-room">${roomLabel}</td>
            <td><span class="room-type-tag ${typeKey === "premium" ? "teal" : "green"}">${typeLabel}</span></td>
            <td class="td-movein">${moveInDate}</td>
            <td class="td-contract-end">${contractEnd || "Not set"}</td>
            <td class="td-amount">${data.leasePrice || ""}</td>
            <td>
                <div class="tenant-billing-cell">
                    <span class="status-pill ${billingStatus.className}">${billingStatus.label}</span>
                    ${billingStatus.note ? `<div class="tenant-billing-note">${billingStatus.note}</div>` : ""}
                </div>
            </td>
            <td class="td-amount">${outstandingBalance > 0 ? formatCurrency(outstandingBalance) : formatCurrency(0)}</td>
            <td><div class="action-btns"></div></td>
        `;

        const tenantPayload = {
            userId: data.userId || "",
            name: fullName,
            email: data.email || "",
            phone: data.phone || "",
            room: roomLabel,
            type: typeLabel,
            movein: moveInDate,
            contractEnd,
            rate: data.leasePrice || "",
            status: billingStatus.label,
            statusNote: billingStatus.note,
            outstandingBalance: outstandingBalance > 0 ? formatCurrency(outstandingBalance) : formatCurrency(0),
            manualBillingHold: data.manualBillingHold === true ? "Yes" : "No",
            billingStatus: data.billingStatus || "current",
            ecName: data.emergencyName || "",
            ecPhone: data.emergencyPhone || "",
            ecRel: data.relationship || ""
        };

        const viewButton = document.createElement("button");
        viewButton.className = "tbl-btn";
        viewButton.textContent = "View";
        viewButton.addEventListener("click", () => {
            openTenantModal(tenantPayload);
        });

        row.querySelector(".action-btns").appendChild(viewButton);
        tableBody.appendChild(row);

        tenantsState.rows.push({
            element: row,
            tenant: tenantPayload,
            name: fullName,
            email: data.email || "",
            room: roomLabel,
            type: typeLabel,
            typeKey,
            statusKey: billingStatus.label.toLowerCase().replace(/\s+/g, "_"),
            moveInMonth,
            rate: data.leasePrice || "",
            searchText: `${fullName} ${data.email || ""} ${roomLabel} ${typeLabel} ${billingStatus.label} ${billingStatus.note || ""} ${contractEnd} ${outstandingBalance}`.toLowerCase()
        });
    });

    populateRoomFilter();
    updateTenantStats();
    filterTenants();
}

function createReadOnlyField(label, value) {
    const field = document.createElement("div");
    field.className = "modal-field";

    const labelElement = document.createElement("label");
    labelElement.className = "modal-label";
    labelElement.textContent = label;

    const input = document.createElement("input");
    input.className = "modal-input";
    input.value = value || "";
    input.readOnly = true;

    field.appendChild(labelElement);
    field.appendChild(input);

    return field;
}

function buildTwoColSection(fields) {
    const section = document.createElement("div");
    section.className = "modal-two-col";

    fields.forEach((field) => section.appendChild(field));
    return section;
}

function buildTenantProfilePdf(tenant) {
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF();
    let y = 18;

    const addLine = (label, value) => {
        pdf.setFont("helvetica", "bold");
        pdf.text(`${label}:`, 14, y);
        pdf.setFont("helvetica", "normal");
        pdf.text(String(value || "N/A"), 62, y);
        y += 8;
    };

    pdf.setFontSize(16);
    pdf.setFont("helvetica", "bold");
    pdf.text("CITIHUB Tenant Profile", 14, y);
    y += 12;

    pdf.setFontSize(11);
    addLine("Full Name", tenant.name);
    addLine("Email", tenant.email);
    addLine("Phone", tenant.phone);
    addLine("Assigned Room", tenant.room);
    addLine("Room Type", tenant.type);
    addLine("Move-in Date", tenant.movein);
    addLine("Monthly Rate", tenant.rate);
    addLine("Status", tenant.status);
    addLine("Emergency Contact", tenant.ecName);
    addLine("Relationship", tenant.ecRel);
    addLine("Emergency Phone", tenant.ecPhone);

    pdf.save(`tenant_profile_${tenant.name.replace(/\s+/g, "_").toLowerCase()}.pdf`);
}

function downloadTenantProfilePdf() {
    if (!tenantsState.selectedTenant) {
        return;
    }

    buildTenantProfilePdf(tenantsState.selectedTenant);
}

async function downloadSelectedTenantMonthEndPdf() {
    if (!tenantsState.selectedTenant) {
        return;
    }

    try {
        await buildMonthEndHistoryPdf([{
            tenant: tenantsState.selectedTenant,
            name: tenantsState.selectedTenant.name,
            email: tenantsState.selectedTenant.email,
            room: tenantsState.selectedTenant.room,
            type: tenantsState.selectedTenant.type,
            rate: tenantsState.selectedTenant.rate,
            status: tenantsState.selectedTenant.status
        }], getSelectedHistoryMonth(), `${tenantsState.selectedTenant.name} Month-End History`);
    } catch (error) {
        console.error("Tenant month-end PDF failed:", error);
        showToast("Unable to download this tenant month-end history.");
    }
}

function openTenantModal(tenant) {
    tenantsState.selectedTenant = tenant;

    const init = tenant.name.split(" ").map((w) => w[0]).join("").slice(0, 2);
    const sc = tenant.status === "Active" ? "approved" : tenant.status === "Delinquent" || tenant.status === "Overdue" ? "overdue" : "pending";
    const modalBody = document.getElementById("tenantModalBody");

    modalBody.innerHTML = "";

    const hero = document.createElement("div");
    hero.className = "tenant-modal-hero";

    const avatar = document.createElement("div");
    avatar.className = "tm-avatar";
    avatar.textContent = init;

    const heroInfo = document.createElement("div");
    const nameElement = document.createElement("div");
    nameElement.className = "tm-name";
    nameElement.textContent = tenant.name;

    const statusElement = document.createElement("span");
    statusElement.className = `status-pill ${sc}`;
    statusElement.textContent = tenant.status;

    heroInfo.appendChild(nameElement);
    heroInfo.appendChild(statusElement);
    hero.appendChild(avatar);
    hero.appendChild(heroInfo);

    const personalLabel = document.createElement("div");
    personalLabel.className = "modal-section-label";
    personalLabel.textContent = "Personal Information";

    const emergencyLabel = document.createElement("div");
    emergencyLabel.className = "modal-section-label";
    emergencyLabel.style.marginTop = "6px";
    emergencyLabel.textContent = "Emergency Contact";

    modalBody.appendChild(hero);
    if (tenant.statusNote) {
        modalBody.appendChild(createReadOnlyField("Billing Status", tenant.statusNote));
    }
    modalBody.appendChild(personalLabel);
    modalBody.appendChild(buildTwoColSection([
        createReadOnlyField("Full Name", tenant.name),
        createReadOnlyField("Email", tenant.email),
        createReadOnlyField("Phone", tenant.phone),
        createReadOnlyField("Room", tenant.room),
        createReadOnlyField("Room Type", tenant.type),
        createReadOnlyField("Move-in Date", tenant.movein),
        createReadOnlyField("Contract End", tenant.contractEnd),
        createReadOnlyField("Monthly Rate", tenant.rate)
    ]));
    modalBody.appendChild(buildTwoColSection([
        createReadOnlyField("Billing Status", tenant.status),
        createReadOnlyField("Billing Note", tenant.statusNote || ""),
        createReadOnlyField("Outstanding Balance", tenant.outstandingBalance || formatCurrency(0)),
        createReadOnlyField("Manual Billing Hold", tenant.manualBillingHold || "No")
    ]));
    modalBody.appendChild(emergencyLabel);
    modalBody.appendChild(buildTwoColSection([
        createReadOnlyField("Contact Name", tenant.ecName),
        createReadOnlyField("Relationship", tenant.ecRel),
        createReadOnlyField("Contact Phone", tenant.ecPhone)
    ]));

    document.getElementById("tenantModal").style.display = "flex";
}

function closeTenantModal() {
    document.getElementById("tenantModal").style.display = "none";
}

function messageSelectedTenant() {
    const tenant = tenantsState.selectedTenant;

    if (!tenant?.userId) {
        showToast("Unable to open messages for this tenant.");
        return;
    }

    const params = new URLSearchParams({
        tenantId: tenant.userId
    });

    window.location.href = `messages.html?${params.toString()}`;
}

function downloadReport(label) {
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: "landscape" });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    let y = 38;
    const visibleRows = tenantsState.rows.filter((row) => row.element.style.display !== "none");

    pdf.setFillColor(26, 122, 74);
    pdf.rect(0, 0, pageWidth, 28, "F");
    pdf.setTextColor(255, 255, 255);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(16);
    pdf.text("CITIHUB DORMITORY", 14, 13);
    pdf.setFontSize(10);
    pdf.setFont("helvetica", "normal");
    pdf.text(`${label} Report`, 14, 21);
    pdf.setTextColor(26, 26, 46);

    pdf.setFontSize(10);
    pdf.setFont("helvetica", "normal");
    pdf.text(`Generated: ${new Date().toLocaleString()}`, 14, y); y += 8;
    pdf.text(`Visible tenants: ${visibleRows.length}`, 14, y); y += 12;

    pdf.setFont("helvetica", "bold");
    pdf.text("Name", 14, y);
    pdf.text("Room", 74, y);
    pdf.text("Type", 112, y);
    pdf.text("Monthly", 150, y);
    pdf.text("Email", 188, y);
    y += 6;
    pdf.setDrawColor(229, 231, 235);
    pdf.line(14, y, pageWidth - 14, y);
    y += 7;
    pdf.setFont("helvetica", "normal");

    visibleRows.forEach((row) => {
        pdf.text(String(row.name || "").slice(0, 30), 14, y);
        pdf.text(String(row.room || "").slice(0, 18), 74, y);
        pdf.text(String(row.type || "").slice(0, 16), 112, y);
        pdf.text(String(row.rate || "").slice(0, 16), 150, y);
        pdf.text(String(row.email || "").slice(0, 42), 188, y);
        y += 7;

        if (y > pageHeight - 18) {
            pdf.addPage();
            y = 18;
        }
    });

    pdf.setFontSize(8);
    pdf.setTextColor(107, 114, 128);
    pdf.text("Generated by CitiHub Admin Tenants", 14, pageHeight - 8);
    pdf.save(`${label.replace(/\s+/g, "_").toLowerCase()}_report.pdf`);
}

function downloadTenantListCsv() {
    const visibleRows = getVisibleTenantRows();
    const headers = ["Name", "Email", "Phone", "Room", "Room Type", "Move-in", "Contract End", "Monthly Rate", "Status", "Billing Note"];
    const lines = [
        headers.map(escapeCsv).join(","),
        ...visibleRows.map((row) => {
            const tenant = row.tenant || {};
            return [
                row.name,
                row.email,
                tenant.phone || "",
                row.room,
                row.type,
                tenant.movein || "",
                tenant.contractEnd || "",
                row.rate,
                tenant.status || row.statusKey,
                tenant.statusNote || ""
            ].map(escapeCsv).join(",");
        })
    ];

    downloadTextFile(`citihub_tenant_list_${new Date().toISOString().slice(0, 10)}.csv`, lines.join("\n"));
    showToast("Tenant CSV downloaded.");
}

async function buildMonthEndHistoryPdf(rows, billingMonth, label = "Tenant Month-End History") {
    if (!window.jspdf?.jsPDF) {
        showToast("PDF generator is still loading. Please try again.");
        return;
    }

    const invoices = await getBillingInvoicesForMonth(billingMonth);
    const invoiceMap = invoices.reduce((map, invoice) => {
        [invoice.userId, invoice.tenantEmail, invoice.tenantName]
            .map((value) => String(value || "").trim())
            .filter(Boolean)
            .forEach((key) => {
                const list = map.get(key) || [];
                list.push(invoice);
                map.set(key, list);
            });
        return map;
    }, new Map());

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: "landscape" });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    let y = 38;

    pdf.setFillColor(26, 122, 74);
    pdf.rect(0, 0, pageWidth, 28, "F");
    pdf.setTextColor(255, 255, 255);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(16);
    pdf.text("CITIHUB DORMITORY", 14, 13);
    pdf.setFontSize(10);
    pdf.setFont("helvetica", "normal");
    pdf.text(`${label} - ${billingMonth}`, 14, 21);
    pdf.setTextColor(26, 26, 46);

    pdf.setFontSize(10);
    pdf.text(`Generated: ${new Date().toLocaleString()}`, 14, y); y += 8;
    pdf.text(`Tenants included: ${rows.length}`, 14, y); y += 12;

    pdf.setFont("helvetica", "bold");
    pdf.text("Tenant", 14, y);
    pdf.text("Room", 72, y);
    pdf.text("Contract", 108, y);
    pdf.text("Monthly", 154, y);
    pdf.text("Invoice Status", 190, y);
    pdf.text("Balance", 232, y);
    y += 6;
    pdf.setDrawColor(229, 231, 235);
    pdf.line(14, y, pageWidth - 14, y);
    y += 7;
    pdf.setFont("helvetica", "normal");

    rows.forEach((row) => {
        const tenant = row.tenant || row;
        const invoiceKey = tenant.userId || tenant.email || tenant.name || "";
        const tenantInvoices = invoiceMap.get(invoiceKey) || invoiceMap.get(tenant.email) || invoiceMap.get(tenant.name) || [];
        const balance = tenantInvoices.reduce((sum, invoice) => ["paid", "deducted_by_deposit"].includes(invoice.status) ? sum : sum + Number(invoice.amount || 0), 0);
        const invoiceStatus = tenantInvoices.length
            ? [...new Set(tenantInvoices.map((invoice) => invoice.status || "unpaid"))].join(", ")
            : "No invoice";

        pdf.text(String(tenant.name || row.name || "").slice(0, 28), 14, y);
        pdf.text(String(tenant.room || row.room || "").slice(0, 16), 72, y);
        pdf.text(`${tenant.movein || ""} - ${tenant.contractEnd || ""}`.slice(0, 24), 108, y);
        pdf.text(String(tenant.rate || row.rate || "").slice(0, 14), 154, y);
        pdf.text(invoiceStatus.slice(0, 24), 190, y);
        pdf.text(formatCurrency(balance).slice(0, 18), 232, y);
        y += 7;

        if (y > pageHeight - 18) {
            pdf.addPage();
            y = 18;
        }
    });

    pdf.setFontSize(8);
    pdf.setTextColor(107, 114, 128);
    pdf.text("Generated by CitiHub Admin Tenants", 14, pageHeight - 8);
    pdf.save(`${label.replace(/\s+/g, "_").toLowerCase()}_${billingMonth}.pdf`);
    showToast(`${billingMonth} month-end history downloaded.`);
}

async function downloadMonthEndHistoryPdf() {
    try {
        await buildMonthEndHistoryPdf(getVisibleTenantRows(), getSelectedHistoryMonth());
    } catch (error) {
        console.error("Month-end history PDF failed:", error);
        showToast("Unable to download month-end history.");
    }
}

function populateRoomFilter() {
    const roomFilter = document.getElementById("tenantRoomFilter");
    if (!roomFilter) {
        return;
    }

    const currentValue = roomFilter.value;
    const rooms = [...new Set(tenantsState.rows.map((row) => row.room).filter(Boolean))].sort();
    roomFilter.innerHTML = `<option value="">All Assigned Rooms</option>`;

    rooms.forEach((room) => {
        const option = document.createElement("option");
        option.value = room.toLowerCase();
        option.textContent = room;
        roomFilter.appendChild(option);
    });

    roomFilter.value = currentValue;
}

function filterTenants() {
    const search = String(document.getElementById("tenantSearchInput")?.value || "").trim().toLowerCase();
    const type = String(document.getElementById("tenantTypeFilter")?.value || "");
    const room = String(document.getElementById("tenantRoomFilter")?.value || "");
    const status = String(document.getElementById("tenantStatusFilter")?.value || "");
    const month = String(document.getElementById("tenantHistoryMonth")?.value || "");
    let visibleCount = 0;

    tenantsState.rows.forEach((rowData) => {
        const matchesSearch = !search || rowData.searchText.includes(search);
        const matchesType = !type || rowData.typeKey === type;
        const matchesRoom = !room || rowData.room.toLowerCase() === room;
        const matchesStatus = !status || rowData.statusKey === status;
        const matchesMonth = !month || rowData.moveInMonth === month;
        const isVisible = matchesSearch && matchesType && matchesRoom && matchesStatus && matchesMonth;

        rowData.element.style.display = isVisible ? "" : "none";
        if (isVisible) {
            visibleCount += 1;
        }
    });

    updateVisibleTenantCount(visibleCount);
}

async function syncContractExpirationAlerts(showResult = false) {
    try {
        const result = await callAdminApi("/api/admin/contracts/sync-expiration-alerts", {});
        if (showResult) {
            showToast(`Expiration check complete: ${result.expiringSoonCount || 0} expiring, ${result.alertedCount || 0} alert(s) sent.`);
        }
        return result;
    } catch (error) {
        console.error("Failed to sync contract expiration alerts:", error);
        if (showResult) {
            showToast(error.message || "Unable to sync contract expiration alerts.");
        }
        return null;
    }
}

document.addEventListener("DOMContentLoaded", async () => {
    const tableBody = document.getElementById("tenantTableBody");
    if (!tableBody) {
        return;
    }

    const adminData = await adminAccessReady;
    if (!adminData) {
        return;
    }

    setupTenantHistoryMonth();
    await syncContractExpirationAlerts(false);

    db.collection("bookingRequest")
        .where("status", "==", "approved")
        .orderBy("createdAt", "desc")
        .onSnapshot((snapshot) => {
            renderTenantRows(snapshot, tableBody);
        }, async (error) => {
            console.error("Tenant listener failed, retrying with fallback query:", error);

            try {
                const fallbackSnapshot = await db.collection("bookingRequest")
                    .where("status", "==", "approved")
                    .get();
                renderTenantRows(fallbackSnapshot, tableBody);
                showToast("Tenant list loaded using fallback mode.");
            } catch (fallbackError) {
                console.error("Tenant fallback query failed:", fallbackError);
                tableBody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:24px;color:#dc2626;">Unable to load tenant records right now.</td></tr>`;
                updateVisibleTenantCount(0);
                showToast(fallbackError.message || "Unable to load tenant records.");
            }
        });
});

document.querySelectorAll("#btnLogout").forEach((button) => {
    button.addEventListener("click", logoutAdmin);
});

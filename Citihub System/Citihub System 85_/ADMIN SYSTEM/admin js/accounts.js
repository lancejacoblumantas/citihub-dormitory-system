requireAdminAccess();

const accountsState = {
    accounts: [],
    monthlyBookings: [],
    transientBookings: [],
    rows: [],
    selectedAccount: null
};

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function normalize(value) {
    return String(value || "").trim().toLowerCase();
}

function formatDate(value) {
    if (!value) return "Unavailable";
    const date = value?.toDate?.() || new Date(value);
    if (Number.isNaN(date.getTime())) return "Unavailable";
    return date.toLocaleDateString("en-PH", {
        month: "short",
        day: "numeric",
        year: "numeric"
    });
}

function formatStatus(status) {
    return String(status || "registered")
        .replace(/_/g, " ")
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function getDisplayName(account) {
    return account.fullName || account.username || [account.firstName, account.lastName].filter(Boolean).join(" ") || "Unnamed Account";
}

function getInitials(name, email) {
    const source = String(name || email || "A").trim();
    return source
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part.charAt(0).toUpperCase())
        .join("") || "A";
}

function getAccountEmail(account) {
    return account.email || account.userEmail || "";
}

function getMonthlyRecords(account) {
    const email = normalize(getAccountEmail(account));
    return accountsState.monthlyBookings.filter((booking) =>
        booking.userId === account.id || (email && normalize(booking.email) === email)
    );
}

function getTransientRecords(account) {
    const email = normalize(getAccountEmail(account));
    return accountsState.transientBookings.filter((booking) =>
        booking.userId === account.id || (email && normalize(booking.email) === email)
    );
}

function getRequestType(monthlyRecords, transientRecords) {
    if (monthlyRecords.length && transientRecords.length) return "both";
    if (monthlyRecords.length) return "monthly";
    if (transientRecords.length) return "transient";
    return "none";
}

function getStatusClass(status, role) {
    if (role === "admin") return "approved";
    const safeStatus = normalize(status);
    if (safeStatus === "approved" || safeStatus === "active") return "approved";
    if (safeStatus === "blocked" || safeStatus === "disabled") return "overdue";
    return "pending";
}

function getAccountStatusClass(account) {
    if (account.role === "admin") return "approved";
    if (account.manualBillingHold === true) return "overdue";
    if (account.delinquentAccount === true || normalize(account.billingStatus) === "delinquent") return "overdue";
    return getStatusClass(account.status, account.role);
}

function getLatestRecord(records) {
    return records.slice().sort((left, right) => {
        const leftDate = left.createdAt?.toDate?.() || new Date(0);
        const rightDate = right.createdAt?.toDate?.() || new Date(0);
        return rightDate - leftDate;
    })[0] || null;
}

function getEffectiveAccountStatus(account) {
    if (account.role === "admin") {
        return "Admin";
    }

    if (account.manualBillingHold === true) {
        return "Billing Hold";
    }

    if (account.delinquentAccount === true || normalize(account.billingStatus) === "delinquent") {
        return "Delinquent";
    }

    return formatStatus(account.status || "registered");
}

function getEffectiveAccountStatusKey(account) {
    if (account.role === "admin") {
        return "admin";
    }

    if (account.manualBillingHold === true) {
        return "billing_hold";
    }

    if (account.delinquentAccount === true || normalize(account.billingStatus) === "delinquent") {
        return "delinquent";
    }

    return normalize(account.status || "registered");
}

function syncAccountRowState(accountId, updates = {}) {
    const accountIndex = accountsState.accounts.findIndex((account) => account.id === accountId);
    if (accountIndex === -1) {
        return;
    }

    accountsState.accounts[accountIndex] = {
        ...accountsState.accounts[accountIndex],
        ...updates
    };
}

function createDetailItem(label, value) {
    return `
        <div class="account-detail-item">
            <div class="account-detail-label">${escapeHtml(label)}</div>
            <div class="account-detail-value">${escapeHtml(value || "Not provided")}</div>
        </div>
    `;
}

function renderRecordList(records, type) {
    if (!records.length) {
        return `<div class="account-empty">No ${type} records found for this account.</div>`;
    }

    return records.map((record) => {
        const title = type === "monthly"
            ? `Room ${record.room || "N/A"}, Bed ${record.bed || "N/A"}`
            : `Room ${record.room || "N/A"}, Bed ${record.bed || "N/A"}`;
        const dateLine = type === "monthly"
            ? `Move-in: ${record.moveInDate || formatDate(record.createdAt)}`
            : `Stay: ${formatDate(record.checkInDate)} to ${formatDate(record.checkOutDate)}`;
        return `
            <div class="account-record-card">
                <div class="account-record-title">${escapeHtml(title)}</div>
                <div class="account-record-meta">
                    Status: ${escapeHtml(formatStatus(record.status))}<br>
                    ${escapeHtml(dateLine)}<br>
                    Reference: ${escapeHtml(record.referenceId || record.id || "N/A")}
                </div>
            </div>
        `;
    }).join("");
}

function updateStats() {
    const total = accountsState.accounts.length;
    let noRequest = 0;
    let monthly = 0;
    let transient = 0;

    accountsState.accounts.forEach((account) => {
        const monthlyRecords = getMonthlyRecords(account);
        const transientRecords = getTransientRecords(account);
        if (!monthlyRecords.length && !transientRecords.length) noRequest += 1;
        if (monthlyRecords.length) monthly += 1;
        if (transientRecords.length) transient += 1;
    });

    document.getElementById("statTotalAccounts").textContent = String(total);
    document.getElementById("statNoRequest").textContent = String(noRequest);
    document.getElementById("statMonthly").textContent = String(monthly);
    document.getElementById("statTransient").textContent = String(transient);
}

function renderAccounts() {
    const body = document.getElementById("accountsTableBody");
    if (!body) return;

    accountsState.rows = [];
    body.innerHTML = "";

    if (!accountsState.accounts.length) {
        body.innerHTML = `<tr><td colspan="6">No created accounts found.</td></tr>`;
        return;
    }

    accountsState.accounts.forEach((account) => {
        const name = getDisplayName(account);
        const email = getAccountEmail(account);
        const monthlyRecords = getMonthlyRecords(account);
        const transientRecords = getTransientRecords(account);
        const requestType = getRequestType(monthlyRecords, transientRecords);
        const latestMonthly = getLatestRecord(monthlyRecords);
        const latestTransient = getLatestRecord(transientRecords);
        const statusLabel = getEffectiveAccountStatus(account);
        const row = document.createElement("tr");

        row.innerHTML = `
            <td>
                <div class="account-name-wrap">
                    <div class="account-avatar">${escapeHtml(getInitials(name, email))}</div>
                    <div>
                        <div class="account-name">${escapeHtml(name)}</div>
                        <div class="account-sub">${escapeHtml(account.id)}</div>
                    </div>
                </div>
            </td>
            <td>
                <div class="account-name">${escapeHtml(email || "No email")}</div>
                <div class="account-sub">${escapeHtml(account.phone || account.contactNumber || "No phone")}</div>
            </td>
            <td><span class="status-pill ${getAccountStatusClass(account)}">${escapeHtml(statusLabel)}</span></td>
            <td>
                <div class="request-stack">
                    ${requestType === "none" ? `<span class="request-pill none">No Request</span>` : ""}
                    ${monthlyRecords.length ? `<span class="request-pill monthly">Monthly: ${escapeHtml(formatStatus(latestMonthly?.status))}</span>` : ""}
                    ${transientRecords.length ? `<span class="request-pill transient">Transient: ${escapeHtml(formatStatus(latestTransient?.status))}</span>` : ""}
                </div>
            </td>
            <td>${escapeHtml(formatDate(account.createdAt || account.created_at || account.registeredAt))}</td>
            <td><button type="button" class="tbl-btn" data-id="${escapeHtml(account.id)}">View</button></td>
        `;

        body.appendChild(row);
        accountsState.rows.push({
            element: row,
            account,
            name,
            email,
            phone: account.phone || account.contactNumber || "",
            status: getEffectiveAccountStatusKey(account),
            requestType,
            monthlyRecords,
            transientRecords,
            searchText: `${name} ${email} ${account.phone || ""} ${account.gender || ""} ${account.status || ""} ${account.billingStatus || ""} ${account.manualBillingHoldReason || ""}`.toLowerCase()
        });
    });

    body.querySelectorAll("button[data-id]").forEach((button) => {
        button.addEventListener("click", () => {
            const row = accountsState.rows.find((item) => item.account.id === button.dataset.id);
            if (row) openAccountModal(row);
        });
    });

    updateStats();
    applyAccountFilters();
}

function applyAccountFilters() {
    const search = normalize(document.getElementById("accountSearch")?.value || "");
    const status = normalize(document.getElementById("accountStatusFilter")?.value || "all");
    const requestType = normalize(document.getElementById("accountRequestFilter")?.value || "all");
    let visible = 0;

    accountsState.rows.forEach((row) => {
        const matchesSearch = !search || row.searchText.includes(search);
        const matchesStatus = status === "all" || row.status === status;
        const matchesRequest = requestType === "all" || row.requestType === requestType;
        const show = matchesSearch && matchesStatus && matchesRequest;
        row.element.style.display = show ? "" : "none";
        if (show) visible += 1;
    });

    const summary = document.getElementById("accountsTableSummary");
    if (summary) {
        summary.textContent = `${visible} of ${accountsState.rows.length} accounts shown`;
    }
}

function openAccountModal(row) {
    accountsState.selectedAccount = row;
    const account = row.account;
    const name = getDisplayName(account);
    const email = getAccountEmail(account);

    const billingFlag = account.manualBillingHold === true
        ? "Billing Hold"
        : (account.delinquentAccount === true || normalize(account.billingStatus) === "delinquent")
            ? "Delinquent"
            : "Current";

    document.getElementById("accountModalName").textContent = name;
    document.getElementById("accountModalEmail").textContent = email || "No email";

    document.getElementById("accountDetailGrid").innerHTML = [
        createDetailItem("Account ID", account.id),
        createDetailItem("Name", name),
        createDetailItem("Email", email),
        createDetailItem("Phone", account.phone || account.contactNumber || ""),
        createDetailItem("Gender", account.gender || ""),
        createDetailItem("Role", account.role || "user"),
        createDetailItem("Account Status", getEffectiveAccountStatus(account)),
        createDetailItem("Billing Enforcement", billingFlag),
        createDetailItem("Billing Hold Reason", account.manualBillingHoldReason || ""),
        createDetailItem("Monthly Records", String(row.monthlyRecords.length)),
        createDetailItem("Transient Records", String(row.transientRecords.length))
    ].join("");

    document.getElementById("accountMonthlyRecords").innerHTML = renderRecordList(row.monthlyRecords, "monthly");
    document.getElementById("accountTransientRecords").innerHTML = renderRecordList(row.transientRecords, "transient");
    const applyHoldBtn = document.getElementById("accountApplyBillingHoldBtn");
    const clearHoldBtn = document.getElementById("accountClearBillingHoldBtn");
    if (applyHoldBtn) {
        applyHoldBtn.disabled = account.role === "admin" || account.manualBillingHold === true;
    }
    if (clearHoldBtn) {
        clearHoldBtn.disabled = account.role === "admin" || account.manualBillingHold !== true;
    }
    document.getElementById("accountModal")?.classList.add("open");
    document.body.style.overflow = "hidden";
}

function closeAccountModal() {
    accountsState.selectedAccount = null;
    document.getElementById("accountModal")?.classList.remove("open");
    document.body.style.overflow = "";
}

function handleAccountModalOverlay(event) {
    if (event.target === document.getElementById("accountModal")) {
        closeAccountModal();
    }
}

function exportAccountsPdf() {
    const rows = accountsState.rows.filter((row) => row.element.style.display !== "none");
    const summary = {
        total: accountsState.rows.length,
        shown: rows.length,
        noRequest: accountsState.rows.filter((row) => row.requestType === "none").length,
        monthly: accountsState.rows.filter((row) => row.monthlyRecords.length).length,
        transient: accountsState.rows.filter((row) => row.transientRecords.length).length
    };

    if (!window.jspdf?.jsPDF) {
        const content = [
            "CITIHUB DORMITORY - CREATED ACCOUNTS REPORT",
            "=".repeat(58),
            `Generated: ${new Date().toLocaleString()}`,
            "",
            `Total accounts: ${summary.total}`,
            `Shown accounts: ${summary.shown}`,
            `No request: ${summary.noRequest}`,
            `Monthly request: ${summary.monthly}`,
            `Transient request: ${summary.transient}`,
            "",
            ...rows.map((row) => `${row.name} | ${row.email} | ${row.status} | ${row.requestType}`)
        ].join("\n");
        const blob = new Blob([content], { type: "text/plain" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = "created_accounts_report.txt";
        link.click();
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
    pdf.text("Created Accounts Report", 14, 21);
    pdf.setTextColor(26, 26, 46);

    pdf.setFontSize(10);
    pdf.text(`Generated: ${new Date().toLocaleString()}`, 14, y); y += 8;
    pdf.text(`Total: ${summary.total}   Shown: ${summary.shown}   No Request: ${summary.noRequest}   Monthly: ${summary.monthly}   Transient: ${summary.transient}`, 14, y); y += 12;

    pdf.setFont("helvetica", "bold");
    pdf.text("Name", 14, y);
    pdf.text("Email", 72, y);
    pdf.text("Status", 150, y);
    pdf.text("Request", 190, y);
    pdf.text("Records", 236, y);
    y += 6;
    pdf.setDrawColor(229, 231, 235);
    pdf.line(14, y, pageWidth - 14, y);
    y += 7;
    pdf.setFont("helvetica", "normal");

    rows.forEach((row) => {
        ensureSpace();
        pdf.text(String(row.name || "Unnamed").slice(0, 30), 14, y);
        pdf.text(String(row.email || "No email").slice(0, 42), 72, y);
        pdf.text(String(row.status || "registered").slice(0, 18), 150, y);
        pdf.text(String(row.requestType || "none").slice(0, 18), 190, y);
        pdf.text(`M:${row.monthlyRecords.length} T:${row.transientRecords.length}`, 236, y);
        y += 7;
    });

    pdf.setFontSize(8);
    pdf.setTextColor(107, 114, 128);
    pdf.text("Generated by CitiHub Admin Accounts", 14, pageHeight - 8);
    pdf.save("created_accounts_report.pdf");
}

async function loadAccounts() {
    const body = document.getElementById("accountsTableBody");
    if (body) {
        body.innerHTML = `<tr><td colspan="6">Loading accounts...</td></tr>`;
    }

    try {
        const [usersSnap, monthlySnap, transientSnap] = await Promise.all([
            db.collection("users").get(),
            db.collection("bookingRequest").get(),
            db.collection("transientBedBookings").get()
        ]);

        accountsState.accounts = usersSnap.docs
            .map((doc) => ({ id: doc.id, ...doc.data() }))
            .sort((left, right) => {
                const leftDate = left.createdAt?.toDate?.() || left.registeredAt?.toDate?.() || new Date(0);
                const rightDate = right.createdAt?.toDate?.() || right.registeredAt?.toDate?.() || new Date(0);
                return rightDate - leftDate;
            });
        accountsState.monthlyBookings = monthlySnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
        accountsState.transientBookings = transientSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

        renderAccounts();
    } catch (error) {
        console.error("Failed to load accounts:", error);
        if (body) {
            body.innerHTML = `<tr><td colspan="6">Unable to load created accounts.</td></tr>`;
        }
        showFormalAlert?.("Unable to load created accounts. Please check your connection and Firestore permissions.");
    }
}

async function updateSelectedAccountBillingHold(action) {
    const row = accountsState.selectedAccount;
    if (!row?.account?.id) {
        return;
    }

    const button = action === "apply"
        ? document.getElementById("accountApplyBillingHoldBtn")
        : document.getElementById("accountClearBillingHoldBtn");
    const reason = action === "apply"
        ? window.prompt("Enter the reason for this billing hold:", row.account.manualBillingHoldReason || "Outstanding billing review.")
        : "";

    if (action === "apply" && reason === null) {
        return;
    }

    try {
        if (button && typeof setAdminButtonLoading === "function") {
            setAdminButtonLoading(button, action === "apply" ? "Applying..." : "Removing...");
        }

        await callAdminApi("/api/admin/accounts/set-billing-hold", {
            userId: row.account.id,
            action,
            reason: String(reason || "").trim()
        });

        const updates = action === "apply"
            ? {
                manualBillingHold: true,
                manualBillingHoldReason: String(reason || "").trim() || "Outstanding billing review."
            }
            : {
                manualBillingHold: false,
                manualBillingHoldReason: ""
            };

        row.account = { ...row.account, ...updates };
        syncAccountRowState(row.account.id, updates);
        renderAccounts();
        const refreshedRow = accountsState.rows.find((item) => item.account.id === row.account.id);
        if (refreshedRow) {
            openAccountModal(refreshedRow);
        }

        showFormalAlert?.(action === "apply"
            ? "Billing hold applied to this account."
            : "Billing hold removed from this account.");
    } catch (error) {
        console.error("Failed to update billing hold:", error);
        showFormalAlert?.(error.message || "Unable to update the billing hold right now.");
    } finally {
        if (button && typeof restoreAdminButton === "function") {
            restoreAdminButton(button);
        }
    }
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
    document.getElementById("accountSearch")?.addEventListener("input", applyAccountFilters);
    document.getElementById("accountStatusFilter")?.addEventListener("change", applyAccountFilters);
    document.getElementById("accountRequestFilter")?.addEventListener("change", applyAccountFilters);
    document.getElementById("exportAccountsBtn")?.addEventListener("click", exportAccountsPdf);
    document.getElementById("accountApplyBillingHoldBtn")?.addEventListener("click", () => updateSelectedAccountBillingHold("apply"));
    document.getElementById("accountClearBillingHoldBtn")?.addEventListener("click", () => updateSelectedAccountBillingHold("clear"));
    loadAccounts();
});

window.closeAccountModal = closeAccountModal;
window.handleAccountModalOverlay = handleAccountModalOverlay;

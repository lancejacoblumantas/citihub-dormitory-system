requireAdminAccess();

const dashboardState = {
    rooms: [],
    bookings: [],
    transientBookings: [],
    payments: [],
    users: [],
    maintenanceTickets: []
};

function normalize(value) {
    return String(value || "").trim().toLowerCase();
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function formatCurrency(amount) {
    return new Intl.NumberFormat("en-PH", {
        style: "currency",
        currency: "PHP",
        minimumFractionDigits: 0,
        maximumFractionDigits: 2
    }).format(Number(amount || 0));
}

function toDate(value) {
    if (!value) return null;
    if (typeof value.toDate === "function") return value.toDate();
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDate(value) {
    const date = toDate(value);
    if (!date) return "Unavailable";
    return new Intl.DateTimeFormat("en-PH", {
        month: "short",
        day: "numeric",
        year: "numeric"
    }).format(date);
}

function dateOnly(value) {
    const date = toDate(value);
    if (!date) return "";
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function todayKey() {
    return dateOnly(new Date());
}

function getContractEndDate(booking) {
    return toDate(booking.contractEndAt || booking.contractEndDate);
}

function getExpiringSoonBookings() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return dashboardState.bookings
        .filter((booking) => normalize(booking.status) === "approved")
        .map((booking) => {
            const contractEnd = getContractEndDate(booking);
            if (!contractEnd) return null;
            contractEnd.setHours(0, 0, 0, 0);
            const daysLeft = Math.floor((contractEnd - today) / (1000 * 60 * 60 * 24));
            return { ...booking, contractEnd, daysLeft };
        })
        .filter((booking) => booking && booking.daysLeft >= 0 && booking.daysLeft <= 5)
        .sort((left, right) => left.daysLeft - right.daysLeft);
}

function getFullName(record) {
    return record.fullName || [record.firstName, record.lastName].filter(Boolean).join(" ") || record.email || "Unnamed";
}

function isMaintenanceRoom(room) {
    const avail = normalize(room.avail);
    const occupant = normalize(room.occupant);
    return avail.includes("maintenance") || occupant.includes("maintenance") || avail === "unavailable";
}

function getRoomKey(room, bed) {
    return `${String(room || "").trim()}_${String(bed || "").trim()}`;
}

function getUnifiedRoomCounts() {
    const counts = {
        available: 0,
        monthlyOccupied: 0,
        transientReserved: 0,
        pendingBooking: 0,
        maintenance: 0
    };

    const pendingMonthlyKeys = new Set(dashboardState.bookings
        .filter((booking) => normalize(booking.status) === "pending")
        .map((booking) => getRoomKey(booking.room, booking.bed)));
    const activeTransientKeys = new Set(dashboardState.transientBookings
        .filter((booking) => ["pending_payment", "pending", "approved", "checked_in"].includes(normalize(booking.status)))
        .map((booking) => getRoomKey(booking.room, booking.bed)));

    dashboardState.rooms.forEach((room) => {
        const key = getRoomKey(room.room, room.bedNo || room.bed);
        if (isMaintenanceRoom(room)) {
            counts.maintenance += 1;
        } else if (normalize(room.avail) === "occupied") {
            counts.monthlyOccupied += 1;
        } else if (activeTransientKeys.has(key)) {
            counts.transientReserved += 1;
        } else if (pendingMonthlyKeys.has(key)) {
            counts.pendingBooking += 1;
        } else {
            counts.available += 1;
        }
    });

    return counts;
}

function renderStatCards(counts) {
    const totalBeds = dashboardState.rooms.length;
    const tenants = dashboardState.rooms.filter((room) => normalize(room.avail) === "occupied" && room.occupant).length;
    const occupied = counts.monthlyOccupied + counts.transientReserved;
    const pendingPayments = getPendingPayments();
    const collectedThisMonth = getCollectedThisMonth();

    document.getElementById("stat-dash-cap").textContent = `${totalBeds} capacity`;
    document.getElementById("stat-dash-vacant").textContent = `${counts.available} available, ${counts.maintenance} maintenance`;
    document.getElementById("stat-dash-tenants").textContent = String(tenants);
    document.getElementById("stat-dash-occupied").textContent = String(occupied);
    document.getElementById("stat-dash-pending-payments").textContent = String(pendingPayments.length);
    document.getElementById("stat-dash-pending-payments-note").textContent = pendingPayments.length
        ? `${formatCurrency(pendingPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0))} total due`
        : "No pending payment requests";
    document.getElementById("stat-dash-collected").textContent = formatCurrency(collectedThisMonth.total);
    document.getElementById("stat-dash-collected-note").textContent = `${collectedThisMonth.count} paid transaction${collectedThisMonth.count === 1 ? "" : "s"}`;
}

function renderUnifiedOccupancy(counts) {
    const container = document.getElementById("unifiedOccupancyList");
    if (!container) return;

    const total = Math.max(dashboardState.rooms.length, 1);
    const items = [
        { label: "Available", note: "Ready for monthly or transient booking", count: counts.available, className: "available" },
        { label: "Monthly Occupied", note: "Long-term occupied bedspaces", count: counts.monthlyOccupied, className: "monthly" },
        { label: "Transient Reserved", note: "Short-stay active or reserved beds", count: counts.transientReserved, className: "transient" },
        { label: "Pending Booking", note: "Monthly requests awaiting decision", count: counts.pendingBooking, className: "pending" },
        { label: "Maintenance", note: "Blocked from booking", count: counts.maintenance, className: "maintenance" }
    ];

    container.innerHTML = items.map((item) => {
        const percent = Math.round((item.count / total) * 100);
        return `
            <div class="room-overview-item">
                <div class="ro-info">
                    <div class="ro-name">${escapeHtml(item.label)}</div>
                    <div class="ro-type">${escapeHtml(item.note)}</div>
                </div>
                <div class="ro-right">
                    <div class="ro-count">${item.count} / ${dashboardState.rooms.length}</div>
                    <div class="progress-bar"><div class="progress-fill ${item.className}" style="width:${percent}%;"></div></div>
                    <span class="badge-avail ${item.className}">${percent}%</span>
                </div>
            </div>
        `;
    }).join("");
}

function getPendingPayments() {
    return dashboardState.payments
        .filter((payment) => ["pending", "pending_gateway"].includes(normalize(payment.status)))
        .sort((left, right) => (toDate(left.createdAt) || new Date(0)) - (toDate(right.createdAt) || new Date(0)));
}

function getCollectedThisMonth() {
    const now = new Date();
    const paid = dashboardState.payments.filter((payment) => {
        if (normalize(payment.status) !== "paid") return false;
        const paidDate = toDate(payment.paidAt || payment.updatedAt || payment.createdAt);
        return paidDate &&
            paidDate.getMonth() === now.getMonth() &&
            paidDate.getFullYear() === now.getFullYear();
    });
    return {
        count: paid.length,
        total: paid.reduce((sum, payment) => sum + Number(payment.amount || 0), 0)
    };
}

function renderRecentBookings() {
    const container = document.getElementById("recentBookingsList");
    if (!container) return;

    const recent = dashboardState.bookings
        .slice()
        .sort((left, right) => (toDate(right.createdAt) || new Date(0)) - (toDate(left.createdAt) || new Date(0)))
        .slice(0, 5);

    if (!recent.length) {
        container.innerHTML = `<div class="mini-item"><div class="mini-info"><div class="mini-name">No booking requests yet</div><div class="mini-sub">New monthly requests will appear here.</div></div></div>`;
        return;
    }

    container.innerHTML = recent.map((booking) => {
        const type = normalize(booking.type) === "premium" ? "Premium" : "Standard";
        const status = normalize(booking.status) || "pending";
        return `
            <div class="mini-item">
                <div class="mini-avatar ${type === "Premium" ? "teal" : "green"}">${escapeHtml(getFullName(booking).slice(0, 2).toUpperCase())}</div>
                <div class="mini-info">
                    <div class="mini-name">${escapeHtml(getFullName(booking))}</div>
                    <div class="mini-sub">${type} Room - ${formatDate(booking.createdAt)}</div>
                </div>
                <span class="status-pill ${status === "approved" ? "approved" : status === "rejected" ? "overdue" : "pending"}">${escapeHtml(status.replace(/_/g, " "))}</span>
            </div>
        `;
    }).join("");
}

function renderTodayOperations() {
    const container = document.getElementById("dashboardTodayOps");
    if (!container) return;

    const today = todayKey();
    const pendingBookings = dashboardState.bookings.filter((booking) => normalize(booking.status) === "pending").length;
    const pendingTransient = dashboardState.transientBookings.filter((booking) => normalize(booking.status) === "pending").length;
    const checkIns = dashboardState.transientBookings.filter((booking) => dateOnly(booking.checkInDate) === today && ["approved", "checked_in"].includes(normalize(booking.status))).length;
    const checkOuts = dashboardState.transientBookings.filter((booking) => dateOnly(booking.checkOutDate) === today && normalize(booking.status) === "checked_in").length;
    const unpaidApprovedTransient = dashboardState.transientBookings.filter((booking) => normalize(booking.status) === "approved" && normalize(booking.paymentStatus || "unpaid") !== "paid").length;
    const openMaintenance = dashboardState.maintenanceTickets.filter((ticket) => normalize(ticket.status || "open") !== "resolved").length;
    const expiringSoon = getExpiringSoonBookings().length;

    const items = [
        { label: "Transient check-ins today", value: checkIns, href: "transient-beds.html" },
        { label: "Transient check-outs today", value: checkOuts, href: "transient-beds.html" },
        { label: "Contracts expiring soon", value: expiringSoon, href: "tenants.html" },
        { label: "Pending monthly approvals", value: pendingBookings, href: "bookings.html" },
        { label: "Pending transient approvals", value: pendingTransient, href: "transient-beds.html" },
        { label: "Approved transient unpaid", value: unpaidApprovedTransient, href: "transient-beds.html" },
        { label: "Open maintenance tickets", value: openMaintenance, href: "maintenance.html" }
    ];

    container.innerHTML = items.map((item) => `
        <a class="dashboard-op-item" href="${item.href}">
            <div>
                <div class="dashboard-op-label">${escapeHtml(item.label)}</div>
                <div class="dashboard-op-note">${item.value ? "Needs admin attention" : "Clear"}</div>
            </div>
            <strong>${item.value}</strong>
        </a>
    `).join("");
}

function renderActionQueue() {
    const container = document.getElementById("dashboardActionQueue");
    if (!container) return;

    const queue = [];
    const oldestPending = dashboardState.bookings
        .filter((booking) => normalize(booking.status) === "pending")
        .sort((left, right) => (toDate(left.createdAt) || new Date(0)) - (toDate(right.createdAt) || new Date(0)))[0];
    const oldestTransient = dashboardState.transientBookings
        .filter((booking) => normalize(booking.status) === "pending")
        .sort((left, right) => (toDate(left.createdAt) || new Date(0)) - (toDate(right.createdAt) || new Date(0)))[0];
    const pendingPayment = getPendingPayments()[0];
    const expiringSoon = getExpiringSoonBookings()[0];
    const maintenance = dashboardState.maintenanceTickets
        .filter((ticket) => normalize(ticket.status || "open") !== "resolved")
        .sort((left, right) => (toDate(left.createdAt) || new Date(0)) - (toDate(right.createdAt) || new Date(0)))[0];
    const accountsNoRequest = dashboardState.users.filter((user) => {
        const email = normalize(user.email);
        const hasMonthly = dashboardState.bookings.some((booking) => booking.userId === user.id || (email && normalize(booking.email) === email));
        const hasTransient = dashboardState.transientBookings.some((booking) => booking.userId === user.id || (email && normalize(booking.email) === email));
        return normalize(user.role) !== "admin" && !hasMonthly && !hasTransient;
    }).length;

    if (oldestPending) queue.push({ title: "Review monthly booking", note: `${getFullName(oldestPending)} - ${formatDate(oldestPending.createdAt)}`, href: "bookings.html", tone: "amber" });
    if (oldestTransient) queue.push({ title: "Review transient request", note: `${getFullName(oldestTransient)} - ${formatDate(oldestTransient.createdAt)}`, href: "transient-beds.html", tone: "teal" });
    if (expiringSoon) queue.push({ title: "Contract expiring soon", note: `${getFullName(expiringSoon)} - ends ${formatDate(expiringSoon.contractEnd)} (${expiringSoon.daysLeft} day${expiringSoon.daysLeft === 1 ? "" : "s"} left)`, href: "tenants.html", tone: "amber" });
    if (pendingPayment) queue.push({ title: "Check pending payment", note: `${pendingPayment.tenantName || "Tenant"} - ${formatCurrency(pendingPayment.amount)}`, href: "billing.html", tone: "red" });
    if (maintenance) queue.push({ title: "Resolve maintenance ticket", note: maintenance.subject || maintenance.description || "Open maintenance ticket", href: "maintenance.html", tone: "red" });
    if (accountsNoRequest) queue.push({ title: "Accounts with no request", note: `${accountsNoRequest} registered account${accountsNoRequest === 1 ? "" : "s"} have no booking yet`, href: "accounts.html", tone: "green" });

    if (!queue.length) {
        container.innerHTML = `<div class="dashboard-action-empty">No urgent actions right now.</div>`;
        return;
    }

    container.innerHTML = queue.slice(0, 6).map((item) => `
        <a class="dashboard-action-item ${item.tone}" href="${item.href}">
            <div>
                <div class="dashboard-action-title">${escapeHtml(item.title)}</div>
                <div class="dashboard-action-note">${escapeHtml(item.note)}</div>
            </div>
            <span>Open</span>
        </a>
    `).join("");
}

function renderPendingPaymentsTable() {
    const tbody = document.getElementById("dashboardPendingPaymentsBody");
    if (!tbody) return;

    const pendingRecords = getPendingPayments();
    if (!pendingRecords.length) {
        tbody.innerHTML = `<tr><td colspan="7"><div class="mini-info"><div class="mini-name">No pending payments</div><div class="mini-sub">All recorded transactions are currently settled or cancelled.</div></div></td></tr>`;
        return;
    }

    tbody.innerHTML = pendingRecords.slice(0, 5).map((payment) => {
        const created = toDate(payment.createdAt) || new Date();
        const dueDate = new Date(created);
        dueDate.setDate(dueDate.getDate() + 5);
        const isOverdue = dueDate < new Date();
        return `
            <tr>
                <td><div class="td-name">${escapeHtml(payment.tenantName || "Tenant")}</div></td>
                <td>${escapeHtml(payment.room ? `Room ${payment.room}${payment.bed ? ` - Bed ${payment.bed}` : ""}` : "No room")}</td>
                <td>${escapeHtml(payment.billingMonth || payment.type || "Payment")}</td>
                <td class="td-amount">${formatCurrency(payment.amount)}</td>
                <td class="td-due ${isOverdue ? "overdue" : ""}">${formatDate(dueDate)}</td>
                <td><span class="status-pill ${isOverdue ? "overdue" : "pending"}">${isOverdue ? "Overdue" : "Pending"}</span></td>
                <td><a class="tbl-btn" href="billing.html">View</a></td>
            </tr>
        `;
    }).join("");
}

function renderDashboard() {
    const now = new Date();
    const dateLabel = document.getElementById("dashboardDateLabel");
    if (dateLabel) {
        dateLabel.textContent = `CitiHub Dormitory - ${new Intl.DateTimeFormat("en-PH", { month: "long", day: "numeric", year: "numeric" }).format(now)}`;
    }

    const counts = getUnifiedRoomCounts();
    renderStatCards(counts);
    renderUnifiedOccupancy(counts);
    renderRecentBookings();
    renderTodayOperations();
    renderActionQueue();
    renderPendingPaymentsTable();
}

async function loadDashboardData() {
    try {
        await syncContractExpirationAlerts();

        const [roomsSnap, bookingsSnap, transientSnap, paymentsSnap, usersSnap, maintenanceSnap] = await Promise.all([
            db.collection("ROOMS").get(),
            db.collection("bookingRequest").get(),
            db.collection("transientBedBookings").get(),
            db.collection("payments").get(),
            db.collection("users").get(),
            db.collection("maintenanceTickets").get()
        ]);

        dashboardState.rooms = roomsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
        dashboardState.bookings = bookingsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
        dashboardState.transientBookings = transientSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
        dashboardState.payments = paymentsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
        dashboardState.users = usersSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
        dashboardState.maintenanceTickets = maintenanceSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

        renderDashboard();
    } catch (error) {
        console.error("Failed to load dashboard data:", error);
        showFormalAlert?.("Unable to load dashboard data. Please refresh the page.");
    }
}

async function syncContractExpirationAlerts() {
    try {
        await callAdminApi("/api/admin/contracts/sync-expiration-alerts", {});
    } catch (error) {
        console.warn("Unable to sync contract expiration alerts:", error);
    }
}

function downloadReport(label) {
    const counts = getUnifiedRoomCounts();
    const pendingPayments = getPendingPayments();
    const collected = getCollectedThisMonth();
    const today = todayKey();
    const operations = [
        ["Transient check-ins today", dashboardState.transientBookings.filter((booking) => dateOnly(booking.checkInDate) === today && ["approved", "checked_in"].includes(normalize(booking.status))).length],
        ["Transient check-outs today", dashboardState.transientBookings.filter((booking) => dateOnly(booking.checkOutDate) === today && normalize(booking.status) === "checked_in").length],
        ["Pending monthly approvals", dashboardState.bookings.filter((booking) => normalize(booking.status) === "pending").length],
        ["Pending transient approvals", dashboardState.transientBookings.filter((booking) => normalize(booking.status) === "pending").length],
        ["Approved transient unpaid", dashboardState.transientBookings.filter((booking) => normalize(booking.status) === "approved" && normalize(booking.paymentStatus || "unpaid") !== "paid").length],
        ["Open maintenance tickets", dashboardState.maintenanceTickets.filter((ticket) => normalize(ticket.status || "open") !== "resolved").length]
    ];

    if (!window.jspdf?.jsPDF) {
        const content = [
            `CITIHUB DORMITORY - ${label.toUpperCase()} REPORT`,
            "=".repeat(58),
            `Generated: ${new Date().toLocaleString()}`,
            "",
            "OCCUPANCY SUMMARY",
            `Available: ${counts.available}`,
            `Monthly occupied: ${counts.monthlyOccupied}`,
            `Transient reserved: ${counts.transientReserved}`,
            `Pending booking: ${counts.pendingBooking}`,
            `Maintenance: ${counts.maintenance}`,
            "",
            "PAYMENTS",
            `Pending payments: ${pendingPayments.length}`,
            `Collected this month: ${formatCurrency(collected.total)}`
        ].join("\n");
        const blob = new Blob([content], { type: "text/plain" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${label.replace(/\s+/g, "_").toLowerCase()}_report.txt`;
        a.click();
        return;
    }

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF();
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    let y = 18;

    const ensureSpace = (needed = 16) => {
        if (y + needed > pageHeight - 16) {
            pdf.addPage();
            y = 18;
        }
    };
    const addHeader = () => {
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
        y = 40;
    };
    const addSection = (title) => {
        ensureSpace(14);
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(12);
        pdf.setTextColor(26, 122, 74);
        pdf.text(title, 14, y);
        y += 7;
        pdf.setDrawColor(229, 231, 235);
        pdf.line(14, y, pageWidth - 14, y);
        y += 8;
        pdf.setTextColor(26, 26, 46);
    };
    const addRow = (labelText, valueText) => {
        ensureSpace(8);
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(10);
        pdf.text(String(labelText), 18, y);
        pdf.setFont("helvetica", "normal");
        pdf.text(String(valueText), 98, y);
        y += 7;
    };

    addHeader();
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(10);
    pdf.text(`Generated: ${new Date().toLocaleString()}`, 14, y);
    y += 10;

    addSection("Executive Summary");
    addRow("Total bedspaces", dashboardState.rooms.length);
    addRow("Occupied beds", counts.monthlyOccupied + counts.transientReserved);
    addRow("Available beds", counts.available);
    addRow("Pending payments", `${pendingPayments.length} (${formatCurrency(pendingPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0))})`);
    addRow("Collected this month", `${formatCurrency(collected.total)} from ${collected.count} paid transaction${collected.count === 1 ? "" : "s"}`);

    addSection("Unified Occupancy");
    addRow("Available", counts.available);
    addRow("Monthly occupied", counts.monthlyOccupied);
    addRow("Transient reserved", counts.transientReserved);
    addRow("Pending booking", counts.pendingBooking);
    addRow("Maintenance", counts.maintenance);

    addSection("Today's Operations");
    operations.forEach(([name, value]) => addRow(name, value));

    addSection("Recent Pending Payments");
    if (!pendingPayments.length) {
        addRow("Status", "No pending payments");
    } else {
        pendingPayments.slice(0, 8).forEach((payment) => {
            addRow(payment.tenantName || "Tenant", `${formatCurrency(payment.amount)} - ${payment.status || "pending"}`);
        });
    }

    pdf.setFontSize(8);
    pdf.setTextColor(107, 114, 128);
    pdf.text("Generated by CitiHub Admin Dashboard", 14, pageHeight - 10);
    pdf.save(`${label.replace(/\s+/g, "_").toLowerCase()}_dashboard_report.pdf`);
}

function bindChrome() {
    const avatarContainer = document.querySelector(".avatar-container");
    avatarContainer?.addEventListener("click", function (event) {
        this.classList.toggle("open");
        event.stopPropagation();
    });
    document.addEventListener("click", () => avatarContainer?.classList.remove("open"));
    document.querySelectorAll("#btnLogout, .avatar-dropdown .dropdown-item[href*='adminlogin']").forEach((button) => {
        button.addEventListener("click", logoutAdmin);
    });
}

document.addEventListener("DOMContentLoaded", () => {
    bindChrome();
    loadDashboardData();
});

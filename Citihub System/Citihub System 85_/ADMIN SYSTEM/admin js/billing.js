let billingRecords = [];
let billingFilteredRecords = [];
let invoiceRecords = [];
let invoiceFilteredRecords = [];
const expandedInvoiceAccountKeys = new Set();
let billingUnsubscribe = null;
let invoiceUnsubscribe = null;

function renderBillingSnapshot(snapshot) {
    billingRecords = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data()
    }));

    updateBillingStats(billingRecords);
    applyBillingFilters();
}

function renderInvoiceSnapshot(snapshot) {
    invoiceRecords = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data()
    }));

    applyInvoiceFilters();
}

function formatBillingCurrency(amount) {
    return new Intl.NumberFormat("en-PH", {
        style: "currency",
        currency: "PHP",
        minimumFractionDigits: 2
    }).format(Number(amount || 0));
}

function escapeBillingHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function formatBillingDate(value) {
    if (!value) {
        return "Unavailable";
    }

    const date = typeof value.toDate === "function" ? value.toDate() : new Date(value);
    if (Number.isNaN(date.getTime())) {
        return "Unavailable";
    }

    return new Intl.DateTimeFormat("en-PH", {
        month: "short",
        day: "numeric",
        year: "numeric"
    }).format(date);
}

function formatBillingDateTime(timestamp) {
    if (!timestamp) {
        return "Unavailable";
    }

    const date = typeof timestamp.toDate === "function" ? timestamp.toDate() : new Date(timestamp);
    if (Number.isNaN(date.getTime())) {
        return "Unavailable";
    }

    return new Intl.DateTimeFormat("en-PH", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit"
    }).format(date);
}

function formatBillingExportDateTime(value) {
    const formatted = formatBillingDateTime(value);
    return formatted === "Unavailable" ? "" : formatted;
}

function formatBillingExportDate(value) {
    const formatted = formatBillingDate(value);
    return formatted === "Unavailable" ? "" : formatted;
}

function getBillingTimestampValue(value) {
    if (!value) {
        return 0;
    }

    const date = typeof value.toDate === "function" ? value.toDate() : new Date(value);
    const time = date.getTime();
    return Number.isNaN(time) ? 0 : time;
}

function normalizeBillingMethodValue(method) {
    const safeMethod = String(method || "").trim().toLowerCase();
    if (safeMethod === "shopeepay") {
        return "shopee_pay";
    }

    return safeMethod;
}

function getBillingInitials(name) {
    return String(name || "Tenant")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part.charAt(0).toUpperCase())
        .join("") || "T";
}

function getBillingStatusConfig(status) {
    if (status === "paid") {
        return { label: "Paid", className: "paid" };
    }

    if (status === "unpaid") {
        return { label: "Unpaid", className: "unpaid" };
    }

    if (status === "deducted_by_deposit") {
        return { label: "Deducted by Deposit", className: "deducted" };
    }

    if (status === "failed") {
        return { label: "Failed", className: "failed" };
    }

    if (status === "cancelled") {
        return { label: "Cancelled", className: "cancelled" };
    }

    if (status === "pending_gateway") {
        return { label: "Pending Gateway", className: "gateway" };
    }

    return { label: "Pending", className: "pending" };
}

function formatInvoiceType(type) {
    if (type === "first_prorated_rent") return "First Prorated Rent";
    if (type === "final_rent") return "Final Month Rent";
    if (type === "monthly_rent") return "Monthly Rent";
    return String(type || "Invoice").replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function getInvoiceDateValue(value) {
    if (!value) {
        return null;
    }

    const date = typeof value.toDate === "function" ? value.toDate() : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function createInvoiceAccountKey(invoice) {
    const userId = String(invoice.userId || "").trim();
    if (userId) {
        return `user:${userId}`;
    }

    const email = String(invoice.tenantEmail || "").trim().toLowerCase();
    if (email) {
        return `email:${email}`;
    }

    const bookingId = String(invoice.bookingRequestId || invoice.bookingReferenceId || "").trim();
    if (bookingId) {
        return `booking:${bookingId}`;
    }

    return `invoice:${invoice.id}`;
}

function getInvoiceRoomLabel(invoice) {
    const roomLabel = invoice.room ? `Room ${invoice.room}` : "No room";
    const bedLabel = invoice.bed ? ` - Bed ${invoice.bed}` : "";
    return `${roomLabel}${bedLabel}`;
}

function getInvoiceAccountStatus(invoices) {
    if (invoices.some((invoice) => invoice.status === "pending_gateway")) {
        return getBillingStatusConfig("pending_gateway");
    }

    if (invoices.some((invoice) => !["paid", "deducted_by_deposit"].includes(invoice.status || "unpaid"))) {
        return getBillingStatusConfig("unpaid");
    }

    if (invoices.some((invoice) => invoice.status === "paid")) {
        return getBillingStatusConfig("paid");
    }

    return getBillingStatusConfig("deducted_by_deposit");
}

function buildInvoiceAccountGroups(records) {
    const groupsByKey = new Map();

    records.forEach((invoice) => {
        const key = createInvoiceAccountKey(invoice);
        const existing = groupsByKey.get(key) || {
            key,
            tenantName: invoice.tenantName || "Tenant",
            tenantEmail: invoice.tenantEmail || "",
            userId: invoice.userId || "",
            invoices: [],
            bookingRefs: new Set(),
            roomLabels: new Set(),
            totalAmount: 0,
            outstandingAmount: 0,
            paidAmount: 0,
            nextDueDate: null
        };

        existing.invoices.push(invoice);
        existing.tenantName = existing.tenantName === "Tenant" ? (invoice.tenantName || existing.tenantName) : existing.tenantName;
        existing.tenantEmail = existing.tenantEmail || invoice.tenantEmail || "";

        const bookingRef = invoice.bookingReferenceId || invoice.bookingRequestId || "";
        if (bookingRef) {
            existing.bookingRefs.add(bookingRef);
        }

        existing.roomLabels.add(getInvoiceRoomLabel(invoice));
        existing.totalAmount += Number(invoice.amount || 0);

        if (invoice.status === "paid" || invoice.status === "deducted_by_deposit") {
            existing.paidAmount += Number(invoice.amount || 0);
        } else {
            existing.outstandingAmount += Number(invoice.amount || 0);
            const dueDate = getInvoiceDateValue(invoice.dueDate);
            if (dueDate && (!existing.nextDueDate || dueDate < existing.nextDueDate)) {
                existing.nextDueDate = dueDate;
            }
        }

        groupsByKey.set(key, existing);
    });

    return [...groupsByKey.values()]
        .map((group) => ({
            ...group,
            invoices: group.invoices.sort((left, right) => {
                const leftDate = getInvoiceDateValue(left.dueDate)?.getTime() || 0;
                const rightDate = getInvoiceDateValue(right.dueDate)?.getTime() || 0;
                return leftDate - rightDate;
            })
        }))
        .sort((left, right) => {
            const leftDue = left.nextDueDate?.getTime() || Number.MAX_SAFE_INTEGER;
            const rightDue = right.nextDueDate?.getTime() || Number.MAX_SAFE_INTEGER;
            if (leftDue !== rightDue) {
                return leftDue - rightDue;
            }

            return String(left.tenantName).localeCompare(String(right.tenantName));
        });
}

function escapeBillingCsv(value) {
    const text = String(value ?? "");
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadBillingTextFile(filename, content, type = "text/csv;charset=utf-8") {
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

function getBillingExportDateStamp() {
    return new Date().toISOString().slice(0, 10);
}

function getInvoiceAccountSummaryRows() {
    return buildInvoiceAccountGroups(invoiceFilteredRecords).map((group) => {
        const status = getInvoiceAccountStatus(group.invoices);
        return {
            type: "Invoice Account Summary",
            tenant: group.tenantName || "Tenant",
            email: group.tenantEmail || "",
            bookingRef: [...group.bookingRefs].join("; "),
            room: [...group.roomLabels].join("; "),
            invoiceMonth: "",
            invoiceType: `${group.invoices.length} invoice${group.invoices.length === 1 ? "" : "s"}`,
            date: group.nextDueDate ? formatBillingExportDate(group.nextDueDate) : "",
            method: "",
            status: status.label,
            grossAmount: "",
            depositCredit: "",
            amount: Number(group.totalAmount || 0).toFixed(2),
            outstanding: Number(group.outstandingAmount || 0).toFixed(2),
            recordId: group.key
        };
    });
}

function getBillingTransactionExportRows() {
    return billingFilteredRecords.map((record) => ({
        type: "Payment Transaction",
        tenant: record.tenantName || "Tenant",
        email: record.tenantEmail || "",
        bookingRef: record.bookingReferenceId || record.bookingRequestId || "",
        room: `${record.room ? `Room ${record.room}` : "No room"}${record.bed ? ` - Bed ${record.bed}` : ""}`,
        invoiceMonth: "",
        invoiceType: record.type === "down_payment" ? "Down Payment" : (record.type || "Payment"),
        date: formatBillingExportDateTime(record.paidAt || record.createdAt),
        method: getBillingMethodConfig(record.method).label,
        status: getBillingStatusConfig(record.status).label,
        grossAmount: "",
        depositCredit: "",
        amount: Number(record.amount || 0).toFixed(2),
        outstanding: record.status === "paid" ? "0.00" : Number(record.amount || 0).toFixed(2),
        recordId: record.id
    }));
}

function getBillingInvoiceExportRows() {
    return invoiceFilteredRecords.map((invoice) => ({
        type: "Billing Invoice",
        tenant: invoice.tenantName || "Tenant",
        email: invoice.tenantEmail || "",
        bookingRef: invoice.bookingReferenceId || invoice.bookingRequestId || "",
        room: getInvoiceRoomLabel(invoice),
        invoiceMonth: invoice.billingMonth || "",
        invoiceType: formatInvoiceType(invoice.invoiceType),
        date: formatBillingExportDate(invoice.dueDate),
        method: "",
        status: getBillingStatusConfig(invoice.status || "unpaid").label,
        grossAmount: Number(invoice.grossAmount || 0).toFixed(2),
        depositCredit: Number(invoice.depositCredit || 0).toFixed(2),
        amount: Number(invoice.amount || 0).toFixed(2),
        outstanding: ["paid", "deducted_by_deposit"].includes(invoice.status || "unpaid")
            ? "0.00"
            : Number(invoice.amount || 0).toFixed(2),
        recordId: invoice.id
    }));
}

function downloadBillingCsv() {
    const rows = [
        ...getInvoiceAccountSummaryRows(),
        ...getBillingInvoiceExportRows(),
        ...getBillingTransactionExportRows()
    ];

    if (!rows.length) {
        showFormalAlert?.("There are no billing records to export using the current filters.");
        return;
    }

    const headers = [
        "Record Type",
        "Tenant",
        "Email",
        "Booking Reference",
        "Room/Bed",
        "Invoice Month",
        "Type",
        "Date",
        "Payment Method",
        "Status",
        "Gross Amount",
        "Deposit Credit",
        "Amount",
        "Outstanding",
        "Record ID"
    ];

    const lines = [
        headers.map(escapeBillingCsv).join(","),
        ...rows.map((row) => [
            row.type,
            row.tenant,
            row.email,
            row.bookingRef,
            row.room,
            row.invoiceMonth,
            row.invoiceType,
            row.date,
            row.method,
            row.status,
            row.grossAmount,
            row.depositCredit,
            row.amount,
            row.outstanding,
            row.recordId
        ].map(escapeBillingCsv).join(","))
    ];

    downloadBillingTextFile(`citihub_billing_export_${getBillingExportDateStamp()}.csv`, lines.join("\n"));
    showFormalAlert?.("Billing CSV export has been downloaded.");
}

function addBillingPdfHeader(pdf, title) {
    const pageWidth = pdf.internal.pageSize.getWidth();

    pdf.setFillColor(26, 122, 74);
    pdf.rect(0, 0, pageWidth, 28, "F");
    pdf.setTextColor(255, 255, 255);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(16);
    pdf.text("CITIHUB DORMITORY", 14, 13);
    pdf.setFontSize(10);
    pdf.setFont("helvetica", "normal");
    pdf.text(title, 14, 21);
    pdf.setTextColor(26, 26, 46);
}

function downloadBillingPdf() {
    const invoiceGroups = buildInvoiceAccountGroups(invoiceFilteredRecords);

    if (!billingFilteredRecords.length && !invoiceGroups.length) {
        showFormalAlert?.("There are no billing records to export using the current filters.");
        return;
    }

    if (!window.jspdf?.jsPDF) {
        const content = [
            "CITIHUB DORMITORY - BILLING REPORT",
            "=".repeat(42),
            `Generated: ${new Date().toLocaleString()}`,
            `Filtered invoice accounts: ${invoiceGroups.length}`,
            `Filtered invoices: ${invoiceFilteredRecords.length}`,
            `Filtered transactions: ${billingFilteredRecords.length}`,
            "",
            "Invoice Accounts",
            ...invoiceGroups.map((group) => {
                const status = getInvoiceAccountStatus(group.invoices);
                return `${group.tenantName || "Tenant"} | ${[...group.roomLabels].join("; ")} | ${group.invoices.length} invoice(s) | Total ${formatBillingCurrency(group.totalAmount)} | Outstanding ${formatBillingCurrency(group.outstandingAmount)} | ${status.label}`;
            }),
            "",
            "Payment Transactions",
            ...billingFilteredRecords.map((record) => `${record.tenantName || "Tenant"} | ${record.bookingReferenceId || record.bookingRequestId || "N/A"} | ${formatBillingCurrency(record.amount)} | ${getBillingStatusConfig(record.status).label}`)
        ].join("\n");

        downloadBillingTextFile(`citihub_billing_report_${getBillingExportDateStamp()}.txt`, content, "text/plain;charset=utf-8");
        showFormalAlert?.("PDF generator was unavailable, so a text billing report was downloaded.");
        return;
    }

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: "landscape" });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    let y = 38;

    const ensureSpace = (needed = 8) => {
        if (y + needed > pageHeight - 14) {
            pdf.addPage();
            y = 18;
        }
    };

    addBillingPdfHeader(pdf, "Billing Report");

    const paidAmount = billingFilteredRecords
        .filter((record) => record.status === "paid")
        .reduce((sum, record) => sum + Number(record.amount || 0), 0);
    const outstandingAmount = invoiceGroups.reduce((sum, group) => sum + Number(group.outstandingAmount || 0), 0);

    pdf.setFontSize(10);
    pdf.setFont("helvetica", "normal");
    pdf.text(`Generated: ${new Date().toLocaleString()}`, 14, y); y += 8;
    pdf.text(`Invoice accounts: ${invoiceGroups.length}   Invoices: ${invoiceFilteredRecords.length}   Transactions: ${billingFilteredRecords.length}`, 14, y); y += 8;
    pdf.text(`Collected in filtered transactions: ${formatBillingCurrency(paidAmount)}   Outstanding in filtered invoices: ${formatBillingCurrency(outstandingAmount)}`, 14, y); y += 12;

    pdf.setFont("helvetica", "bold");
    pdf.text("Tenant Invoice Accounts", 14, y); y += 8;
    pdf.setFontSize(9);
    pdf.text("Tenant", 14, y);
    pdf.text("Room", 74, y);
    pdf.text("Invoices", 118, y);
    pdf.text("Next Due", 144, y);
    pdf.text("Total", 184, y);
    pdf.text("Outstanding", 222, y);
    pdf.text("Status", 262, y);
    y += 5;
    pdf.setDrawColor(229, 231, 235);
    pdf.line(14, y, pageWidth - 14, y);
    y += 7;
    pdf.setFont("helvetica", "normal");

    invoiceGroups.forEach((group) => {
        ensureSpace();
        const status = getInvoiceAccountStatus(group.invoices);
        pdf.text(String(group.tenantName || "Tenant").slice(0, 30), 14, y);
        pdf.text(String([...group.roomLabels].join("; ") || "No room").slice(0, 22), 74, y);
        pdf.text(String(group.invoices.length), 118, y);
        pdf.text(String(group.nextDueDate ? formatBillingDate(group.nextDueDate) : "No unpaid due").slice(0, 18), 144, y);
        pdf.text(String(formatBillingCurrency(group.totalAmount)).slice(0, 18), 184, y);
        pdf.text(String(formatBillingCurrency(group.outstandingAmount)).slice(0, 18), 222, y);
        pdf.text(status.label.slice(0, 18), 262, y);
        y += 7;
    });

    y += 6;
    ensureSpace(18);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(10);
    pdf.text("Payment Transactions", 14, y); y += 8;
    pdf.setFontSize(9);
    pdf.text("Tenant", 14, y);
    pdf.text("Booking", 74, y);
    pdf.text("Amount", 122, y);
    pdf.text("Method", 160, y);
    pdf.text("Status", 198, y);
    pdf.text("Paid/Created", 238, y);
    y += 5;
    pdf.line(14, y, pageWidth - 14, y);
    y += 7;
    pdf.setFont("helvetica", "normal");

    billingFilteredRecords.forEach((record) => {
        ensureSpace();
        pdf.text(String(record.tenantName || "Tenant").slice(0, 30), 14, y);
        pdf.text(String(record.bookingReferenceId || record.bookingRequestId || "N/A").slice(0, 24), 74, y);
        pdf.text(String(formatBillingCurrency(record.amount)).slice(0, 18), 122, y);
        pdf.text(getBillingMethodConfig(record.method).label.slice(0, 18), 160, y);
        pdf.text(getBillingStatusConfig(record.status).label.slice(0, 18), 198, y);
        pdf.text(formatBillingExportDateTime(record.paidAt || record.createdAt).slice(0, 24), 238, y);
        y += 7;
    });

    pdf.setFontSize(8);
    pdf.setTextColor(107, 114, 128);
    pdf.text("Generated by CitiHub Admin Billing", 14, pageHeight - 8);
    pdf.save(`citihub_billing_report_${getBillingExportDateStamp()}.pdf`);
    showFormalAlert?.("Billing PDF report has been downloaded.");
}

function getBillingMethodConfig(method) {
    if (method === "card") {
        return { label: "Card", className: "card" };
    }

    if (method === "maya") {
        return { label: "Maya", className: "maya" };
    }

    if (method === "grab_pay") {
        return { label: "GrabPay", className: "grab-pay" };
    }

    if (method === "shopeepay" || method === "shopee_pay") {
        return { label: "ShopeePay", className: "shopeepay" };
    }

    if (method === "qrph") {
        return { label: "QR Ph", className: "qrph" };
    }

    if (method === "online_banking") {
        return { label: "Online Banking", className: "online-banking" };
    }

    if (method === "billease") {
        return { label: "BillEase", className: "billease" };
    }

    return { label: "GCash", className: "gcash" };
}

function getBillingAvatarColor(method) {
    if (method === "card") {
        return "teal";
    }

    if (method === "maya") {
        return "amber";
    }

    if (method === "grab_pay" || method === "shopeepay" || method === "shopee_pay" || method === "online_banking") {
        return "blue";
    }

    if (method === "qrph" || method === "billease") {
        return "teal";
    }

    return "green";
}

function updateBillingStats(records) {
    const totalTransactions = records.length;
    const pendingGatewayCount = records.filter((record) => record.status === "pending_gateway").length;
    const paidCount = records.filter((record) => record.status === "paid").length;
    const collectedAmount = records
        .filter((record) => record.status === "paid")
        .reduce((sum, record) => sum + Number(record.amount || 0), 0);

    document.getElementById("billingTotalTransactions").textContent = String(totalTransactions);
    document.getElementById("billingPendingTransactions").textContent = String(pendingGatewayCount);
    document.getElementById("billingPaidTransactions").textContent = String(paidCount);
    document.getElementById("billingCollectedAmount").textContent = formatBillingCurrency(collectedAmount);

    const note = totalTransactions === 0
        ? "No payment requests yet"
        : `${paidCount} settled and ${pendingGatewayCount} still waiting for checkout completion`;
    document.getElementById("billingTransactionNote").textContent = note;
}

function applyBillingFilters() {
    const searchValue = String(document.getElementById("billingSearchInput")?.value || "").trim().toLowerCase();
    const statusFilter = document.getElementById("billingStatusFilter")?.value || "all";
    const methodFilter = document.getElementById("billingMethodFilter")?.value || "all";
    const dateSort = document.getElementById("billingDateSort")?.value || "recent";

    billingFilteredRecords = billingRecords.filter((record) => {
        const matchesStatus = statusFilter === "all" || record.status === statusFilter;
        const matchesMethod = methodFilter === "all"
            || normalizeBillingMethodValue(record.method) === normalizeBillingMethodValue(methodFilter);

        const haystack = [
            record.tenantName,
            record.tenantEmail,
            record.bookingReferenceId,
            record.room,
            record.bed,
            record.method,
            record.status
        ].join(" ").toLowerCase();

        const matchesSearch = !searchValue || haystack.includes(searchValue);
        return matchesStatus && matchesMethod && matchesSearch;
    }).sort((left, right) => {
        const leftTime = getBillingTimestampValue(left.createdAt);
        const rightTime = getBillingTimestampValue(right.createdAt);

        if (dateSort === "oldest") {
            return leftTime - rightTime;
        }

        return rightTime - leftTime;
    });

    renderBillingTable();
}

function applyInvoiceFilters() {
    const searchValue = String(document.getElementById("invoiceSearchInput")?.value || "").trim().toLowerCase();
    const statusFilter = document.getElementById("invoiceStatusFilter")?.value || "all";
    const typeFilter = document.getElementById("invoiceTypeFilter")?.value || "all";

    invoiceFilteredRecords = invoiceRecords.filter((invoice) => {
        const matchesStatus = statusFilter === "all" || invoice.status === statusFilter;
        const matchesType = typeFilter === "all" || invoice.invoiceType === typeFilter;
        const haystack = [
            invoice.tenantName,
            invoice.tenantEmail,
            invoice.bookingReferenceId,
            invoice.bookingRequestId,
            invoice.billingMonth,
            invoice.invoiceType,
            invoice.room,
            invoice.bed,
            invoice.status
        ].join(" ").toLowerCase();

        const matchesSearch = !searchValue || haystack.includes(searchValue);
        return matchesStatus && matchesType && matchesSearch;
    });

    renderInvoiceTable();
}

function renderBillingTable() {
    const tbody = document.getElementById("billingTableBody");
    const caption = document.getElementById("billingTableCaption");

    if (!tbody || !caption) {
        return;
    }

    caption.textContent = billingFilteredRecords.length === billingRecords.length
        ? `${billingRecords.length} transaction${billingRecords.length === 1 ? "" : "s"} loaded`
        : `Showing ${billingFilteredRecords.length} of ${billingRecords.length} transactions`;

    if (!billingFilteredRecords.length) {
        tbody.innerHTML = `
            <tr>
                <td colspan="9" class="billing-empty-cell">No tenant transactions matched the current filters.</td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = billingFilteredRecords.map((record) => {
        const status = getBillingStatusConfig(record.status);
        const method = getBillingMethodConfig(record.method);
        const avatarColor = getBillingAvatarColor(record.method);
        const roomLabel = record.room ? `Room ${record.room}` : "No room";
        const bedLabel = record.bed ? ` - Bed ${record.bed}` : "";

        return `
            <tr>
                <td>
                    <div class="td-tenant">
                        <div class="td-avatar ${avatarColor}">${getBillingInitials(record.tenantName)}</div>
                        <div>
                            <div class="td-name">${record.tenantName || "Tenant"}</div>
                            <div class="td-email">${record.tenantEmail || "No email recorded"}</div>
                        </div>
                    </div>
                </td>
                <td>${record.bookingReferenceId || record.bookingRequestId || "N/A"}</td>
                <td>${roomLabel}${bedLabel}</td>
                <td class="td-amount">${formatBillingCurrency(record.amount)}</td>
                <td><span class="method-pill ${method.className}">${method.label}</span></td>
                <td><span class="status-pill ${status.className}">${status.label}</span></td>
                <td>${formatBillingDateTime(record.createdAt)}</td>
                <td>${record.paidAt ? formatBillingDateTime(record.paidAt) : "-"}</td>
                <td>
                    <div class="action-btns">
                        <button class="tbl-btn" type="button" onclick="openBillingDetail('${record.id}')">View</button>
                        ${record.paymongoCheckoutUrl ? `<a class="tbl-btn" href="${record.paymongoCheckoutUrl}" target="_blank" rel="noopener noreferrer">Checkout</a>` : ""}
                    </div>
                </td>
            </tr>
        `;
    }).join("");
}

function renderInvoiceTable() {
    const tbody = document.getElementById("invoiceTableBody");
    const caption = document.getElementById("invoiceTableCaption");

    if (!tbody || !caption) {
        return;
    }

    const accountGroups = buildInvoiceAccountGroups(invoiceFilteredRecords);
    const totalAccountGroups = buildInvoiceAccountGroups(invoiceRecords);

    caption.textContent = invoiceFilteredRecords.length === invoiceRecords.length
        ? `${totalAccountGroups.length} account${totalAccountGroups.length === 1 ? "" : "s"} loaded with ${invoiceRecords.length} invoice${invoiceRecords.length === 1 ? "" : "s"}`
        : `Showing ${accountGroups.length} account${accountGroups.length === 1 ? "" : "s"} with ${invoiceFilteredRecords.length} of ${invoiceRecords.length} invoices`;

    if (!invoiceFilteredRecords.length) {
        tbody.innerHTML = `
            <tr>
                <td colspan="9" class="billing-empty-cell">No tenant invoices matched the current filters.</td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = accountGroups.map((group) => {
        const isExpanded = expandedInvoiceAccountKeys.has(group.key);
        const status = getInvoiceAccountStatus(group.invoices);
        const bookingRefs = [...group.bookingRefs];
        const roomLabels = [...group.roomLabels].filter(Boolean);
        const bookingLabel = bookingRefs.length
            ? bookingRefs.slice(0, 2).join(", ") + (bookingRefs.length > 2 ? ` +${bookingRefs.length - 2}` : "")
            : "N/A";
        const roomLabel = roomLabels.length
            ? roomLabels.slice(0, 2).join(", ") + (roomLabels.length > 2 ? ` +${roomLabels.length - 2}` : "")
            : "No room";
        const detailRows = isExpanded ? `
            <tr class="invoice-account-details-row">
                <td colspan="9">
                    <div class="invoice-account-details">
                        <div class="invoice-account-details-title">Billing invoices for ${escapeBillingHtml(group.tenantName || "Tenant")}</div>
                        <div class="invoice-detail-table-wrap">
                            <table class="invoice-detail-table">
                                <thead>
                                    <tr>
                                        <th>Month</th>
                                        <th>Type</th>
                                        <th>Period</th>
                                        <th>Due Date</th>
                                        <th>Gross</th>
                                        <th>Deposit Credit</th>
                                        <th>Amount Due</th>
                                        <th>Status</th>
                                        <th>Action</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${group.invoices.map((invoice) => {
                                        const invoiceStatus = getBillingStatusConfig(invoice.status || "unpaid");
                                        const period = `${formatBillingDate(invoice.periodStart)} - ${formatBillingDate(invoice.periodEnd)}`;

                                        return `
                                            <tr>
                                                <td>${escapeBillingHtml(invoice.billingMonth || "N/A")}</td>
                                                <td><span class="invoice-type-pill">${escapeBillingHtml(formatInvoiceType(invoice.invoiceType))}</span></td>
                                                <td><span class="invoice-period">${escapeBillingHtml(period)}</span></td>
                                                <td>${escapeBillingHtml(formatBillingDate(invoice.dueDate))}</td>
                                                <td class="td-amount">${formatBillingCurrency(invoice.grossAmount)}</td>
                                                <td class="td-amount">${formatBillingCurrency(invoice.depositCredit)}</td>
                                                <td class="td-amount">${formatBillingCurrency(invoice.amount)}</td>
                                                <td><span class="status-pill ${invoiceStatus.className}">${escapeBillingHtml(invoiceStatus.label)}</span></td>
                                                <td><button class="tbl-btn" type="button" onclick="openInvoiceDetail('${escapeBillingHtml(invoice.id)}')">View</button></td>
                                            </tr>
                                        `;
                                    }).join("")}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </td>
            </tr>
        ` : "";

        return `
            <tr class="invoice-account-row ${isExpanded ? "expanded" : ""}" data-account-key="${escapeBillingHtml(group.key)}">
                <td>
                    <div class="td-tenant">
                        <div class="td-avatar green">${escapeBillingHtml(getBillingInitials(group.tenantName))}</div>
                        <div>
                            <div class="td-name">${escapeBillingHtml(group.tenantName || "Tenant")}</div>
                            <div class="td-email">${escapeBillingHtml(group.tenantEmail || group.userId || "No email recorded")}</div>
                        </div>
                    </div>
                </td>
                <td>${escapeBillingHtml(bookingLabel)}</td>
                <td>${escapeBillingHtml(roomLabel)}</td>
                <td>${group.invoices.length}</td>
                <td>${escapeBillingHtml(group.nextDueDate ? formatBillingDate(group.nextDueDate) : "No unpaid due")}</td>
                <td class="td-amount">${formatBillingCurrency(group.totalAmount)}</td>
                <td class="td-amount">${formatBillingCurrency(group.outstandingAmount)}</td>
                <td><span class="status-pill ${status.className}">${escapeBillingHtml(status.label)}</span></td>
                <td>
                    <div class="action-btns">
                        <button class="tbl-btn invoice-account-toggle" type="button" data-account-key="${escapeBillingHtml(group.key)}">${isExpanded ? "Hide Invoices" : "View Invoices"}</button>
                    </div>
                </td>
            </tr>
            ${detailRows}
        `;
    }).join("");
}

function renderBillingDetail(record) {
    const body = document.getElementById("billingDetailBody");
    if (!body) {
        return;
    }
    const title = document.getElementById("billingDetailTitle");
    if (title) {
        title.textContent = "Transaction Details";
    }

    const status = getBillingStatusConfig(record.status);
    const method = getBillingMethodConfig(record.method);
    const roomLabel = record.room ? `Room ${record.room}` : "No room assigned";
    const bedLabel = record.bed ? ` - Bed ${record.bed}` : "";
    const checkoutLink = record.paymongoCheckoutUrl
        ? `<a class="billing-detail-link" href="${record.paymongoCheckoutUrl}" target="_blank" rel="noopener noreferrer">Open PayMongo checkout page</a>`
        : `<span class="billing-detail-value muted">Checkout URL not available</span>`;

    body.innerHTML = `
        <div class="tenant-modal-hero">
            <div class="tm-avatar">${getBillingInitials(record.tenantName)}</div>
            <div>
                <div class="tm-name">${record.tenantName || "Tenant"}</div>
                <div class="td-email">${record.tenantEmail || "No email recorded"}</div>
            </div>
        </div>
        <div class="billing-modal-grid">
            <div class="billing-detail-card">
                <div class="billing-detail-label">Booking Reference</div>
                <div class="billing-detail-value">${record.bookingReferenceId || record.bookingRequestId || "N/A"}</div>
            </div>
            <div class="billing-detail-card">
                <div class="billing-detail-label">Transaction Status</div>
                <div class="billing-detail-value"><span class="status-pill ${status.className}">${status.label}</span></div>
            </div>
            <div class="billing-detail-card">
                <div class="billing-detail-label">Amount</div>
                <div class="billing-detail-value">${formatBillingCurrency(record.amount)}</div>
            </div>
            <div class="billing-detail-card">
                <div class="billing-detail-label">Payment Method</div>
                <div class="billing-detail-value"><span class="method-pill ${method.className}">${method.label}</span></div>
            </div>
            <div class="billing-detail-card">
                <div class="billing-detail-label">Room Assignment</div>
                <div class="billing-detail-value">${roomLabel}${bedLabel}</div>
            </div>
            <div class="billing-detail-card">
                <div class="billing-detail-label">Transaction Type</div>
                <div class="billing-detail-value">${record.type === "down_payment" ? "Down Payment" : (record.type || "Payment")}</div>
            </div>
            <div class="billing-detail-card">
                <div class="billing-detail-label">Created At</div>
                <div class="billing-detail-value">${formatBillingDateTime(record.createdAt)}</div>
            </div>
            <div class="billing-detail-card">
                <div class="billing-detail-label">Paid At</div>
                <div class="billing-detail-value">${record.paidAt ? formatBillingDateTime(record.paidAt) : "Not yet paid"}</div>
            </div>
            <div class="billing-detail-card">
                <div class="billing-detail-label">Gateway</div>
                <div class="billing-detail-value">${record.gateway || "PayMongo"}</div>
            </div>
            <div class="billing-detail-card">
                <div class="billing-detail-label">Checkout Session</div>
                <div class="billing-detail-value">${record.paymongoCheckoutId || "Unavailable"}</div>
            </div>
        </div>
        <div class="modal-section-label">Gateway Link</div>
        <div class="billing-detail-card">${checkoutLink}</div>
    `;
}

function renderInvoiceDetail(invoice) {
    const body = document.getElementById("billingDetailBody");
    if (!body) {
        return;
    }
    const title = document.getElementById("billingDetailTitle");
    if (title) {
        title.textContent = "Invoice Details";
    }

    const status = getBillingStatusConfig(invoice.status || "unpaid");
    const roomLabel = invoice.room ? `Room ${invoice.room}` : "No room assigned";
    const bedLabel = invoice.bed ? ` - Bed ${invoice.bed}` : "";

    body.innerHTML = `
        <div class="tenant-modal-hero">
            <div class="tm-avatar">${escapeBillingHtml(getBillingInitials(invoice.tenantName))}</div>
            <div>
                <div class="tm-name">${escapeBillingHtml(invoice.tenantName || "Tenant")}</div>
                <div class="td-email">${escapeBillingHtml(invoice.tenantEmail || "No email recorded")}</div>
            </div>
        </div>
        <div class="billing-modal-grid">
            <div class="billing-detail-card">
                <div class="billing-detail-label">Booking Reference</div>
                <div class="billing-detail-value">${escapeBillingHtml(invoice.bookingReferenceId || invoice.bookingRequestId || "N/A")}</div>
            </div>
            <div class="billing-detail-card">
                <div class="billing-detail-label">Invoice Month</div>
                <div class="billing-detail-value">${escapeBillingHtml(invoice.billingMonth || "N/A")}</div>
            </div>
            <div class="billing-detail-card">
                <div class="billing-detail-label">Invoice Type</div>
                <div class="billing-detail-value">${escapeBillingHtml(formatInvoiceType(invoice.invoiceType))}</div>
            </div>
            <div class="billing-detail-card">
                <div class="billing-detail-label">Invoice Status</div>
                <div class="billing-detail-value"><span class="status-pill ${status.className}">${escapeBillingHtml(status.label)}</span></div>
            </div>
            <div class="billing-detail-card">
                <div class="billing-detail-label">Room Assignment</div>
                <div class="billing-detail-value">${escapeBillingHtml(roomLabel + bedLabel)}</div>
            </div>
            <div class="billing-detail-card">
                <div class="billing-detail-label">Due Date</div>
                <div class="billing-detail-value">${escapeBillingHtml(formatBillingDate(invoice.dueDate))}</div>
            </div>
            <div class="billing-detail-card">
                <div class="billing-detail-label">Covered Period</div>
                <div class="billing-detail-value">${escapeBillingHtml(formatBillingDate(invoice.periodStart))} - ${escapeBillingHtml(formatBillingDate(invoice.periodEnd))}</div>
            </div>
            <div class="billing-detail-card">
                <div class="billing-detail-label">Monthly Rate</div>
                <div class="billing-detail-value">${formatBillingCurrency(invoice.monthlyRate)}</div>
            </div>
            <div class="billing-detail-card">
                <div class="billing-detail-label">Gross Amount</div>
                <div class="billing-detail-value">${formatBillingCurrency(invoice.grossAmount)}</div>
            </div>
            <div class="billing-detail-card">
                <div class="billing-detail-label">Deposit Credit</div>
                <div class="billing-detail-value">${formatBillingCurrency(invoice.depositCredit)}</div>
            </div>
            <div class="billing-detail-card">
                <div class="billing-detail-label">Amount Due</div>
                <div class="billing-detail-value">${formatBillingCurrency(invoice.amount)}</div>
            </div>
            <div class="billing-detail-card">
                <div class="billing-detail-label">Payment ID</div>
                <div class="billing-detail-value">${escapeBillingHtml(invoice.paymentId || invoice.downPaymentPaymentId || "Not paid yet")}</div>
            </div>
        </div>
    `;
}

function closeBillingDetailModal() {
    document.getElementById("billingDetailModal")?.style.setProperty("display", "none");
}

function openBillingDetailModal() {
    document.getElementById("billingDetailModal")?.style.setProperty("display", "flex");
}

function bindBillingModal() {
    document.getElementById("closeBillingDetailModal")?.addEventListener("click", closeBillingDetailModal);
    document.getElementById("dismissBillingDetailModal")?.addEventListener("click", closeBillingDetailModal);
    document.getElementById("billingDetailModal")?.addEventListener("click", (event) => {
        if (event.target.id === "billingDetailModal") {
            closeBillingDetailModal();
        }
    });
}

function bindBillingFilters() {
    document.getElementById("billingSearchInput")?.addEventListener("input", applyBillingFilters);
    document.getElementById("billingStatusFilter")?.addEventListener("change", applyBillingFilters);
    document.getElementById("billingMethodFilter")?.addEventListener("change", applyBillingFilters);
    document.getElementById("billingDateSort")?.addEventListener("change", applyBillingFilters);
    document.getElementById("invoiceSearchInput")?.addEventListener("input", applyInvoiceFilters);
    document.getElementById("invoiceStatusFilter")?.addEventListener("change", applyInvoiceFilters);
    document.getElementById("invoiceTypeFilter")?.addEventListener("change", applyInvoiceFilters);
    document.getElementById("downloadBillingPdfBtn")?.addEventListener("click", downloadBillingPdf);
    document.getElementById("downloadBillingCsvBtn")?.addEventListener("click", downloadBillingCsv);
    document.getElementById("refreshBillingBtn")?.addEventListener("click", async (event) => {
        await syncDelinquentAccounts(event.currentTarget, true);
    });
    document.getElementById("invoiceTableBody")?.addEventListener("click", (event) => {
        const detailButton = event.target.closest(".invoice-detail-table .tbl-btn");
        if (detailButton) {
            return;
        }

        const toggleTarget = event.target.closest(".invoice-account-toggle, .invoice-account-row");
        const accountKey = toggleTarget?.dataset?.accountKey;
        if (accountKey) {
            window.toggleInvoiceAccount(accountKey);
        }
    });
}

function bindBillingAvatarDropdown() {
    const avatarContainer = document.getElementById("avatarContainer");
    const adminAvatar = document.getElementById("adminAvatar");

    if (!avatarContainer || !adminAvatar) {
        return;
    }

    adminAvatar.addEventListener("click", (event) => {
        event.stopPropagation();
        avatarContainer.classList.toggle("open");
    });

    document.addEventListener("click", () => {
        avatarContainer.classList.remove("open");
    });
}

function startBillingListener() {
    if (billingUnsubscribe) {
        billingUnsubscribe();
    }

    billingUnsubscribe = db.collection("payments")
        .orderBy("createdAt", "desc")
        .onSnapshot((snapshot) => {
            renderBillingSnapshot(snapshot);
        }, async (error) => {
            console.error("Failed to load billing records:", error);
            try {
                const fallbackSnapshot = await db.collection("payments").get();
                renderBillingSnapshot(fallbackSnapshot);
                showFormalAlert("The billing page loaded payment transactions using fallback mode.");
            } catch (fallbackError) {
                console.error("Billing fallback query failed:", fallbackError);
                document.getElementById("billingTableBody").innerHTML = `
                    <tr>
                        <td colspan="9" class="billing-empty-cell">Unable to load tenant transactions right now. Please refresh the page and try again.</td>
                    </tr>
                `;
                showFormalAlert("The billing page could not load payment transactions at this time.");
            }
        });
}

function startInvoiceListener() {
    if (invoiceUnsubscribe) {
        invoiceUnsubscribe();
    }

    invoiceUnsubscribe = db.collection("billingInvoices")
        .orderBy("dueDate", "asc")
        .onSnapshot((snapshot) => {
            renderInvoiceSnapshot(snapshot);
        }, async (error) => {
            console.error("Failed to load billing invoices:", error);
            try {
                const fallbackSnapshot = await db.collection("billingInvoices").get();
                renderInvoiceSnapshot(fallbackSnapshot);
                showFormalAlert("The billing page loaded invoices using fallback mode.");
            } catch (fallbackError) {
                console.error("Billing invoice fallback query failed:", fallbackError);
                document.getElementById("invoiceTableBody").innerHTML = `
                    <tr>
                        <td colspan="9" class="billing-empty-cell">Unable to load tenant invoices right now. Please refresh the page and try again.</td>
                    </tr>
                `;
                showFormalAlert("The billing page could not load tenant invoice schedules at this time.");
            }
        });
}

async function syncDelinquentAccounts(button, showResult = false) {
    try {
        if (button && typeof setAdminButtonLoading === "function") {
            setAdminButtonLoading(button, "Checking...");
        }

        const result = await callAdminApi("/api/admin/billing/sync-delinquent", {});
        if (showResult) {
            showFormalAlert(
                `Delinquency sync complete. Marked ${result.markedUsers || 0} account(s), cleared ${result.clearedUsers || 0}, and checked invoices against the ${result.graceDays || 15}-day grace period.`
            );
        }
        return result;
    } catch (error) {
        console.error("Failed to sync delinquent accounts:", error);
        if (showResult) {
            showFormalAlert(error.message || "Unable to sync delinquent accounts right now.");
        }
        return null;
    } finally {
        if (button && typeof restoreAdminButton === "function") {
            restoreAdminButton(button);
        }
    }
}

window.openBillingDetail = function openBillingDetail(id) {
    const record = billingRecords.find((item) => item.id === id);
    if (!record) {
        showFormalAlert("The selected transaction could not be found.");
        return;
    }

    renderBillingDetail(record);
    openBillingDetailModal();
};

window.openInvoiceDetail = function openInvoiceDetail(id) {
    const invoice = invoiceRecords.find((item) => item.id === id);
    if (!invoice) {
        showFormalAlert("The selected invoice could not be found.");
        return;
    }

    renderInvoiceDetail(invoice);
    openBillingDetailModal();
};

window.toggleInvoiceAccount = function toggleInvoiceAccount(accountKey) {
    if (expandedInvoiceAccountKeys.has(accountKey)) {
        expandedInvoiceAccountKeys.delete(accountKey);
    } else {
        expandedInvoiceAccountKeys.add(accountKey);
    }

    renderInvoiceTable();
};

async function initBillingPage() {
    const adminUser = await requireAdminAccess();
    if (!adminUser) {
        return;
    }

    const adminName = adminUser.username || adminUser.fullName || "Admin";
    const adminRole = adminUser.role === "admin" ? "Super Admin" : (adminUser.role || "Administrator");

    document.querySelectorAll(".admin-welcome").forEach((node) => {
        node.textContent = `Welcome, ${adminName}`;
    });

    document.querySelectorAll(".admin-role").forEach((node) => {
        node.textContent = adminRole;
    });

    const avatar = document.getElementById("adminAvatar");
    if (avatar) {
        avatar.textContent = getBillingInitials(adminName);
    }

    document.querySelectorAll("#btnLogout, #topbarLogoutBtn").forEach((button) => {
        button.addEventListener("click", logoutAdmin);
    });

    bindBillingAvatarDropdown();
    bindBillingModal();
    bindBillingFilters();
    await syncDelinquentAccounts(null, false);
    startBillingListener();
    startInvoiceListener();
}

initBillingPage();

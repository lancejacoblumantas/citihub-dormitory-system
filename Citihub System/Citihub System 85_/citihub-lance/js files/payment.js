let paymentToastTimer = null;
let selectedPaymentMethod = "gcash";
let activeApprovedBooking = null;
let activeTransientBooking = null;
let activeDownPaymentRecord = null;
let activePaymentRecords = [];
let activeBillingInvoices = [];
let activeUserData = null;
let activeAddonState = {
    catalog: [],
    addOns: [],
    requestedAddons: [],
    nextAdjustableBillingMonth: ""
};
let paymentSubmitting = false;
let activePaymentMode = "";

const DOWN_PAYMENT_AMOUNT = 1000;
const PAYMENT_API_BASE_URL = window.CITIHUB_API_BASE_URL || "http://localhost:4000";
const BOOKING_STATUS_APPROVED_PENDING_DOWN_PAYMENT = "approved_pending_down_payment";

function normalizeBookingStatus(value) {
    return String(value || "").trim().toLowerCase();
}

function isPendingDownPaymentBooking(booking) {
    return normalizeBookingStatus(booking?.status) === BOOKING_STATUS_APPROVED_PENDING_DOWN_PAYMENT;
}

function getBillingRestrictionMessage(userData = activeUserData, booking = activeApprovedBooking) {
    if (userData?.manualBillingHold === true || booking?.manualBillingHold === true) {
        return "Your account is currently on billing hold. Add-on changes are disabled until CitiHub management removes the hold, but you can still settle your billing.";
    }

    if (
        userData?.delinquentAccount === true
        || booking?.delinquentAccount === true
        || String(userData?.billingStatus || "").toLowerCase() === "delinquent"
        || String(booking?.billingStatus || "").toLowerCase() === "delinquent"
    ) {
        return "Your account is now delinquent because of overdue billing. Add-on changes are disabled until your balance is settled, but payment is still allowed.";
    }

    return "";
}

function isBillingRestricted(userData = activeUserData, booking = activeApprovedBooking) {
    return Boolean(getBillingRestrictionMessage(userData, booking));
}

function getPaymentPageMode() {
    const params = new URLSearchParams(window.location.search);
    const queryMode = params.get("type");
    if (queryMode === "transient") {
        return "transient";
    }

    if (activePaymentMode) {
        return activePaymentMode;
    }

    return params.get("paymentId") && sessionStorage.getItem("activeTransientPaymentId")
        ? "transient"
        : "monthly";
}

function getTransientBookingIdFromState() {
    const params = new URLSearchParams(window.location.search);
    return params.get("transientBookingId") || sessionStorage.getItem("activeTransientPaymentId") || "";
}

function isTransientPaymentMode() {
    return getPaymentPageMode() === "transient";
}

function rememberButtonMarkup(button) {
    if (button && !button.dataset.originalHtml) {
        button.dataset.originalHtml = button.innerHTML;
    }
}

function setButtonLoading(button, loadingLabel) {
    if (!button) {
        return;
    }

    rememberButtonMarkup(button);
    button.disabled = true;
    button.classList.add("btn-loading");
    button.innerHTML = `<span class="btn-loading-spinner" aria-hidden="true"></span><span>${loadingLabel}</span>`;
}

function restoreButton(button) {
    if (!button) {
        return;
    }

    button.disabled = false;
    button.classList.remove("btn-loading");
    if (button.dataset.originalHtml) {
        button.innerHTML = button.dataset.originalHtml;
    }
}

function showPaymentToast(message) {
    const toast = document.getElementById("toast");
    if (!toast) {
        return;
    }

    toast.textContent = message;
    toast.classList.add("show");

    if (paymentToastTimer) {
        clearTimeout(paymentToastTimer);
    }

    paymentToastTimer = setTimeout(() => {
        toast.classList.remove("show");
        paymentToastTimer = null;
    }, 3200);
}

function getFriendlyPaymentApiError(error, fallbackMessage) {
    if (error?.message === "Failed to fetch") {
        return "Cannot connect to the payment server. Please make sure the backend is running, then try again.";
    }

    return error?.message || fallbackMessage;
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

function formatCurrency(amount) {
    return new Intl.NumberFormat("en-PH", {
        style: "currency",
        currency: "PHP",
        minimumFractionDigits: 2
    }).format(Number(amount || 0));
}

function formatDate(date) {
    const parsed = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(parsed.getTime())) {
        return "Unavailable";
    }

    return new Intl.DateTimeFormat("en-PH", {
        month: "long",
        day: "numeric",
        year: "numeric"
    }).format(parsed);
}

function formatTimestamp(timestamp) {
    if (!timestamp) {
        return "Unavailable";
    }

    if (typeof timestamp.toDate === "function") {
        return formatDate(timestamp.toDate());
    }

    return formatDate(timestamp);
}

function addDays(date, days) {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
}

function parseLeaseAmount(value) {
    const digits = String(value || "").replace(/[^\d.]/g, "");
    const parsed = Number(digits);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 3500;
}

function getApprovedMonthlyRate(approvedBooking) {
    const monthlyRate = Number(approvedBooking?.monthlyRate || 0);
    return Number.isFinite(monthlyRate) && monthlyRate > 0
        ? monthlyRate
        : parseLeaseAmount(approvedBooking?.leasePrice);
}

function getApprovedContractMonths(approvedBooking) {
    const months = Number(approvedBooking?.contractMonths || 0);
    return Number.isFinite(months) && months > 0 ? months : 12;
}

function formatPaymentMethodLabel(method) {
    if (method === "gcash") return "GCash";
    if (method === "maya") return "Maya";
    if (method === "card") return "Card";
    if (method === "grab_pay") return "GrabPay";
    if (method === "shopeepay" || method === "shopee_pay") return "ShopeePay";
    if (method === "qrph") return "QR Ph";
    if (method === "online_banking") return "Online Banking";
    if (method === "billease") return "BillEase";
    return "Payment";
}

function getPaymentMethodIcon(method) {
    if (method === "maya") return "&#128181;";
    if (method === "grab_pay") return "&#128241;";
    if (method === "shopeepay" || method === "shopee_pay") return "&#128717;";
    if (method === "qrph") return "&#9638;";
    if (method === "online_banking") return "&#127974;";
    if (method === "billease") return "&#128176;";
    return "&#128179;";
}

function formatPaymentStatus(status) {
    if (status === "paid") return "Paid";
    if (status === "pending_gateway") return "Pending Gateway";
    if (status === "pending") return "Pending";
    if (status === "failed") return "Failed";
    if (status === "cancelled") return "Cancelled";
    return "Unpaid";
}

function formatBillingMonthLabel(billingMonth) {
    if (!billingMonth || !/^\d{4}-\d{2}$/.test(String(billingMonth))) {
        return "Monthly Rent";
    }

    const [year, month] = String(billingMonth).split("-").map(Number);
    const date = new Date(year, month - 1, 1);
    return new Intl.DateTimeFormat("en-PH", {
        month: "long",
        year: "numeric"
    }).format(date);
}

function getInvoiceAddonSummary(invoice) {
    const addons = Array.isArray(invoice?.addons) ? invoice.addons : [];
    const addonsAmount = Number(invoice?.addonsAmount || 0);
    return {
        addons,
        addonsAmount,
        labels: addons.map((addon) => addon.addonName || addon.name).filter(Boolean)
    };
}

function getVisibleMonthlyAddons() {
    const activeAddons = Array.isArray(activeAddonState.addOns) ? activeAddonState.addOns : [];
    const requestedAddons = Array.isArray(activeAddonState.requestedAddons) ? activeAddonState.requestedAddons : [];
    const source = activeAddons.length ? activeAddons : requestedAddons;

    return source
        .filter((addon) => !["cancelled"].includes(String(addon.status || "").toLowerCase()))
        .map((addon) => ({
            addonName: addon.addonName || addon.name || "Add-on",
            price: Number(addon.price || 0)
        }))
        .filter((addon) => addon.price > 0);
}

function getRequestedDownPaymentAddons() {
    const requestedAddons = Array.isArray(activeAddonState.requestedAddons) ? activeAddonState.requestedAddons : [];
    return requestedAddons
        .map((addon) => ({
            addonName: addon.addonName || addon.name || "Add-on",
            price: Number(addon.price || 0)
        }))
        .filter((addon) => addon.price > 0);
}

function buildBillingCalculation(baseAmount, addons = [], totalAmount = null, depositCredit = 0) {
    const cleanBase = Number(baseAmount || 0);
    const cleanAddons = Array.isArray(addons) ? addons.filter((addon) => Number(addon.price || 0) > 0) : [];
    const addonsTotal = cleanAddons.reduce((sum, addon) => sum + Number(addon.price || 0), 0);
    const grossTotal = totalAmount == null
        ? cleanBase + addonsTotal
        : Number(totalAmount || 0) + Number(depositCredit || 0);
    const parts = [formatCurrency(cleanBase)];

    cleanAddons.forEach((addon) => {
        parts.push(`${formatCurrency(addon.price)} ${addon.addonName || addon.name || "add-on"}`);
    });

    const equation = `${parts.join(" + ")} = ${formatCurrency(grossTotal)}`;
    return depositCredit
        ? `${equation}; less ${formatCurrency(depositCredit)} deposit credit = ${formatCurrency(totalAmount)}`
        : equation;
}

function getDaysInDateMonth(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
        return 0;
    }

    return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

function getCoveredDays(startDate, endDate) {
    if (!(startDate instanceof Date) || Number.isNaN(startDate.getTime()) || !(endDate instanceof Date) || Number.isNaN(endDate.getTime())) {
        return 0;
    }

    const startCopy = new Date(startDate);
    const endCopy = new Date(endDate);
    startCopy.setHours(0, 0, 0, 0);
    endCopy.setHours(0, 0, 0, 0);
    return Math.floor((endCopy - startCopy) / (1000 * 60 * 60 * 24)) + 1;
}

function getInvoiceCalculationBase(invoice, fallbackAmount = 0) {
    const proratedRent = Number(invoice?.rentAmount || 0);
    if (proratedRent > 0) {
        return proratedRent;
    }

    const monthlyRate = Number(invoice?.monthlyRate || 0);
    if (monthlyRate > 0) {
        return monthlyRate;
    }

    const fallback = Number(fallbackAmount || 0);
    return fallback > 0 ? fallback : 0;
}

function buildProrationExplanation(invoice, fallbackMonthlyRate = 0) {
    if (!invoice) {
        return "";
    }

    const invoiceType = String(invoice.invoiceType || "").toLowerCase();
    if (!["first_prorated_rent", "final_rent"].includes(invoiceType)) {
        return "";
    }

    const periodStart = parseInvoiceDate(invoice.periodStart);
    const periodEnd = parseInvoiceDate(invoice.periodEnd);
    const coveredDays = getCoveredDays(periodStart, periodEnd);
    const monthDays = getDaysInDateMonth(periodStart || periodEnd);
    const monthlyRate = Number(invoice.monthlyRate || fallbackMonthlyRate || 0);
    const rentAmount = Number(invoice.rentAmount || 0);

    if (!coveredDays || !monthDays || !monthlyRate || !rentAmount || coveredDays >= monthDays) {
        return "";
    }

    const dailyRate = monthlyRate / monthDays;
    return `Prorated rent: (${formatCurrency(monthlyRate)} / ${monthDays} days = ${formatCurrency(dailyRate)}/day) x ${coveredDays} days = ${formatCurrency(rentAmount)}`;
}

function buildInvoiceBillingCalculation(invoice, fallbackMonthlyRate, addons = [], totalAmount = null, depositCredit = 0) {
    const baseAmount = getInvoiceCalculationBase(invoice, fallbackMonthlyRate);
    const prorateExplanation = buildProrationExplanation(invoice, fallbackMonthlyRate);
    const billingCalculation = buildBillingCalculation(baseAmount, addons, totalAmount, depositCredit);
    return prorateExplanation ? `${prorateExplanation}; ${billingCalculation}` : billingCalculation;
}

function describeAddonActivationMonth(billingMonth) {
    return billingMonth ? formatBillingMonthLabel(billingMonth) : "the next unpaid billing cycle";
}

function getPdfConstructor() {
    return window.jspdf?.jsPDF || null;
}

function createBillingStatementPdf(Pdf, password) {
    const safePassword = String(password || "");
    const options = { orientation: "portrait" };
    if (safePassword) {
        options.encryption = {
            userPassword: safePassword,
            ownerPassword: `${safePassword}-citihub-owner`,
            userPermissions: ["print"]
        };
    }

    return new Pdf(options);
}

function sanitizePdfFileName(value) {
    return String(value || "citihub-file")
        .trim()
        .replace(/[^\w.-]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .toLowerCase() || "citihub-file";
}

function addPdfHeader(pdf, subtitle) {
    const pageWidth = pdf.internal.pageSize.getWidth();
    pdf.setFillColor(26, 122, 74);
    pdf.rect(0, 0, pageWidth, 28, "F");
    pdf.setTextColor(255, 255, 255);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(16);
    pdf.text("CITIHUB DORMITORY", 14, 13);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(10);
    pdf.text(subtitle, 14, 21);
    pdf.setTextColor(26, 26, 46);
}

function ensurePdfSpace(pdf, y, needed = 12) {
    const pageHeight = pdf.internal.pageSize.getHeight();
    if (y + needed <= pageHeight - 16) {
        return y;
    }

    pdf.addPage();
    return 18;
}

function addPdfSectionTitle(pdf, title, y) {
    y = ensurePdfSpace(pdf, y, 12);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(11);
    pdf.setTextColor(26, 122, 74);
    pdf.text(title, 14, y);
    pdf.setDrawColor(229, 231, 235);
    pdf.line(14, y + 2, pdf.internal.pageSize.getWidth() - 14, y + 2);
    pdf.setTextColor(26, 26, 46);
    return y + 9;
}

function addPdfKeyValue(pdf, label, value, y) {
    y = ensurePdfSpace(pdf, y, 7);
    pdf.setFontSize(9);
    pdf.setFont("helvetica", "bold");
    pdf.text(String(label), 14, y);
    pdf.setFont("helvetica", "normal");
    const lines = pdf.splitTextToSize(String(value || "N/A"), 120);
    pdf.text(lines, 62, y);
    return y + Math.max(6, lines.length * 5);
}

function addPdfTableRow(pdf, columns, y, widths = [45, 40, 40, 34, 28]) {
    y = ensurePdfSpace(pdf, y, 10);
    let x = 14;
    pdf.setFontSize(8);
    columns.forEach((column, index) => {
        const width = widths[index] || 30;
        const lines = pdf.splitTextToSize(String(column || ""), width - 2);
        pdf.text(lines.slice(0, 2), x, y);
        x += width;
    });
    return y + 8;
}

function getTenantBillingName() {
    return activeUserData?.fullName || activeUserData?.username || activeApprovedBooking?.tenantName || activeApprovedBooking?.email || "Tenant";
}

function getTenantRoomLabel() {
    const room = activeApprovedBooking?.room ? `Room ${activeApprovedBooking.room}` : activeUserData?.room || "No room";
    const bed = activeApprovedBooking?.bed ? ` - Bed ${activeApprovedBooking.bed}` : "";
    return `${room}${bed}`;
}

function getPrintablePayments() {
    return sortPaymentRecords(activePaymentRecords || []);
}

function downloadBillingStatementPdf(password = "") {
    const Pdf = getPdfConstructor();
    if (!Pdf) {
        showPaymentToast("PDF library is still loading. Please try again in a moment.");
        return;
    }

    if (!activeApprovedBooking && !activeTransientBooking) {
        showPaymentToast("No approved billing record is available for download yet.");
        return;
    }

    const pdf = createBillingStatementPdf(Pdf, password);
    const generatedAt = new Date().toLocaleString("en-PH");
    const target = isTransientPaymentMode() ? activeTransientBooking : activeApprovedBooking;
    addPdfHeader(pdf, "Tenant Billing Statement");

    let y = 40;
    y = addPdfSectionTitle(pdf, "Tenant Details", y);
    y = addPdfKeyValue(pdf, "Tenant", getTenantBillingName(), y);
    y = addPdfKeyValue(pdf, "Email", activeUserData?.email || target?.tenantEmail || target?.email || auth.currentUser?.email || "N/A", y);
    y = addPdfKeyValue(pdf, "Room", isTransientPaymentMode() ? `${target?.room || "Room"}${target?.bed ? ` - Bed ${target.bed}` : ""}` : getTenantRoomLabel(), y);
    y = addPdfKeyValue(pdf, "Reference", target?.referenceId || target?.bookingReferenceId || target?.id || "N/A", y);
    y = addPdfKeyValue(pdf, "Generated", generatedAt, y);

    if (!isTransientPaymentMode()) {
        const schedule = getMonthlyBillingSchedule(activeApprovedBooking, activeDownPaymentRecord, activePaymentRecords);
        y += 3;
        y = addPdfSectionTitle(pdf, "Billing Schedule", y);
        if (schedule?.entries?.length) {
            pdf.setFont("helvetica", "bold");
            y = addPdfTableRow(pdf, ["Month", "Period", "Due Date", "Amount", "Status"], y);
            pdf.setFont("helvetica", "normal");
            schedule.entries.forEach((entry) => {
                const period = entry.invoice
                    ? `${formatDate(entry.periodStart || entry.invoice.periodStart)} - ${formatDate(entry.periodEnd || entry.invoice.periodEnd)}`
                    : "Monthly rent";
                y = addPdfTableRow(pdf, [
                    formatBillingMonthLabel(entry.billingMonth),
                    period,
                    formatDate(entry.dueDate),
                    formatCurrency(entry.amount),
                    entry.status?.label || "Unpaid"
                ], y);
            });
        } else {
            y = addPdfKeyValue(pdf, "Schedule", "Monthly billing will appear after the down payment is confirmed.", y);
        }
    }

    y += 3;
    y = addPdfSectionTitle(pdf, "Payment Activity", y);
    const payments = getPrintablePayments();
    if (payments.length) {
        pdf.setFont("helvetica", "bold");
        y = addPdfTableRow(pdf, ["Type", "Method", "Amount", "Status", "Date"], y);
        pdf.setFont("helvetica", "normal");
        payments.forEach((record) => {
            y = addPdfTableRow(pdf, [
                record.type === "monthly_rent" ? `${formatBillingMonthLabel(record.billingMonth)} Rent` : record.type === "transient_bed" ? "Transient Bed" : "Down Payment",
                formatPaymentMethodLabel(record.method),
                formatCurrency(record.amount || DOWN_PAYMENT_AMOUNT),
                formatPaymentStatus(record.status),
                formatTimestamp(record.paidAt || record.createdAt)
            ], y);
        });
    } else {
        y = addPdfKeyValue(pdf, "Activity", "No payment requests have been created yet.", y);
    }

    pdf.setFontSize(8);
    pdf.setTextColor(107, 114, 128);
    pdf.text("Generated from CitiHub tenant billing page.", 14, pdf.internal.pageSize.getHeight() - 8);
    pdf.save(`${sanitizePdfFileName(`billing_statement_${target?.referenceId || target?.id || "tenant"}`)}.pdf`);
}

function downloadPaymentReceiptPdf(paymentId) {
    const Pdf = getPdfConstructor();
    if (!Pdf) {
        showPaymentToast("PDF library is still loading. Please try again in a moment.");
        return;
    }

    const record = activePaymentRecords.find((payment) => payment.id === paymentId);
    if (!record) {
        showPaymentToast("This payment record is no longer available.");
        return;
    }

    if (record.status !== "paid") {
        showPaymentToast("A receipt can only be downloaded after the payment is marked as paid.");
        return;
    }

    const pdf = new Pdf({ orientation: "portrait" });
    addPdfHeader(pdf, "Official Payment Receipt");
    let y = 40;
    y = addPdfSectionTitle(pdf, "Receipt Details", y);
    y = addPdfKeyValue(pdf, "Receipt ID", record.id, y);
    y = addPdfKeyValue(pdf, "Tenant", record.tenantName || getTenantBillingName(), y);
    y = addPdfKeyValue(pdf, "Email", record.tenantEmail || auth.currentUser?.email || "N/A", y);
    y = addPdfKeyValue(pdf, "Booking Ref", record.bookingReferenceId || record.bookingRequestId || activeApprovedBooking?.referenceId || "N/A", y);
    y = addPdfKeyValue(pdf, "Payment Type", record.type === "monthly_rent" ? `${formatBillingMonthLabel(record.billingMonth)} Rent` : record.type === "transient_bed" ? "Transient Bed Payment" : "Down Payment", y);
    y = addPdfKeyValue(pdf, "Payment Method", formatPaymentMethodLabel(record.method), y);
    y = addPdfKeyValue(pdf, "Amount Paid", formatCurrency(record.amount || DOWN_PAYMENT_AMOUNT), y);
    y = addPdfKeyValue(pdf, "Paid At", formatTimestamp(record.paidAt || record.updatedAt || record.createdAt), y);
    y = addPdfKeyValue(pdf, "Gateway", record.gateway || "PayMongo", y);
    y = addPdfKeyValue(pdf, "Checkout ID", record.paymongoCheckoutId || "N/A", y);

    pdf.setFontSize(8);
    pdf.setTextColor(107, 114, 128);
    pdf.text("This receipt confirms a payment recorded in the CitiHub billing system.", 14, pdf.internal.pageSize.getHeight() - 8);
    pdf.save(`${sanitizePdfFileName(`payment_receipt_${record.id}`)}.pdf`);
}

function createBillingDueDate(year, monthIndex, dayOfMonth) {
    const lastDay = new Date(year, monthIndex + 1, 0).getDate();
    const safeDay = Math.min(dayOfMonth, lastDay);
    const dueDate = new Date(year, monthIndex, safeDay);
    dueDate.setHours(0, 0, 0, 0);
    return dueDate;
}

function parseMoveInDateValue(value) {
    if (!value) {
        return null;
    }

    const parsed = new Date(`${value}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) {
        return null;
    }

    parsed.setHours(0, 0, 0, 0);
    return parsed;
}

function parseInvoiceDate(value) {
    if (!value) return null;
    if (typeof value.toDate === "function") {
        const date = value.toDate();
        date.setHours(0, 0, 0, 0);
        return date;
    }

    const parsed = new Date(`${String(value).slice(0, 10)}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return null;
    parsed.setHours(0, 0, 0, 0);
    return parsed;
}

function getDueStatus(dueDate, today = new Date()) {
    const dueCopy = new Date(dueDate);
    dueCopy.setHours(0, 0, 0, 0);

    const todayCopy = new Date(today);
    todayCopy.setHours(0, 0, 0, 0);

    const diffInDays = Math.ceil((dueCopy - todayCopy) / (1000 * 60 * 60 * 24));

    if (diffInDays < 0) {
        return { key: "overdue", label: "Overdue" };
    }

    if (diffInDays <= 7) {
        return { key: "upcoming", label: "Due Soon" };
    }

    return { key: "pending", label: "Upcoming" };
}

function isRenewalBilling(approvedBooking) {
    return Boolean(approvedBooking?.isRenewal || approvedBooking?.requestType === "renewal");
}

function getMonthlyBillingSchedule(approvedBooking, downPaymentRecord, paymentRecords = []) {
    const canUseRenewalInvoices = isRenewalBilling(approvedBooking) && activeBillingInvoices.length > 0;
    if (!approvedBooking || (downPaymentRecord?.status !== "paid" && !canUseRenewalInvoices)) {
        return null;
    }

    if (activeBillingInvoices.length) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const entries = activeBillingInvoices.map((invoice) => {
            const paymentRecord = paymentRecords.find((record) =>
                record.type === "monthly_rent" && record.billingMonth === invoice.billingMonth
            ) || null;
            const dueDate = parseInvoiceDate(invoice.dueDate);

            let status = dueDate ? getDueStatus(dueDate, today) : { key: "pending", label: "Upcoming" };
            if (invoice.status === "deducted_by_deposit") {
                status = { key: "paid", label: "Deposit Applied" };
            }
            if (paymentRecord?.status === "paid" || invoice.status === "paid") {
                status = { key: "paid", label: "Paid" };
            } else if (paymentRecord?.status === "pending_gateway") {
                status = { key: "gateway", label: "Pending Gateway" };
            }

            return {
                dueDate,
                amount: Number(invoice.amount || 0),
                grossAmount: Number(invoice.grossAmount || invoice.amount || 0),
                depositCredit: Number(invoice.depositCredit || 0),
                periodStart: parseInvoiceDate(invoice.periodStart),
                periodEnd: parseInvoiceDate(invoice.periodEnd),
                status,
                billingMonth: invoice.billingMonth,
                invoiceType: invoice.invoiceType || "monthly_rent",
                paymentRecord,
                invoice
            };
        });
        const nextDue = entries.find((entry) => entry.status.key !== "paid") || entries[entries.length - 1];

        return {
            moveInDate: parseInvoiceDate(activeBillingInvoices[0]?.periodStart),
            monthlyAmount: getApprovedMonthlyRate(approvedBooking),
            contractMonths: entries.length,
            anchorDay: 1,
            firstDueDate: entries[0]?.dueDate || null,
            nextDue,
            entries,
            source: "billingInvoices"
        };
    }

    const moveInDate = parseMoveInDateValue(approvedBooking.moveInDate);
    if (!moveInDate) {
        return { missingMoveInDate: true };
    }

    const monthlyAmount = getApprovedMonthlyRate(approvedBooking);
    const contractMonths = getApprovedContractMonths(approvedBooking);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const anchorDay = moveInDate.getDate();
    const firstDueDate = createBillingDueDate(moveInDate.getFullYear(), moveInDate.getMonth() + 1, anchorDay);

    const entries = [];

    for (let index = 0; index < contractMonths; index += 1) {
        const dueDate = createBillingDueDate(firstDueDate.getFullYear(), firstDueDate.getMonth() + index, anchorDay);
        const billingMonth = `${dueDate.getFullYear()}-${String(dueDate.getMonth() + 1).padStart(2, "0")}`;
        const paymentRecord = paymentRecords.find((record) =>
            record.type === "monthly_rent" && record.billingMonth === billingMonth
        ) || null;

        let status = getDueStatus(dueDate, today);
        if (paymentRecord?.status === "paid") {
            status = { key: "paid", label: "Paid" };
        } else if (paymentRecord?.status === "pending_gateway") {
            status = { key: "gateway", label: "Pending Gateway" };
        }

        entries.push({
            dueDate,
            amount: monthlyAmount,
            status,
            billingMonth,
            paymentRecord
        });
    }

    const nextDue = entries.find((entry) => entry.status.key !== "paid") || entries[entries.length - 1];

    return {
        moveInDate,
        monthlyAmount,
        contractMonths,
        anchorDay,
        firstDueDate,
        nextDue,
        entries
    };
}

function getPrimaryPaymentAction(approvedBooking, downPaymentRecord, paymentRecords) {
    if (isTransientPaymentMode()) {
        if (!activeTransientBooking || activeTransientBooking.paymentStatus === "paid") {
            return { kind: "none" };
        }

        return { kind: "transient_bed", booking: activeTransientBooking };
    }

    if (!approvedBooking) {
        return { kind: "none" };
    }

    const canUseRenewalInvoices = isRenewalBilling(approvedBooking) && activeBillingInvoices.length > 0;
    if ((!downPaymentRecord || downPaymentRecord.status !== "paid") && !canUseRenewalInvoices) {
        return {
            kind: "down_payment",
            record: downPaymentRecord || null
        };
    }

    const schedule = getMonthlyBillingSchedule(approvedBooking, downPaymentRecord, paymentRecords);
    if (!schedule || schedule.missingMoveInDate) {
        return { kind: "none" };
    }

    const actionableEntry = schedule.entries.find((entry) => entry.status.key !== "paid");
    if (!actionableEntry) {
        return { kind: "none" };
    }

    return {
        kind: "monthly_rent",
        schedule,
        entry: actionableEntry,
        record: actionableEntry.paymentRecord || null
    };
}

async function callPaymentApi(path, payload) {
    const user = firebase.auth().currentUser;
    if (!user) {
        throw new Error("You must be signed in to continue.");
    }

    const token = await user.getIdToken();
    const response = await fetch(`${PAYMENT_API_BASE_URL}${path}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify(payload || {})
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(result.error || "The payment service request failed.");
        error.status = response.status;
        error.code = result.code || "";
        throw error;
    }

    return result;
}

function getTenantSessionId() {
    let sessionId = localStorage.getItem("citihub_tenant_session_id");
    if (!sessionId) {
        const randomPart = crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`;
        sessionId = `sess_${String(randomPart).replace(/[^a-zA-Z0-9_-]/g, "")}`;
        localStorage.setItem("citihub_tenant_session_id", sessionId);
    }

    return sessionId;
}

async function touchTenantSession() {
    if (sessionStorage.getItem("citihub_tenant_session_recorded") === "true") {
        return true;
    }

    try {
        await callPaymentApi("/api/sessions/touch", {
            sessionId: getTenantSessionId(),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || ""
        });
        sessionStorage.setItem("citihub_tenant_session_recorded", "true");
        return true;
    } catch (error) {
        if (error?.code === "session-revoked" || error?.message?.toLowerCase().includes("session was signed out")) {
            await firebase.auth().signOut();
            sessionStorage.clear();
            window.location.href = "intro.html";
            return false;
        }

        console.warn("Unable to update payment session activity:", error);
        return true;
    }
}

async function verifyPendingGatewayPayments(paymentRecords = []) {
    const pendingRecords = paymentRecords.filter((record) =>
        record?.id
        && record.status === "pending_gateway"
        && record.paymongoCheckoutId
        && ["down_payment", "monthly_rent", "transient_bed"].includes(record.type)
    );

    if (!pendingRecords.length) {
        return false;
    }

    const verificationResults = await Promise.all(
        pendingRecords.map(async (record) => {
            try {
                const result = await callPaymentApi("/api/payments/verify", { paymentId: record.id });
                return result.status === "paid";
            } catch (error) {
                console.warn("Unable to auto-verify pending payment:", record.id, error);
                return false;
            }
        })
    );

    return verificationResults.some(Boolean);
}

async function ensurePaidDownPaymentInvoices(downPaymentRecord) {
    if (
        !downPaymentRecord?.id
        || downPaymentRecord.status !== "paid"
        || downPaymentRecord.type !== "down_payment"
    ) {
        return false;
    }

    try {
        await callPaymentApi("/api/payments/verify", { paymentId: downPaymentRecord.id });
        return true;
    } catch (error) {
        console.warn("Unable to ensure billing invoices for paid down payment:", downPaymentRecord.id, error);
        return false;
    }
}

function getCheckoutBaseUrl() {
    return window.location.origin + window.location.pathname;
}

async function logoutTenant() {
    try {
        await firebase.auth().signOut();
        sessionStorage.clear();
        localStorage.clear();
        window.location.href = "intro.html";
    } catch (error) {
        console.error("Logout failed:", error);
        showPaymentToast("Unable to log out right now. Please try again.");
    }
}

function bindAvatarDropdown() {
    const avatarContainer = document.getElementById("avatarContainer");
    const avatarBtn = document.getElementById("avatarBtn");
    if (!avatarContainer || !avatarBtn) {
        return;
    }

    avatarBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        avatarContainer.classList.toggle("open");
    });

    document.addEventListener("click", () => {
        avatarContainer.classList.remove("open");
    });

    avatarContainer.querySelectorAll(".dropdown-item").forEach((item) => {
        item.addEventListener("click", async (event) => {
            event.preventDefault();
            const action = item.dataset.action;

            if (action === "logout") {
                await logoutTenant();
            } else if (action === "dashboard") {
                window.location.href = "main.html";
            } else if (action === "settings") {
                window.location.href = "settings.html";
            } else if (action === "profile") {
                window.location.href = "userprofile.html";
            } else if (action === "payment") {
                window.location.href = "payment.html";
            }

            avatarContainer.classList.remove("open");
        });
    });
}

function bindPaymentMethodSelection() {
    const methodCards = document.querySelectorAll(".method-card[data-method]");

    methodCards.forEach((card) => {
        card.addEventListener("click", () => {
            selectedPaymentMethod = card.dataset.method || "gcash";

            methodCards.forEach((item) => {
                const isActive = item === card;
                item.classList.toggle("active", isActive);
                const tag = item.querySelector(".method-tag");
                if (tag) {
                    tag.textContent = isActive ? "Selected" : "Select";
                }
            });

            updateSelectedMethodDisplay();
            updatePaymentButton(activeApprovedBooking, activeDownPaymentRecord, activePaymentRecords);
            closePaymentMethodModal();
        });
    });
}

function resetBillingPasswordForm() {
    const form = document.getElementById("billingPasswordForm");
    const note = document.getElementById("billingPasswordNote");
    if (form) {
        form.reset();
    }
    if (note) {
        note.textContent = "Use at least 4 characters. Keep this password safe because CitiHub cannot recover it from the PDF.";
        note.classList.remove("error");
    }
}

function openBillingPasswordModal() {
    if (!activeApprovedBooking && !activeTransientBooking) {
        showPaymentToast("No approved billing record is available for download yet.");
        return;
    }

    const modal = document.getElementById("billingPasswordModal");
    if (!modal) return;
    resetBillingPasswordForm();
    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    setTimeout(() => document.getElementById("billingPdfPassword")?.focus(), 0);
}

function closeBillingPasswordModal() {
    const modal = document.getElementById("billingPasswordModal");
    if (!modal) return;
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    resetBillingPasswordForm();
}

function showBillingPasswordError(message) {
    const note = document.getElementById("billingPasswordNote");
    if (!note) {
        showPaymentToast(message);
        return;
    }

    note.textContent = message;
    note.classList.add("error");
}

function handleBillingPasswordSubmit(event) {
    event.preventDefault();
    const passwordInput = document.getElementById("billingPdfPassword");
    const confirmInput = document.getElementById("billingPdfPasswordConfirm");
    const password = String(passwordInput?.value || "");
    const confirmation = String(confirmInput?.value || "");

    if (password.length < 4) {
        showBillingPasswordError("Enter a password with at least 4 characters.");
        passwordInput?.focus();
        return;
    }

    if (password !== confirmation) {
        showBillingPasswordError("The password confirmation does not match.");
        confirmInput?.focus();
        return;
    }

    try {
        downloadBillingStatementPdf(password);
        closeBillingPasswordModal();
        showPaymentToast("Password-protected billing summary downloaded.");
    } catch (error) {
        console.error("Failed to create password-protected billing summary:", error);
        showBillingPasswordError("Unable to create the protected PDF. Please try again.");
    }
}

function bindPaymentActions() {
    document.getElementById("payCurrentBtn")?.addEventListener("click", startActualDownPaymentFlow);

    document.getElementById("downloadStatementBtn")?.addEventListener("click", openBillingPasswordModal);

    document.getElementById("askAdminBtn")?.addEventListener("click", () => {
        window.location.href = "main.html";
    });

    document.getElementById("changeMethodBtn")?.addEventListener("click", openPaymentMethodModal);
    document.getElementById("methodModalClose")?.addEventListener("click", closePaymentMethodModal);
    document.getElementById("methodModal")?.addEventListener("click", (event) => {
        if (event.target === event.currentTarget) {
            closePaymentMethodModal();
        }
    });

    document.getElementById("billingPasswordForm")?.addEventListener("submit", handleBillingPasswordSubmit);
    document.getElementById("billingPasswordModalClose")?.addEventListener("click", closeBillingPasswordModal);
    document.getElementById("billingPasswordCancel")?.addEventListener("click", closeBillingPasswordModal);
    document.getElementById("billingPasswordModal")?.addEventListener("click", (event) => {
        if (event.target === event.currentTarget) {
            closeBillingPasswordModal();
        }
    });
}

function updateSelectedMethodDisplay() {
    const selectedMethodNote = document.getElementById("selectedMethodNote");
    const currentMethodName = document.getElementById("currentMethodName");
    const currentMethodIcon = document.getElementById("currentMethodIcon");
    const label = formatPaymentMethodLabel(selectedPaymentMethod);

    if (selectedMethodNote) {
        selectedMethodNote.textContent = `Selected method: ${label}`;
    }
    if (currentMethodName) {
        currentMethodName.textContent = label;
    }
    if (currentMethodIcon) {
        currentMethodIcon.innerHTML = getPaymentMethodIcon(selectedPaymentMethod);
    }
}

function openPaymentMethodModal() {
    const modal = document.getElementById("methodModal");
    if (!modal) return;
    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
}

function closePaymentMethodModal() {
    const modal = document.getElementById("methodModal");
    if (!modal) return;
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
}

async function loadLatestApprovedBooking(userId) {
    const snapshot = await db.collection("bookingRequest")
        .where("userId", "==", userId)
        .get();

    const docs = snapshot.docs.filter((doc) =>
        ["approved", BOOKING_STATUS_APPROVED_PENDING_DOWN_PAYMENT].includes(normalizeBookingStatus(doc.data()?.status))
    );

    if (!docs.length) {
        return null;
    }

    docs.sort((left, right) => {
        const leftDate = left.data().createdAt?.toDate?.() || new Date(0);
        const rightDate = right.data().createdAt?.toDate?.() || new Date(0);
        return rightDate - leftDate;
    });

    return {
        id: docs[0].id,
        ...docs[0].data()
    };
}

function getBookingPaymentIdentifiers(booking) {
    return [
        booking?.id,
        booking?.bookingRequestId,
        booking?.referenceId,
        booking?.bookingReferenceId
    ]
        .map((value) => String(value || "").trim())
        .filter((value, index, list) => value && list.indexOf(value) === index);
}

function sortPaymentRecords(records = []) {
    return records.slice().sort((left, right) => {
        const leftDate = left.createdAt?.toDate?.() || new Date(0);
        const rightDate = right.createdAt?.toDate?.() || new Date(0);
        return rightDate - leftDate;
    });
}

async function loadPaymentRecords(userId, approvedBooking) {
    const identifiers = getBookingPaymentIdentifiers(
        typeof approvedBooking === "string" ? { id: approvedBooking } : approvedBooking
    );

    if (!identifiers.length) {
        return [];
    }

    const recordsById = new Map();
    const queryTargets = [
        { field: "bookingRequestId", values: identifiers },
        { field: "bookingReferenceId", values: identifiers }
    ];

    const snapshots = await Promise.all(
        queryTargets.flatMap((target) =>
            target.values.map((identifier) =>
                db.collection("payments")
                    .where("userId", "==", userId)
                    .where(target.field, "==", identifier)
                    .get()
            )
        )
    );

    snapshots.forEach((snapshot) => {
        snapshot.forEach((doc) => {
            recordsById.set(doc.id, {
                id: doc.id,
                ...doc.data()
            });
        });
    });

    return sortPaymentRecords([...recordsById.values()]);
}

async function loadBillingInvoices(userId, approvedBooking) {
    if (!approvedBooking?.id) {
        return [];
    }

    const identifiers = getBookingPaymentIdentifiers(approvedBooking);
    const recordsById = new Map();

    const snapshots = await Promise.all(
        identifiers.map((identifier) =>
            db.collection("billingInvoices")
                .where("userId", "==", userId)
                .where("bookingRequestId", "==", identifier)
                .get()
        )
    );

    snapshots.forEach((snapshot) => {
        snapshot.forEach((doc) => {
            recordsById.set(doc.id, {
                id: doc.id,
                ...doc.data()
            });
        });
    });

    return [...recordsById.values()].sort((left, right) => {
        const leftDate = parseInvoiceDate(left.periodStart) || parseInvoiceDate(left.dueDate) || new Date(0);
        const rightDate = parseInvoiceDate(right.periodStart) || parseInvoiceDate(right.dueDate) || new Date(0);
        return leftDate - rightDate;
    });
}

async function loadAddonState(approvedBooking) {
    if (!approvedBooking?.id || isTransientPaymentMode()) {
        return {
            catalog: [],
            addOns: [],
            requestedAddons: [],
            nextAdjustableBillingMonth: ""
        };
    }

    let result = null;
    try {
        result = await callPaymentApi("/api/addons/list", {
            bookingRequestId: approvedBooking.id
        });
    } catch (error) {
        if (error.status === 404 && error.code === "not-found") {
            console.warn("Add-on service route is unavailable; continuing without add-on state.", error);
            showPaymentToast("Payment details loaded. Add-on controls are temporarily unavailable.");
            return {
                catalog: [],
                addOns: [],
                requestedAddons: [],
                nextAdjustableBillingMonth: ""
            };
        }

        throw error;
    }

    return {
        catalog: Array.isArray(result.catalog) ? result.catalog : [],
        addOns: Array.isArray(result.addOns) ? result.addOns : [],
        requestedAddons: Array.isArray(result.requestedAddons) ? result.requestedAddons : [],
        nextAdjustableBillingMonth: String(result.nextAdjustableBillingMonth || "").trim()
    };
}

async function loadApprovedTransientBooking(userId, transientBookingId) {
    const safeId = String(transientBookingId || "").trim();
    if (!safeId) {
        return null;
    }

    const doc = await db.collection("transientBedBookings").doc(safeId).get();
    if (!doc.exists) {
        return null;
    }

    const data = doc.data();
    if (data.userId !== userId || data.status !== "approved") {
        return null;
    }

    return {
        id: doc.id,
        ...data
    };
}

async function loadLatestApprovedTransientBooking(userId) {
    const snapshot = await db.collection("transientBedBookings")
        .where("userId", "==", userId)
        .where("status", "==", "approved")
        .get();

    if (snapshot.empty) {
        return null;
    }

    const docs = snapshot.docs.slice().sort((left, right) => {
        const leftDate = left.data().createdAt?.toDate?.() || new Date(0);
        const rightDate = right.data().createdAt?.toDate?.() || new Date(0);
        return rightDate - leftDate;
    });

    return {
        id: docs[0].id,
        ...docs[0].data()
    };
}

async function loadTransientPaymentRecords(userId, transientBookingId) {
    if (!transientBookingId) {
        return [];
    }

    const snapshot = await db.collection("payments")
        .where("userId", "==", userId)
        .where("transientBookingId", "==", transientBookingId)
        .get();

    return snapshot.docs
        .map((doc) => ({
            id: doc.id,
            ...doc.data()
        }))
        .sort((left, right) => {
            const leftDate = left.createdAt?.toDate?.() || new Date(0);
            const rightDate = right.createdAt?.toDate?.() || new Date(0);
            return rightDate - leftDate;
        });
}

function getLatestDownPaymentRecord(paymentRecords = []) {
    const downPayments = sortPaymentRecords(paymentRecords.filter((record) => record.type === "down_payment"));
    return downPayments.find((record) => record.status === "paid") || downPayments[0] || null;
}

function renderCurrentBills(approvedBooking, downPaymentRecord, paymentRecords) {
    if (isTransientPaymentMode()) {
        renderTransientCurrentBill(paymentRecords);
        return;
    }

    const primarySummaryLabel = document.querySelector(".summary-card.emphasis .summary-label");
    const roomLabel = approvedBooking?.room ? `Room ${approvedBooking.room}` : "Assigned Room";
    const list = document.getElementById("currentBillsList");
    if (!list) {
        return;
    }

    const monthlySchedule = getMonthlyBillingSchedule(approvedBooking, downPaymentRecord, paymentRecords);
    const action = getPrimaryPaymentAction(approvedBooking, downPaymentRecord, paymentRecords);
    if (primarySummaryLabel) {
        primarySummaryLabel.textContent = action.kind === "down_payment"
            ? "Required Down Payment"
            : action.kind === "monthly_rent"
                ? "Current Monthly Bill"
                : "Down Payment Paid";
    }

    const dueDate = addDays(new Date(), 5);
    let bills = [];

    if (action.kind === "down_payment") {
        const requestedAddons = getRequestedDownPaymentAddons();
        const requestedAddonsTotal = requestedAddons.reduce((sum, addon) => sum + Number(addon.price || 0), 0);
        const totalInitialAmount = DOWN_PAYMENT_AMOUNT + requestedAddonsTotal;
        const addonMeta = requestedAddonsTotal
            ? ` Includes selected add-ons worth ${formatCurrency(requestedAddonsTotal)}.`
            : "";
        bills = [
            {
                name: `Required Down Payment - ${roomLabel}`,
                meta: `Approved booking reference ${approvedBooking?.referenceId || approvedBooking?.id || "N/A"}.${addonMeta}`,
                amount: totalInitialAmount,
                status: downPaymentRecord?.status === "paid" ? "paid" : "pending",
                calculation: requestedAddonsTotal
                    ? buildBillingCalculation(DOWN_PAYMENT_AMOUNT, requestedAddons, totalInitialAmount)
                    : ""
            }
        ];
    } else if (action.kind === "monthly_rent" && action.entry) {
        const addonSummary = getInvoiceAddonSummary(action.entry.invoice);
        const calculationAddons = addonSummary.addons.length ? addonSummary.addons : getVisibleMonthlyAddons();
        const monthlyRateFallback = approvedBooking.monthlyRate || monthlySchedule?.monthlyAmount || action.entry.amount || 0;
        const calculationBase = getInvoiceCalculationBase(
            action.entry.invoice,
            monthlyRateFallback
        );
        const calculationTotal = calculationAddons.length && !addonSummary.addons.length
            ? calculationBase + calculationAddons.reduce((sum, addon) => sum + Number(addon.price || 0), 0)
            : action.entry.amount;
        const addonNote = addonSummary.addonsAmount
            ? ` Includes ${addonSummary.labels.join(", ")} worth ${formatCurrency(addonSummary.addonsAmount)}.`
            : "";
        bills = [
            {
                name: `${formatBillingMonthLabel(action.entry.billingMonth)} Rent`,
                meta: `Due on ${formatDate(action.entry.dueDate)} based on your approved move-in date.${addonNote}`,
                amount: calculationTotal,
                status: action.entry.status.key === "paid"
                    ? "paid"
                    : action.entry.status.key === "gateway"
                        ? "partial"
                        : action.entry.status.key === "overdue"
                            ? "pending"
                            : "pending",
                calculation: buildInvoiceBillingCalculation(
                    action.entry.invoice,
                    monthlyRateFallback,
                    calculationAddons,
                    calculationTotal,
                    action.entry.depositCredit || 0
                )
            }
        ];
    } else {
        bills = [
            {
                name: `Required Down Payment - ${roomLabel}`,
                meta: `Approved booking reference ${approvedBooking?.referenceId || approvedBooking?.id || "N/A"}`,
                amount: DOWN_PAYMENT_AMOUNT,
                status: "paid",
                calculation: ""
            }
        ];
    }

    list.innerHTML = bills.map((bill) => `
        <div class="bill-item">
            <div class="bill-main">
                <div class="bill-name">${bill.name}</div>
                <div class="bill-meta">${bill.meta}</div>
                ${bill.calculation ? `<div class="bill-calculation">${bill.calculation}</div>` : ""}
            </div>
            <div class="bill-right">
                <div class="bill-amount">${formatCurrency(bill.amount)}</div>
                <div class="bill-status ${bill.status}">${bill.status === "paid" ? "Paid" : "Awaiting Payment"}</div>
            </div>
        </div>
    `).join("");

    const outstandingAmount = document.getElementById("outstandingAmount");
    const outstandingCalculation = document.getElementById("outstandingCalculation");
    const currentDueText = document.getElementById("currentDueText");
    const paymentStatusValue = document.getElementById("nextDueDate");
    const paymentStatusSub = document.getElementById("paymentStatusSub");
    const billingStageBadge = document.getElementById("billingStageBadge");
    const statusSummaryLabel = document.getElementById("statusSummaryLabel");
    const currentBillingPanelSub = document.getElementById("currentBillingPanelSub");
    const currentBillCalculation = bills[0]?.calculation || "";
    const billingRestrictionMessage = getBillingRestrictionMessage(activeUserData, approvedBooking);
    const billingRestricted = Boolean(billingRestrictionMessage);

    if (outstandingAmount) {
        if (action.kind === "down_payment") {
            outstandingAmount.textContent = formatCurrency(bills[0]?.amount || DOWN_PAYMENT_AMOUNT);
        } else if (action.kind === "monthly_rent" && action.entry) {
            outstandingAmount.textContent = formatCurrency(bills[0]?.amount || action.entry.amount);
        } else {
            outstandingAmount.textContent = formatCurrency(0);
        }
    }

    if (outstandingCalculation) {
        outstandingCalculation.textContent = currentBillCalculation;
        outstandingCalculation.classList.toggle("show", Boolean(currentBillCalculation));
    }

    if (currentDueText) {
        if (billingRestricted) {
            currentDueText.textContent = billingRestrictionMessage;
        } else if (action.kind === "down_payment") {
            currentDueText.textContent = bills[0]?.calculation
                ? `Please settle on or before ${formatDate(dueDate)} to proceed with move-in scheduling. Your first payment already includes the add-ons selected in your request.`
                : `Please settle on or before ${formatDate(dueDate)} to proceed with move-in scheduling.`;
        } else if (action.kind === "monthly_rent" && action.entry) {
            currentDueText.textContent = action.entry.status.key === "gateway"
                ? `Your ${formatBillingMonthLabel(action.entry.billingMonth)} rent checkout is already pending confirmation.`
                : `Your next monthly rent is due on ${formatDate(action.entry.dueDate)}.`;
        } else {
            currentDueText.textContent = "Your required down payment has already been recorded. No unpaid monthly bill is due right now.";
        }
    }

    if (statusSummaryLabel) {
        statusSummaryLabel.textContent = action.kind === "monthly_rent" ? "Next Monthly Due" : "Payment Status";
    }

    if (paymentStatusValue) {
        if (billingRestricted) {
            paymentStatusValue.textContent = activeUserData?.manualBillingHold === true || approvedBooking?.manualBillingHold === true
                ? "Billing Hold"
                : "Delinquent";
        } else if (action.kind === "monthly_rent" && action.entry) {
            paymentStatusValue.textContent = action.entry.status.key === "gateway"
                ? "Pending Gateway"
                : formatDate(action.entry.dueDate);
        } else {
            paymentStatusValue.textContent = formatPaymentStatus(downPaymentRecord?.status || "unpaid");
        }
    }

    if (paymentStatusSub) {
        if (billingRestricted) {
            paymentStatusSub.textContent = "You can still pay the current bill, but transfer and add-on changes are temporarily disabled.";
        } else if (action.kind === "monthly_rent" && monthlySchedule?.nextDue) {
            paymentStatusSub.textContent = monthlySchedule.source === "billingInvoices"
                ? `This amount comes from your official billing invoice schedule and is due every 1st day after the first prorated bill.`
                : `Monthly rent of ${formatCurrency(monthlySchedule.monthlyAmount)} is based on your ${approvedBooking.contractLabel || "approved"} contract and billed every ${monthlySchedule.anchorDay}${getDaySuffix(monthlySchedule.anchorDay)} of the month.`;
        } else {
            const requestedAddons = getRequestedDownPaymentAddons();
            const requestedAddonsTotal = requestedAddons.reduce((sum, addon) => sum + Number(addon.price || 0), 0);
            paymentStatusSub.textContent = downPaymentRecord
                ? `${formatPaymentMethodLabel(downPaymentRecord.method)} request created on ${formatTimestamp(downPaymentRecord.createdAt)}.`
                : requestedAddonsTotal
                    ? `Your first checkout will collect the PHP 1,000.00 down payment plus ${formatCurrency(requestedAddonsTotal)} for ${requestedAddons.map((addon) => addon.addonName).join(", ")}.`
                    : "Waiting for your first payment method selection.";
        }
    }

    if (billingStageBadge) {
        billingStageBadge.textContent = billingRestricted
            ? (activeUserData?.manualBillingHold === true || approvedBooking?.manualBillingHold === true ? "Restricted" : "Delinquent")
            : action.kind === "down_payment"
                ? "Required"
                : action.kind === "monthly_rent"
                    ? "Monthly Due"
                    : "Settled";
    }

    if (currentBillingPanelSub) {
        currentBillingPanelSub.textContent = billingRestricted
            ? `${billingRestrictionMessage} You can continue paying from this page.`
            : action.kind === "monthly_rent"
                ? currentBillCalculation
                    ? `Your current monthly rent obligation based on the approved move-in schedule. Breakdown: ${currentBillCalculation}`
                    : "Your current monthly rent obligation based on the approved move-in schedule."
                : currentBillCalculation
                    ? `Current approved-tenant billing requirement before gateway handoff. Breakdown: ${currentBillCalculation}`
                    : "Current approved-tenant billing requirement before gateway handoff.";
    }
}

function renderTransientCurrentBill(paymentRecords) {
    const list = document.getElementById("currentBillsList");
    if (!list || !activeTransientBooking) {
        return;
    }

    const latestRecord = paymentRecords[0] || null;
    const isPaid = activeTransientBooking.paymentStatus === "paid" || latestRecord?.status === "paid";
    const amount = Number(activeTransientBooking.totalAmount || 0);

    list.innerHTML = `
        <div class="bill-item">
            <div class="bill-main">
                <div class="bill-name">Transient Bed Bill - Room ${activeTransientBooking.room}, Bed ${activeTransientBooking.bed}</div>
                <div class="bill-meta">${activeTransientBooking.nights || 0} ${Number(activeTransientBooking.nights) === 1 ? "day" : "days"} stay, reference ${activeTransientBooking.referenceId || activeTransientBooking.id}</div>
            </div>
            <div class="bill-right">
                <div class="bill-amount">${formatCurrency(amount)}</div>
                <div class="bill-status ${isPaid ? "paid" : "pending"}">${isPaid ? "Paid" : "Awaiting Payment"}</div>
            </div>
        </div>
    `;

    const outstandingAmount = document.getElementById("outstandingAmount");
    const outstandingCalculation = document.getElementById("outstandingCalculation");
    const currentDueText = document.getElementById("currentDueText");
    const paymentStatusValue = document.getElementById("nextDueDate");
    const paymentStatusSub = document.getElementById("paymentStatusSub");
    const billingStageBadge = document.getElementById("billingStageBadge");
    const statusSummaryLabel = document.getElementById("statusSummaryLabel");
    const currentBillingPanelSub = document.getElementById("currentBillingPanelSub");
    const primarySummaryLabel = document.querySelector(".summary-card.emphasis .summary-label");

    if (primarySummaryLabel) primarySummaryLabel.textContent = "Transient Bed Bill";
    if (outstandingAmount) outstandingAmount.textContent = formatCurrency(isPaid ? 0 : amount);
    if (outstandingCalculation) {
        outstandingCalculation.textContent = "";
        outstandingCalculation.classList.remove("show");
    }
    if (currentDueText) currentDueText.textContent = isPaid
        ? "Your approved Transient Bed bill has already been paid."
        : "Choose a payment channel to settle your approved Transient Bed bill.";
    if (statusSummaryLabel) statusSummaryLabel.textContent = "Transient Payment Status";
    if (paymentStatusValue) paymentStatusValue.textContent = formatPaymentStatus(isPaid ? "paid" : latestRecord?.status || "unpaid");
    if (paymentStatusSub) paymentStatusSub.textContent = latestRecord
        ? `${formatPaymentMethodLabel(latestRecord.method)} request created on ${formatTimestamp(latestRecord.createdAt)}.`
        : "Waiting for your payment method selection.";
    if (billingStageBadge) billingStageBadge.textContent = isPaid ? "Settled" : "Approved";
    if (currentBillingPanelSub) currentBillingPanelSub.textContent = "Approved Transient Bed billing requirement before gateway handoff.";
}

function getDaySuffix(day) {
    if (day >= 11 && day <= 13) return "th";
    const lastDigit = day % 10;
    if (lastDigit === 1) return "st";
    if (lastDigit === 2) return "nd";
    if (lastDigit === 3) return "rd";
    return "th";
}

function renderPaymentHistory(paymentRecords) {
    const historyList = document.getElementById("paymentHistoryList");
    if (!historyList) {
        return;
    }

    const history = paymentRecords.length
        ? paymentRecords.map((record) => ({
            id: record.id,
            name: record.type === "transient_bed"
                ? "Transient Bed Payment"
                : record.type === "monthly_rent"
                ? `${formatBillingMonthLabel(record.billingMonth)} Rent`
                : "Down Payment Request",
            meta: `${formatPaymentMethodLabel(record.method)} selected on ${formatTimestamp(record.createdAt)}`,
            amount: record.amount || DOWN_PAYMENT_AMOUNT,
            status: record.status === "paid"
                ? "paid"
                : record.status === "pending_gateway"
                    ? "partial"
                    : "pending",
            receiptAvailable: record.status === "paid"
        }))
        : [
            {
                name: "No payment request yet",
                meta: isTransientPaymentMode()
                    ? "Select a payment channel and continue to settle your approved Transient Bed bill."
                    : "Select Card, GCash, or Maya and continue to create your first down payment request.",
                amount: isTransientPaymentMode() ? activeTransientBooking?.totalAmount || 0 : DOWN_PAYMENT_AMOUNT,
                status: "pending"
            }
        ];

    historyList.innerHTML = history.map((item) => `
        <div class="history-item">
            <div class="history-main">
                <div class="history-name">${item.name}</div>
                <div class="history-meta">${item.meta}</div>
            </div>
            <div class="history-right">
                <div class="history-amount">${formatCurrency(item.amount)}</div>
                <div class="history-status ${item.status}">${item.status === "paid" ? "paid" : "pending"}</div>
                ${item.receiptAvailable ? `<button type="button" class="receipt-download-btn" data-receipt-id="${item.id}">Receipt PDF</button>` : ""}
            </div>
        </div>
    `).join("");

    historyList.querySelectorAll("[data-receipt-id]").forEach((button) => {
        button.addEventListener("click", () => {
            downloadPaymentReceiptPdf(button.dataset.receiptId);
        });
    });
}

function renderAddonManagement(approvedBooking) {
    const panel = document.getElementById("addonsPanel");
    const catalogList = document.getElementById("addonsCatalogList");
    const badge = document.getElementById("addonsPanelBadge");
    const panelSub = document.getElementById("addonsPanelSub");

    if (!panel || !catalogList || !badge || !panelSub) {
        return;
    }

    if (isTransientPaymentMode() || !approvedBooking?.id) {
        panel.style.display = "none";
        return;
    }

    panel.style.display = "";

    const catalog = Array.isArray(activeAddonState.catalog) ? activeAddonState.catalog : [];
    const activeAddons = Array.isArray(activeAddonState.addOns) ? activeAddonState.addOns : [];
    const requestedAddons = Array.isArray(activeAddonState.requestedAddons) ? activeAddonState.requestedAddons : [];
    const activeMap = new Map(activeAddons.map((addon) => [addon.addonId || addon.id, addon]));
    const restrictionMessage = getBillingRestrictionMessage();
    const billingRestricted = Boolean(restrictionMessage);
    const visibleActiveAddons = activeAddons.length
        ? activeAddons
        : requestedAddons.map((addon) => ({
            ...addon,
            addonId: addon.addonId || addon.id,
            addonName: addon.addonName || addon.name,
            status: "active",
            source: "booking_request"
        }));

    badge.textContent = billingRestricted
        ? "Restricted"
        : activeAddons.some((addon) => addon.status === "scheduled_cancel")
            ? "Changes Pending"
            : visibleActiveAddons.length
                ? "Active"
                : "Optional";
    panelSub.textContent = billingRestricted
        ? restrictionMessage
        : activeAddonState.nextAdjustableBillingMonth
            ? `Add-on changes will start from ${describeAddonActivationMonth(activeAddonState.nextAdjustableBillingMonth)}. Paid and pending gateway invoices stay unchanged.`
            : "All current billing cycles are already settled or locked, so add-on changes will wait for the next unpaid cycle.";

    catalogList.innerHTML = catalog.length
        ? catalog.map((addon) => {
            const activeAddon = activeMap.get(addon.id)
                || visibleActiveAddons.find((item) => (item.addonId || item.id) === addon.id)
                || null;
            const status = String(activeAddon?.status || "").toLowerCase();
            const isSelected = Boolean(activeAddon) && status !== "cancelled";
            const isScheduledCancel = status === "scheduled_cancel";
            const startMonth = activeAddon?.effectiveStartMonth || activeAddonState.nextAdjustableBillingMonth;
            const note = isScheduledCancel
                ? `This service remains billed through ${formatBillingMonthLabel(activeAddon?.effectiveEndMonth)} and will stop after that cycle.`
                : isSelected
                    ? activeAddon?.effectiveStartMonth
                        ? `Selected and billed starting ${describeAddonActivationMonth(activeAddon.effectiveStartMonth)}.`
                        : "Selected during booking and included in your upcoming eligible billing."
                    : `Available starting ${describeAddonActivationMonth(activeAddonState.nextAdjustableBillingMonth)}`;
            const buttonClass = isSelected ? "danger" : "primary";
            const buttonLabel = isScheduledCancel
                ? "Cancellation Scheduled"
                : isSelected
                    ? "Cancel Service"
                    : "Add Service";
            const buttonAction = isSelected ? "cancel" : "activate";
            const disableButton = billingRestricted || isScheduledCancel || !activeAddonState.nextAdjustableBillingMonth;

            return `
                <div class="addon-billing-card ${isSelected ? "active" : ""}">
                    <div class="addon-billing-top">
                        <div>
                            <div class="addon-billing-name">${addon.name}</div>
                            <div class="addon-billing-desc">${addon.description || "Monthly add-on service"}</div>
                        </div>
                        <div class="addon-billing-price">${formatCurrency(addon.price)}</div>
                    </div>
                    <div class="addon-billing-meta">
                        <div class="addon-billing-note">${note}</div>
                        <span class="addon-billing-status ${isSelected ? (isScheduledCancel ? "scheduled" : "active") : "available"}">${isSelected ? (isScheduledCancel ? "Stops Next Cycle" : "Selected") : "Available"}</span>
                    </div>
                    <div class="addon-billing-actions">
                        <button type="button" class="addon-action-btn ${buttonClass}" data-addon-action="${buttonAction}" data-addon-id="${addon.id}" ${disableButton ? "disabled" : ""}>
                            ${buttonLabel}
                        </button>
                    </div>
                </div>
            `;
        }).join("")
        : `<div class="addons-empty-state">No add-on services are configured yet.</div>`;

    panel.querySelectorAll("[data-addon-action]").forEach((button) => {
        button.addEventListener("click", async () => {
            const action = button.dataset.addonAction;
            const addonId = button.dataset.addonId;
            if (!addonId || !approvedBooking?.id) {
                return;
            }

            const originalLabel = button.textContent;
            button.disabled = true;
            button.textContent = action === "activate" ? "Adding..." : "Cancelling...";

            try {
                await callPaymentApi(`/api/addons/${action === "activate" ? "activate" : "cancel"}`, {
                    bookingRequestId: approvedBooking.id,
                    addonId
                });

                let paymentRecords = await loadPaymentRecords(auth.currentUser.uid, approvedBooking);
                const downPaymentRecord = getLatestDownPaymentRecord(paymentRecords);
                activeBillingInvoices = (downPaymentRecord?.status === "paid" || isRenewalBilling(approvedBooking))
                    ? await loadBillingInvoices(auth.currentUser.uid, approvedBooking)
                    : [];
                activeAddonState = await loadAddonState(approvedBooking);
                activePaymentRecords = paymentRecords;
                populatePaymentSummary(activeUserData, approvedBooking, downPaymentRecord, paymentRecords);
                showPaymentToast(action === "activate"
                    ? "Add-on saved. Your future unpaid billing cycles have been updated."
                    : "Add-on cancellation saved. Future unpaid billing cycles have been updated.");
            } catch (error) {
                console.error("Add-on update failed:", error);
                showPaymentToast(getFriendlyPaymentApiError(error, "Unable to update this add-on right now."));
                button.disabled = false;
                button.textContent = originalLabel;
            }
        });
    });
}

function renderMonthlyBilling(approvedBooking, downPaymentRecord, paymentRecords) {
    const summary = document.getElementById("monthlyBillingSummary");
    const list = document.getElementById("monthlyBillingList");
    const badge = document.getElementById("monthlyBillingBadge");
    const sub = document.getElementById("monthlyBillingSub");

    if (!summary || !list || !badge || !sub) {
        return;
    }

    if (isTransientPaymentMode()) {
        const panel = document.getElementById("monthlyBillingPanel");
        if (panel) panel.style.display = "none";
        return;
    }

    const schedule = getMonthlyBillingSchedule(approvedBooking, downPaymentRecord, paymentRecords);

    if (!schedule) {
        badge.textContent = "Locked";
        summary.innerHTML = "";
        list.innerHTML = `<div class="monthly-empty">Your recurring monthly billing will appear here after the required down payment is marked as paid.</div>`;
        sub.textContent = "Your recurring monthly billing will appear here after the required down payment is confirmed.";
        return;
    }

    if (schedule.missingMoveInDate) {
        badge.textContent = "Pending";
        summary.innerHTML = `
            <div class="monthly-summary-card">
                <div class="monthly-summary-label">Move-in Schedule Needed</div>
                <div class="monthly-summary-value">No move-in date found</div>
                <div class="monthly-summary-note">Your down payment is already recorded, but we still need a valid approved move-in date before monthly due dates can be generated.</div>
            </div>
        `;
        list.innerHTML = "";
        sub.textContent = "Monthly due dates are waiting for your approved move-in schedule.";
        return;
    }

    badge.textContent = "Active";
    sub.textContent = schedule.source === "billingInvoices"
        ? "This monthly billing schedule is loaded from your official generated invoices."
        : `This projected monthly billing schedule is based on your approved move-in date of ${formatDate(schedule.moveInDate)}.`;
    const nextAddonSummary = getInvoiceAddonSummary(schedule.nextDue?.invoice);
    const nextCalculationAddons = nextAddonSummary.addons.length ? nextAddonSummary.addons : getVisibleMonthlyAddons();
    const nextMonthlyRateFallback = approvedBooking.monthlyRate || schedule.monthlyAmount || 0;
    const nextBaseAmount = getInvoiceCalculationBase(
        schedule.nextDue?.invoice,
        nextMonthlyRateFallback
    );
    const nextCalculatedTotal = nextCalculationAddons.length && !nextAddonSummary.addons.length
        ? nextBaseAmount + nextCalculationAddons.reduce((sum, addon) => sum + Number(addon.price || 0), 0)
        : Number(schedule.nextDue?.amount || schedule.monthlyAmount || 0);
    const nextCalculation = buildInvoiceBillingCalculation(
        schedule.nextDue?.invoice,
        nextMonthlyRateFallback,
        nextCalculationAddons,
        nextCalculatedTotal,
        schedule.nextDue?.depositCredit || 0
    );

    summary.innerHTML = `
        <div class="monthly-summary-card">
            <div class="monthly-summary-label">${schedule.source === "billingInvoices" ? "Current Monthly Billing" : "Monthly Rent"}</div>
            <div class="monthly-summary-value">${formatCurrency(nextCalculatedTotal)}</div>
            <div class="monthly-calculation">${nextCalculation}</div>
            <div class="monthly-summary-note">${schedule.source === "billingInvoices"
                ? (nextAddonSummary.addonsAmount
                        ? `This upcoming invoice already includes ${nextAddonSummary.labels.join(", ")} worth ${formatCurrency(nextAddonSummary.addonsAmount)}.`
                        : "First bill may be prorated. Later bills use your official invoice schedule.")
                : `Billing recurs every ${schedule.anchorDay}${getDaySuffix(schedule.anchorDay)} of the month, starting one month after your move-in date.`}</div>
        </div>
    `;

    list.innerHTML = schedule.entries.map((entry, index) => {
        const addonSummary = getInvoiceAddonSummary(entry.invoice);
        const calculationAddons = addonSummary.addons.length ? addonSummary.addons : getVisibleMonthlyAddons();
        const monthlyRateFallback = approvedBooking.monthlyRate || schedule.monthlyAmount || 0;
        const baseAmount = getInvoiceCalculationBase(
            entry.invoice,
            monthlyRateFallback
        );
        const displayAmount = calculationAddons.length && !addonSummary.addons.length
            ? baseAmount + calculationAddons.reduce((sum, addon) => sum + Number(addon.price || 0), 0)
            : Number(entry.amount || 0);
        const calculation = buildInvoiceBillingCalculation(
            entry.invoice,
            monthlyRateFallback,
            calculationAddons,
            displayAmount,
            entry.depositCredit || 0
        );

        return `
            <div class="history-item">
                <div class="history-main">
                    <div class="history-name">${entry.invoiceType === "first_prorated_rent" ? "First Prorated Rent" : entry.invoiceType === "final_rent" ? "Final Month Rent" : index === 0 ? "Current Billing Cycle" : `Upcoming Billing Cycle ${index}`}</div>
                    <div class="history-meta">Due on ${formatDate(entry.dueDate)}${entry.depositCredit ? `, includes ${formatCurrency(entry.depositCredit)} deposit credit` : ""}${entry.addonsAmount ? `, plus ${formatCurrency(entry.addonsAmount)} for ${entry.addons.map((addon) => addon.addonName || addon.name).join(", ")}` : ""}.</div>
                    <div class="monthly-calculation">${calculation}</div>
                </div>
                <div class="history-right">
                    <div class="history-amount">${formatCurrency(displayAmount)}</div>
                    <div class="history-status ${entry.status.key === "gateway" ? "partial" : entry.status.key}">${entry.status.label}</div>
                </div>
            </div>
        `;
    }).join("");
}

function updatePaymentButton(approvedBooking, downPaymentRecord, paymentRecords) {
    const payButton = document.getElementById("payCurrentBtn");
    if (!payButton) {
        return;
    }

    const heroTitle = document.getElementById("paymentHeroTitle");
    const heroSub = document.getElementById("paymentHeroSub");
    const action = getPrimaryPaymentAction(approvedBooking, downPaymentRecord, paymentRecords);

    if (paymentSubmitting) {
        setButtonLoading(payButton, "Preparing checkout...");
        return;
    }

    restoreButton(payButton);

    if (isTransientPaymentMode()) {
        const isPaid = activeTransientBooking?.paymentStatus === "paid" || paymentRecords.some((record) => record.status === "paid");
        if (!activeTransientBooking || isPaid) {
            payButton.disabled = true;
            payButton.innerHTML = "&#10004; No Bill Due Right Now";
        } else {
            payButton.disabled = false;
            payButton.innerHTML = `&#128179; Pay Transient Bed with ${formatPaymentMethodLabel(selectedPaymentMethod)}`;
        }
        if (heroTitle) heroTitle.textContent = "Transient Bed Payment";
        if (heroSub) heroSub.textContent = "Your Transient Bed request has been approved. Choose any available payment channel below to settle your bill.";
        return;
    }

    if (action.kind === "down_payment") {
        payButton.disabled = false;
        payButton.innerHTML = `&#128179; Continue with ${formatPaymentMethodLabel(selectedPaymentMethod)}`;
        if (heroTitle) heroTitle.textContent = "Down Payment Checkout";
        if (heroSub) heroSub.textContent = isPendingDownPaymentBooking(approvedBooking)
            ? "Your bedspace is reserved for you. Complete the required PHP 1,000.00 down payment to activate your stay."
            : "Approved tenants can now begin the required PHP 1,000.00 down payment using your selected PayMongo payment channel.";
        return;
    }

    if (action.kind === "monthly_rent" && action.entry) {
        const monthLabel = formatBillingMonthLabel(action.entry.billingMonth);
        const hasReusableCheckout = action.record?.status === "pending_gateway"
            && action.record?.paymongoCheckoutUrl
            && action.record?.method === selectedPaymentMethod;

        payButton.disabled = false;
        payButton.innerHTML = hasReusableCheckout
            ? `&#128279; Resume ${monthLabel} Checkout`
            : `&#128179; Pay ${monthLabel} Rent`;
        if (heroTitle) heroTitle.textContent = "Monthly Rent Billing";
        if (heroSub) heroSub.textContent = "Your down payment is already recorded. You can now settle the next monthly rent bill based on your approved move-in date using your selected PayMongo payment channel.";
        return;
    }

    payButton.disabled = true;
    payButton.innerHTML = "&#10004; No Bill Due Right Now";
    if (heroTitle) heroTitle.textContent = "Tenant Billing Checkout";
    if (heroSub) heroSub.textContent = "Your approved booking is fully up to date for the current billing cycle. Monthly rent payments will appear here once a new cycle becomes due.";
}

function populatePaymentSummary(userData, approvedBooking, downPaymentRecord, paymentRecords) {
    const welcomeLogger = document.getElementById("welcomeLogger");
    const roomText = document.getElementById("userRoomText");
    const avatarBtn = document.getElementById("avatarBtn");
    const currentPlan = document.getElementById("currentPlan");
    const planSub = document.getElementById("planSub");

    const fullName = userData.fullName || userData.username || "Tenant";
    const billingTarget = isTransientPaymentMode() ? activeTransientBooking : approvedBooking;
    const roomLabel = billingTarget?.room ? `Room ${billingTarget.room}` : (userData.room || "Approved tenant");
    const bedLabel = billingTarget?.bed ? ` - Bed ${billingTarget.bed}` : "";
    const roomType = isTransientPaymentMode()
        ? "Transient Bed"
        : approvedBooking?.type || "Dormitory Stay";
    const monthlyRate = getApprovedMonthlyRate(approvedBooking);

    if (welcomeLogger) {
        welcomeLogger.textContent = fullName;
    }
    if (roomText) {
        roomText.textContent = `${roomLabel}${bedLabel}`;
    }
    if (avatarBtn) {
        avatarBtn.textContent = getInitials(fullName);
    }
    if (currentPlan) {
        currentPlan.textContent = roomType;
    }
    if (planSub) {
        planSub.textContent = isTransientPaymentMode()
            ? `${roomLabel}${bedLabel} - Approved transient stay ${formatCurrency(activeTransientBooking?.totalAmount || 0)}.`
            : `${roomLabel}${bedLabel} - ${approvedBooking?.contractLabel || "Approved contract"} monthly rate ${formatCurrency(monthlyRate)}.`;
    }

    renderCurrentBills(approvedBooking, downPaymentRecord, paymentRecords);
    renderPaymentHistory(paymentRecords);
    renderAddonManagement(approvedBooking);
    renderMonthlyBilling(approvedBooking, downPaymentRecord, paymentRecords);
    updatePaymentButton(approvedBooking, downPaymentRecord, paymentRecords);
}

async function refreshMonthlyPaymentState(userId, approvedBooking, options = {}) {
    if (!userId || !approvedBooking?.id || isTransientPaymentMode()) {
        return null;
    }

    const {
        paymentRecords: initialPaymentRecords = null,
        ensureInvoices = false,
        rerender = true
    } = options;

    let paymentRecords = Array.isArray(initialPaymentRecords)
        ? initialPaymentRecords
        : await loadPaymentRecords(userId, approvedBooking);
    const pendingPaymentsChanged = await verifyPendingGatewayPayments(paymentRecords);

    if (pendingPaymentsChanged || !Array.isArray(initialPaymentRecords)) {
        paymentRecords = await loadPaymentRecords(userId, approvedBooking);
    }

    let downPaymentRecord = getLatestDownPaymentRecord(paymentRecords);
    const invoicesEnsured = ensureInvoices
        ? await ensurePaidDownPaymentInvoices(downPaymentRecord)
        : false;

    if (invoicesEnsured) {
        paymentRecords = await loadPaymentRecords(userId, approvedBooking);
        downPaymentRecord = getLatestDownPaymentRecord(paymentRecords);
    }

    const [billingInvoices, addonState] = await Promise.all([
        (downPaymentRecord?.status === "paid" || isRenewalBilling(approvedBooking))
            ? loadBillingInvoices(userId, approvedBooking)
            : Promise.resolve([]),
        loadAddonState(approvedBooking)
    ]);

    activePaymentRecords = paymentRecords;
    activeDownPaymentRecord = downPaymentRecord;
    activeBillingInvoices = billingInvoices;
    activeAddonState = addonState;

    if (rerender && activeUserData) {
        populatePaymentSummary(activeUserData, activeApprovedBooking, activeDownPaymentRecord, activePaymentRecords);
    }

    return { paymentRecords, downPaymentRecord, billingInvoices, addonState };
}

async function guardApprovedTenant(user) {
    const doc = await db.collection("users").doc(user.uid).get();
    if (!doc.exists) {
        throw new Error("missing-user");
    }

    const userData = doc.data();
    if (isTransientPaymentMode()) {
        activePaymentMode = "transient";
        const transientBookingId = getTransientBookingIdFromState();
        const transientBooking = transientBookingId
            ? await loadApprovedTransientBooking(user.uid, transientBookingId)
            : await loadLatestApprovedTransientBooking(user.uid);
        if (!transientBooking) {
            showPaymentToast("No approved Transient Bed bill was found for this account.");
            setTimeout(() => {
                window.location.href = "transient-bed.html";
            }, 1400);
            throw new Error("missing-approved-transient-bed");
        }

        sessionStorage.setItem("activeTransientPaymentId", transientBooking.id);
        let paymentRecords = await loadTransientPaymentRecords(user.uid, transientBooking.id);
        if (await verifyPendingGatewayPayments(paymentRecords)) {
            paymentRecords = await loadTransientPaymentRecords(user.uid, transientBooking.id);
        }
        return {
            userData,
            approvedBooking: null,
            transientBooking,
            downPaymentRecord: null,
            paymentRecords,
            addonState: {
                catalog: [],
                addOns: [],
                nextAdjustableBillingMonth: ""
            }
        };
    }

    const [approvedTransient, approvedBooking] = await Promise.all([
        loadLatestApprovedTransientBooking(user.uid),
        loadLatestApprovedBooking(user.uid)
    ]);
    if (approvedTransient && !approvedBooking) {
        activePaymentMode = "transient";
        sessionStorage.setItem("activeTransientPaymentId", approvedTransient.id);
        let paymentRecords = await loadTransientPaymentRecords(user.uid, approvedTransient.id);
        if (await verifyPendingGatewayPayments(paymentRecords)) {
            paymentRecords = await loadTransientPaymentRecords(user.uid, approvedTransient.id);
        }
        return {
            userData,
            approvedBooking: null,
            transientBooking: approvedTransient,
            downPaymentRecord: null,
            paymentRecords,
            addonState: {
                catalog: [],
                addOns: [],
                nextAdjustableBillingMonth: ""
            }
        };
    }

    if (userData.role === "admin" || !["approved", BOOKING_STATUS_APPROVED_PENDING_DOWN_PAYMENT].includes(normalizeBookingStatus(userData.status))) {
        showPaymentToast("This page is available only for approved or reserved tenant accounts.");
        setTimeout(() => {
            window.location.href = "main.html";
        }, 1400);
        throw new Error("not-approved-tenant");
    }

    if (!approvedBooking) {
        showPaymentToast("No approved booking record was found for this account.");
        setTimeout(() => {
            window.location.href = "main.html";
        }, 1400);
        throw new Error("missing-approved-booking");
    }

    let paymentRecords = await loadPaymentRecords(user.uid, approvedBooking);
    const pendingPaymentsChanged = await verifyPendingGatewayPayments(paymentRecords);
    if (pendingPaymentsChanged) {
        paymentRecords = await loadPaymentRecords(user.uid, approvedBooking);
    }
    const downPaymentRecord = getLatestDownPaymentRecord(paymentRecords);
    const [billingInvoices, addonState] = await Promise.all([
        (downPaymentRecord?.status === "paid" || isRenewalBilling(approvedBooking))
            ? loadBillingInvoices(user.uid, approvedBooking)
            : Promise.resolve([]),
        loadAddonState(approvedBooking)
    ]);
    return { userData, approvedBooking, downPaymentRecord, paymentRecords, billingInvoices, addonState };
}

async function startActualDownPaymentFlow() {
    const user = auth.currentUser;
    if (!user || paymentSubmitting || (!activeApprovedBooking && !activeTransientBooking)) {
        return;
    }

    const sessionStillValid = await touchTenantSession();
    if (!sessionStillValid) {
        return;
    }

    paymentSubmitting = true;
    const payButton = document.getElementById("payCurrentBtn");
    setButtonLoading(payButton, "Preparing checkout...");
    updatePaymentButton(activeApprovedBooking, activeDownPaymentRecord, activePaymentRecords);

    try {
        const action = getPrimaryPaymentAction(activeApprovedBooking, activeDownPaymentRecord, activePaymentRecords);
        let result;

        if (action.kind === "transient_bed") {
            sessionStorage.setItem("activeTransientPaymentId", activeTransientBooking.id);
            result = await callPaymentApi("/api/payments/transient-bed/create", {
                transientBookingId: activeTransientBooking.id,
                method: selectedPaymentMethod,
                baseUrl: getCheckoutBaseUrl()
            });
        } else if (action.kind === "down_payment") {
            result = await callPaymentApi("/api/payments/down-payment/create", {
                bookingRequestId: activeApprovedBooking.id,
                method: selectedPaymentMethod,
                baseUrl: getCheckoutBaseUrl()
            });
        } else if (action.kind === "monthly_rent" && action.entry) {
            if (
                action.record?.status === "pending_gateway"
                && action.record?.paymongoCheckoutUrl
                && action.record?.method === selectedPaymentMethod
            ) {
                window.location.href = action.record.paymongoCheckoutUrl;
                return;
            }

            result = await callPaymentApi("/api/payments/monthly-rent/create", {
                bookingRequestId: activeApprovedBooking.id,
                method: selectedPaymentMethod,
                baseUrl: getCheckoutBaseUrl(),
                billingMonth: action.entry.billingMonth
            });
        } else {
            showPaymentToast("There is no unpaid billing item to settle right now.");
            return;
        }

        const payload = result || {};
        if (!payload.checkoutUrl) {
            throw new Error("Missing checkout URL from the payment service.");
        }

        window.location.href = payload.checkoutUrl;
    } catch (error) {
        console.error("Failed to start checkout:", error);
        showPaymentToast(getFriendlyPaymentApiError(error, "Unable to prepare the payment checkout right now."));
        paymentSubmitting = false;
        restoreButton(payButton);
        updatePaymentButton(activeApprovedBooking, activeDownPaymentRecord, activePaymentRecords);
    }
}

async function handlePaymentReturnIfNeeded(user) {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("result");
    const paymentId = params.get("paymentId");

    if (!result || !paymentId) {
        return;
    }

    try {
        if (result === "cancelled") {
            showPaymentToast("Your payment was cancelled before completion.");
        }

        if (result === "success") {
            const payload = await callPaymentApi("/api/payments/verify", { paymentId });

            if (payload.status === "paid") {
                showPaymentToast(
                    payload.type === "transient_bed"
                        ? "Your Transient Bed payment has been confirmed successfully."
                        : payload.type === "monthly_rent"
                        ? "Your monthly rent payment has been confirmed successfully."
                        : "Your down payment has been confirmed successfully."
                );
            } else {
                showPaymentToast("Your payment is still being confirmed. Please refresh again in a moment.");
            }
        }

        if (isTransientPaymentMode()) {
            activePaymentRecords = await loadTransientPaymentRecords(user.uid, activeTransientBooking?.id);
            if (activeTransientBooking?.id) {
                const refreshedTransient = await loadApprovedTransientBooking(user.uid, activeTransientBooking.id);
                activeTransientBooking = refreshedTransient || activeTransientBooking;
            }
        } else {
            activePaymentRecords = await loadPaymentRecords(user.uid, activeApprovedBooking);
            activeDownPaymentRecord = getLatestDownPaymentRecord(activePaymentRecords);
            if (activeUserData && activeApprovedBooking) {
                populatePaymentSummary(activeUserData, activeApprovedBooking, activeDownPaymentRecord, activePaymentRecords);
            }
            await refreshMonthlyPaymentState(user.uid, activeApprovedBooking, {
                paymentRecords: activePaymentRecords,
                ensureInvoices: true,
                rerender: true
            });
        }

        if (activeUserData && (activeApprovedBooking || activeTransientBooking)) {
            populatePaymentSummary(activeUserData, activeApprovedBooking, activeDownPaymentRecord, activePaymentRecords);
        }
    } catch (error) {
        console.error("Failed to verify returned payment:", error);
        showPaymentToast(getFriendlyPaymentApiError(error, "We could not confirm the payment return right now. Please refresh this page shortly."));
    } finally {
        const cleanUrl = new URL(window.location.href);
        cleanUrl.searchParams.delete("result");
        cleanUrl.searchParams.delete("paymentId");
        if (isTransientPaymentMode() && activeTransientBooking?.id) {
            cleanUrl.searchParams.set("type", "transient");
            cleanUrl.searchParams.set("transientBookingId", activeTransientBooking.id);
        }
        window.history.replaceState({}, "", cleanUrl.toString());
    }
}

auth.onAuthStateChanged(async (user) => {
    if (!user) {
        window.location.href = "intro.html";
        return;
    }

    try {
        const { userData, approvedBooking, transientBooking, downPaymentRecord, paymentRecords, billingInvoices = [], addonState = { catalog: [], addOns: [], requestedAddons: [], nextAdjustableBillingMonth: "" } } = await guardApprovedTenant(user);
        const returnParams = new URLSearchParams(window.location.search);
        const hasPaymentReturn = returnParams.has("result") && returnParams.has("paymentId");
        activeUserData = userData;
        activeApprovedBooking = approvedBooking;
        activeTransientBooking = transientBooking || null;
        activeDownPaymentRecord = downPaymentRecord;
        activePaymentRecords = paymentRecords;
        activeBillingInvoices = billingInvoices;
        activeAddonState = addonState;
        populatePaymentSummary(userData, approvedBooking, downPaymentRecord, paymentRecords);
        if (!isTransientPaymentMode() && approvedBooking?.id && !hasPaymentReturn) {
            void refreshMonthlyPaymentState(user.uid, approvedBooking, {
                paymentRecords,
                ensureInvoices: true,
                rerender: true
            }).catch((error) => {
                console.error("Background payment refresh failed:", error);
            });
        }
        await handlePaymentReturnIfNeeded(user);
    } catch (error) {
        if (error.message !== "not-approved-tenant" && error.message !== "missing-approved-booking" && error.message !== "missing-approved-transient-bed") {
            console.error("Failed to load payment page:", error);
            showPaymentToast("Unable to load your billing page right now.");
        }
    } finally {
        paymentSubmitting = false;
        updatePaymentButton(activeApprovedBooking, activeDownPaymentRecord, activePaymentRecords);
        window.hidePageLoader?.();
    }
});

document.addEventListener("DOMContentLoaded", () => {
    bindAvatarDropdown();
    bindPaymentMethodSelection();
    bindPaymentActions();
    updateSelectedMethodDisplay();
    updatePaymentButton(activeApprovedBooking, activeDownPaymentRecord, activePaymentRecords);
});

const tenantChatState = {
    unsubscribe: null,
    userData: null,
    messages: []
};

const maintenanceState = {
    unsubscribe: null,
    tickets: []
};

const notificationState = {
    announcements: [],
    latestBooking: null,
    latestTransientBed: null
};

const billingState = {
    approvedBooking: null,
    paymentRecord: null,
    billingInvoices: []
};

const renewalState = {
    pendingRenewal: null,
    submitting: false
};

const occupancyState = {
    totalCapacity: 0,
    occupiedCount: 0,
    occupants: []
};

const dashboardRequestState = {
    monthly: null,
    transient: null
};

const RATING_LABELS = {
    1: "1 - Poor",
    2: "2 - Fair",
    3: "3 - Good",
    4: "4 - Very Good",
    5: "5 - Excellent"
};

let toastTimer = null;
const BILLING_UNLOCK_DURATION_MS = 5 * 60 * 1000;
let pendingBillingDestination = "payment.html";
let billingSecurityBusy = false;
const DOWN_PAYMENT_AMOUNT = 1000;
const BOOKING_STATUS_APPROVED_PENDING_DOWN_PAYMENT = "approved_pending_down_payment";

function normalizeBookingStatus(value) {
    return String(value || "").trim().toLowerCase();
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

function getNotificationStorageKey(userId) {
    return `citihub_notifications_seen_${userId}`;
}

function getRatingDismissStorageKey(userId) {
    return `citihub_rating_dismissed_${userId}`;
}

function getUserMessagesRef(userId) {
    return db.collection("users").doc(userId).collection("messages");
}

function getRatingRef(userId) {
    return db.collection("ratings").doc(userId);
}

function getMaintenanceTicketsRef() {
    return db.collection("maintenanceTickets");
}

function getPaymentsRef() {
    return db.collection("payments");
}

async function callTenantApi(path, payload = {}) {
    const user = firebase.auth().currentUser;
    if (!user) {
        throw new Error("You must be signed in to continue.");
    }

    const baseUrl = window.CITIHUB_API_BASE_URL || "http://localhost:4000";
    const token = await user.getIdToken();
    const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify(payload || {})
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(result.error || "The request failed.");
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
        await callTenantApi("/api/sessions/touch", {
            sessionId: getTenantSessionId(),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || ""
        });
        sessionStorage.setItem("citihub_tenant_session_recorded", "true");
        return true;
    } catch (error) {
        if (error?.message?.toLowerCase().includes("session was signed out")) {
            await firebase.auth().signOut();
            sessionStorage.clear();
            window.location.href = "intro.html";
            return false;
        }

        console.warn("Unable to update tenant session activity:", error);
        return true;
    }
}

function getBillingUnlockStorageKey(userId) {
    return `citihub_billing_unlocked_until_${userId}`;
}

function isBillingAccessUnlocked(user) {
    if (!user?.uid) return false;

    const unlockedUntil = Number(sessionStorage.getItem(getBillingUnlockStorageKey(user.uid)) || 0);
    return Number.isFinite(unlockedUntil) && unlockedUntil > Date.now();
}

function unlockBillingAccess(user) {
    if (!user?.uid) return;

    sessionStorage.setItem(
        getBillingUnlockStorageKey(user.uid),
        String(Date.now() + BILLING_UNLOCK_DURATION_MS)
    );
}

function getBillingAuthProvider(user) {
    const providerIds = (user?.providerData || []).map((provider) => provider.providerId);
    if (providerIds.includes("google.com")) return "google";
    if (providerIds.includes("password")) return "password";
    return providerIds[0] || "";
}

function setBillingSecurityError(message = "") {
    const errorBox = document.getElementById("billingSecurityError");
    if (errorBox) {
        errorBox.textContent = message;
    }
}

function setBillingSecurityBusy(isBusy) {
    billingSecurityBusy = isBusy;
    const passwordSubmit = document.getElementById("billingPasswordSubmit");
    const googleSubmit = document.getElementById("billingGoogleSubmit");
    const passwordInput = document.getElementById("billingSecurityPassword");

    if (passwordSubmit) {
        passwordSubmit.disabled = isBusy;
        passwordSubmit.textContent = isBusy ? "Checking..." : "Unlock Billing";
    }

    if (googleSubmit) {
        googleSubmit.disabled = isBusy;
        googleSubmit.textContent = isBusy ? "Checking..." : "Continue with Google";
    }

    if (passwordInput) {
        passwordInput.disabled = isBusy;
    }
}

function closeBillingSecurityModal() {
    const modal = document.getElementById("billingSecurityModal");
    const passwordInput = document.getElementById("billingSecurityPassword");

    if (modal) {
        modal.classList.remove("open");
        modal.setAttribute("aria-hidden", "true");
    }

    if (passwordInput) {
        passwordInput.value = "";
    }

    setBillingSecurityBusy(false);
    setBillingSecurityError("");
}

function openBillingSecurityModal(destination = "payment.html") {
    const user = firebase.auth().currentUser;
    const modal = document.getElementById("billingSecurityModal");
    const message = document.getElementById("billingSecurityMessage");
    const passwordForm = document.getElementById("billingPasswordForm");
    const passwordInput = document.getElementById("billingSecurityPassword");
    const googleSubmit = document.getElementById("billingGoogleSubmit");

    if (!user || !modal || !message || !passwordForm || !googleSubmit) {
        window.location.href = destination;
        return;
    }

    pendingBillingDestination = destination || "payment.html";
    setBillingSecurityBusy(false);
    setBillingSecurityError("");

    const provider = getBillingAuthProvider(user);
    const isPasswordUser = provider === "password";
    const isGoogleUser = provider === "google";

    passwordForm.style.display = isPasswordUser ? "flex" : "none";
    googleSubmit.style.display = isGoogleUser ? "block" : "none";
    message.textContent = isPasswordUser
        ? "Enter your CitiHub account password before viewing billing and payment details."
        : isGoogleUser
            ? "Continue with Google before viewing billing and payment details."
            : "This account sign-in method cannot be confirmed here. Please sign out and sign in again before opening billing.";

    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");

    if (isPasswordUser && passwordInput) {
        setTimeout(() => passwordInput.focus(), 50);
    }
}

function openSecureBilling(destination = "payment.html") {
    const user = firebase.auth().currentUser;

    if (!user) {
        window.location.href = "intro.html";
        return;
    }

    if (isBillingAccessUnlocked(user)) {
        window.location.href = destination;
        return;
    }

    openBillingSecurityModal(destination);
}

async function reauthenticateBillingWithPassword(event) {
    event?.preventDefault();

    if (billingSecurityBusy) return;

    const user = firebase.auth().currentUser;
    const passwordInput = document.getElementById("billingSecurityPassword");
    const password = passwordInput?.value || "";

    if (!user?.email || !password) {
        setBillingSecurityError("Please enter your account password.");
        return;
    }

    setBillingSecurityBusy(true);
    setBillingSecurityError("");

    try {
        const credential = firebase.auth.EmailAuthProvider.credential(user.email, password);
        await user.reauthenticateWithCredential(credential);
        unlockBillingAccess(user);
        window.location.href = pendingBillingDestination || "payment.html";
    } catch (error) {
        console.error("Billing password confirmation failed:", error);
        setBillingSecurityError("Incorrect password. Please try again.");
        setBillingSecurityBusy(false);
    }
}

async function reauthenticateBillingWithGoogle() {
    if (billingSecurityBusy) return;

    const user = firebase.auth().currentUser;
    if (!user) {
        window.location.href = "intro.html";
        return;
    }

    setBillingSecurityBusy(true);
    setBillingSecurityError("");

    try {
        const provider = new firebase.auth.GoogleAuthProvider();
        await user.reauthenticateWithPopup(provider);
        unlockBillingAccess(user);
        window.location.href = pendingBillingDestination || "payment.html";
    } catch (error) {
        console.error("Billing Google confirmation failed:", error);
        setBillingSecurityError("Google confirmation was not completed. Please try again.");
        setBillingSecurityBusy(false);
    }
}

function getMessageDate(timestamp) {
    if (!timestamp) {
        return null;
    }

    if (typeof timestamp.toDate === "function") {
        return timestamp.toDate();
    }

    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? null : date;
}

function showToast(message) {
    const toast = document.getElementById("toast");
    if (!toast) {
        return;
    }

    toast.textContent = message;
    toast.classList.add("show");

    if (toastTimer) {
        clearTimeout(toastTimer);
    }

    toastTimer = setTimeout(() => {
        toast.classList.remove("show");
        toastTimer = null;
    }, 3000);
}

function updateApprovedOnlyDashboardSections(userStatus) {
    const isApproved = userStatus === "approved";
    const bulletinSection = document.getElementById("bulletinSection");
    const occupantsCard = document.getElementById("occupantsStatCard");
    const complaintCard = document.getElementById("complaintCard");
    const occupantsStat = document.getElementById("totalOccupantsStat");
    const occupantsHint = document.getElementById("totalOccupantsHint");

    if (bulletinSection) {
        bulletinSection.style.display = isApproved ? "" : "none";
    }

    if (occupantsCard) {
        occupantsCard.style.display = isApproved ? "" : "none";
    }

    if (complaintCard) {
        complaintCard.style.display = isApproved ? "" : "none";
    }

    if (!isApproved) {
        if (occupantsStat) {
            occupantsStat.textContent = "--";
        }
        if (occupantsHint) {
            occupantsHint.textContent = "Visible after booking approval";
        }
        closeOccupantsModal();
    }
}

function getTimestampMs(timestamp) {
    const date = getMessageDate(timestamp);
    return date ? date.getTime() : 0;
}

function formatNotificationTime(timestamp) {
    const date = getMessageDate(timestamp);
    if (!date) {
        return "Just now";
    }

    return new Intl.DateTimeFormat("en-PH", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
    }).format(date);
}

function formatCurrency(amount) {
    return new Intl.NumberFormat("en-PH", {
        style: "currency",
        currency: "PHP",
        minimumFractionDigits: 2
    }).format(Number(amount || 0));
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

function buildBillingCalculation(entry, fallbackMonthlyAmount = 0) {
    const invoice = entry?.invoice || {};
    const addonSummary = getInvoiceAddonSummary(invoice);
    const baseAmount = Number(invoice.rentAmount || fallbackMonthlyAmount || entry?.amount || 0);
    const grossAmount = Number(entry?.grossAmount || invoice.grossAmount || baseAmount + addonSummary.addonsAmount);
    const parts = [formatCurrency(baseAmount)];

    addonSummary.addons.forEach((addon) => {
        parts.push(`${formatCurrency(addon.price)} ${addon.addonName || addon.name || "add-on"}`);
    });

    const equation = `${parts.join(" + ")} = ${formatCurrency(grossAmount)}`;
    return entry?.depositCredit
        ? `${equation}; less ${formatCurrency(entry.depositCredit)} deposit credit = ${formatCurrency(entry.amount)}`
        : equation;
}

function formatShortDate(dateLike) {
    const date = getMessageDate(dateLike) || new Date(dateLike);
    if (Number.isNaN(date?.getTime?.())) {
        return "--";
    }

    return new Intl.DateTimeFormat("en-PH", {
        month: "short",
        day: "numeric"
    }).format(date);
}

function formatLongDate(dateLike) {
    const date = getMessageDate(dateLike) || new Date(dateLike);
    if (Number.isNaN(date?.getTime?.())) {
        return "Unavailable";
    }

    return new Intl.DateTimeFormat("en-PH", {
        month: "long",
        day: "numeric",
        year: "numeric"
    }).format(date);
}

function parseLeaseAmount(value) {
    const digits = String(value || "").replace(/[^\d.]/g, "");
    const parsed = Number(digits);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function addDays(date, days) {
    const copy = new Date(date);
    copy.setDate(copy.getDate() + days);
    return copy;
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

function createBillingDueDate(year, monthIndex, dayOfMonth) {
    const lastDay = new Date(year, monthIndex + 1, 0).getDate();
    const safeDay = Math.min(dayOfMonth, lastDay);
    const dueDate = new Date(year, monthIndex, safeDay);
    dueDate.setHours(0, 0, 0, 0);
    return dueDate;
}

function getDueStatus(dueDate, today = new Date()) {
    const dueCopy = new Date(dueDate);
    dueCopy.setHours(0, 0, 0, 0);

    const todayCopy = new Date(today);
    todayCopy.setHours(0, 0, 0, 0);

    const diffInDays = Math.ceil((dueCopy - todayCopy) / (1000 * 60 * 60 * 24));

    if (diffInDays < 0) {
        return { key: "overdue", label: "Overdue", icon: "!" };
    }

    if (diffInDays <= 7) {
        return { key: "pending", label: "Due Soon", icon: "!" };
    }

    return { key: "upcoming", label: "Upcoming", icon: "#" };
}

function getContractEndDate(booking) {
    return parseInvoiceDate(booking?.contractEndDate) || parseInvoiceDate(booking?.contractEndAt);
}

function getDaysUntilDate(date) {
    if (!date) {
        return null;
    }

    const target = new Date(date);
    target.setHours(0, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.ceil((target - today) / (1000 * 60 * 60 * 24));
}

function isRenewalBilling(approvedBooking) {
    return Boolean(approvedBooking?.isRenewal || approvedBooking?.requestType === "renewal");
}

function getBillingRestrictionMessage(approvedBooking) {
    if (!approvedBooking) {
        return "";
    }

    if (approvedBooking.manualBillingHold === true) {
        return "Your account is currently on billing hold. Renewal, transfer requests, and add-on changes are disabled until CitiHub management removes the hold.";
    }

    if (
        approvedBooking.delinquentAccount === true
        || String(approvedBooking.billingStatus || "").toLowerCase() === "delinquent"
    ) {
        return "Your account is now delinquent because of overdue billing. Renewal, transfer requests, and add-on changes are disabled until your balance is settled.";
    }

    return "";
}

function canRequestRenewal(approvedBooking) {
    const daysUntilEnd = getDaysUntilDate(getContractEndDate(approvedBooking));
    return Number.isFinite(daysUntilEnd) && daysUntilEnd <= 30;
}

function getMonthlyBillingSchedule(approvedBooking, paymentRecord, billingInvoices = []) {
    const canUseRenewalInvoices = isRenewalBilling(approvedBooking) && billingInvoices.length > 0;
    if (!approvedBooking || (paymentRecord?.status !== "paid" && !canUseRenewalInvoices)) {
        return null;
    }

    if (billingInvoices.length) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const entries = billingInvoices.map((invoice) => {
            const dueDate = parseInvoiceDate(invoice.dueDate);
            let status = dueDate ? getDueStatus(dueDate, today) : { key: "upcoming", label: "Upcoming", icon: "#" };

            if (invoice.status === "deducted_by_deposit") {
                status = { key: "paid", label: "Deposit Applied", icon: "OK" };
            }
            if (invoice.status === "paid") {
                status = { key: "paid", label: "Paid", icon: "OK" };
            }

            return {
                dueDate,
                amount: Number(invoice.amount || 0),
                grossAmount: Number(invoice.grossAmount || invoice.amount || 0),
                depositCredit: Number(invoice.depositCredit || 0),
                rentAmount: Number(invoice.rentAmount || approvedBooking.monthlyRate || 0),
                addonsAmount: Number(invoice.addonsAmount || 0),
                addons: Array.isArray(invoice.addons) ? invoice.addons : [],
                periodStart: parseInvoiceDate(invoice.periodStart),
                periodEnd: parseInvoiceDate(invoice.periodEnd),
                billingMonth: invoice.billingMonth,
                invoiceType: invoice.invoiceType || "monthly_rent",
                status,
                invoice
            };
        });

        return {
            moveInDate: parseInvoiceDate(billingInvoices[0]?.periodStart),
            monthlyAmount: Number(approvedBooking.monthlyRate || parseLeaseAmount(approvedBooking.leasePrice)),
            nextDue: entries.find((entry) => entry.status.key !== "paid") || entries[entries.length - 1],
            entries,
            source: "billingInvoices"
        };
    }

    const moveInDate = parseMoveInDateValue(approvedBooking.moveInDate);
    if (!moveInDate) {
        return { missingMoveInDate: true };
    }

    const monthlyAmount = parseLeaseAmount(approvedBooking.leasePrice);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const anchorDay = moveInDate.getDate();
    const firstDueDate = createBillingDueDate(moveInDate.getFullYear(), moveInDate.getMonth() + 1, anchorDay);
    const entries = [];
    let offset = -1;

    while (entries.length < 3) {
        const dueDate = createBillingDueDate(today.getFullYear(), today.getMonth() + offset, anchorDay);
        offset += 1;

        if (dueDate < firstDueDate) {
            continue;
        }

        entries.push({
            dueDate,
            amount: monthlyAmount,
            status: getDueStatus(dueDate, today)
        });
    }

    return {
        moveInDate,
        monthlyAmount,
        nextDue: entries.find((entry) => entry.status.key !== "overdue") || entries[entries.length - 1],
        entries
    };
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

async function loadLatestPaymentRecord(userId, approvedBooking) {
    const identifiers = getBookingPaymentIdentifiers(approvedBooking);

    if (!identifiers.length) {
        return null;
    }

    const recordsById = new Map();

    for (const field of ["bookingRequestId", "bookingReferenceId"]) {
        for (const identifier of identifiers) {
            const snapshot = await getPaymentsRef()
                .where("userId", "==", userId)
                .where(field, "==", identifier)
                .where("type", "==", "down_payment")
                .get();

            snapshot.forEach((doc) => {
                recordsById.set(doc.id, {
                    id: doc.id,
                    ...doc.data()
                });
            });
        }
    }

    const records = sortPaymentRecords([...recordsById.values()]);
    return records.find((record) => record.status === "paid") || records[0] || null;
}

async function loadBillingInvoices(userId, approvedBooking) {
    const identifiers = getBookingPaymentIdentifiers(approvedBooking);
    const recordsById = new Map();

    for (const identifier of identifiers) {
        const snapshot = await db.collection("billingInvoices")
            .where("userId", "==", userId)
            .where("bookingRequestId", "==", identifier)
            .get();

        snapshot.forEach((doc) => {
            recordsById.set(doc.id, {
                id: doc.id,
                ...doc.data()
            });
        });
    }

    return [...recordsById.values()].sort((left, right) => {
        const leftDate = parseInvoiceDate(left.periodStart) || parseInvoiceDate(left.dueDate) || new Date(0);
        const rightDate = parseInvoiceDate(right.periodStart) || parseInvoiceDate(right.dueDate) || new Date(0);
        return leftDate - rightDate;
    });
}

async function loadPendingRenewalRequest(userId, approvedBooking) {
    if (!approvedBooking?.id) {
        return null;
    }

    const snapshot = await db.collection("bookingRequest")
        .where("userId", "==", userId)
        .where("renewalOfBookingId", "==", approvedBooking.id)
        .get();

    const renewals = [];
    snapshot.forEach((doc) => {
        const data = doc.data() || {};
        if (["pending", "approved"].includes(String(data.status || "").toLowerCase())) {
            renewals.push({ id: doc.id, ...data });
        }
    });

    return renewals.sort((left, right) => {
        const leftDate = left.createdAt?.toDate?.() || new Date(0);
        const rightDate = right.createdAt?.toDate?.() || new Date(0);
        return rightDate - leftDate;
    })[0] || null;
}

async function verifyPendingBillingPayment(paymentRecord) {
    if (!paymentRecord?.id) {
        return false;
    }

    try {
        const result = await callTenantApi("/api/payments/verify", { paymentId: paymentRecord.id });
        return result.status === "paid";
    } catch (error) {
        console.warn("Unable to auto-verify dashboard payment:", paymentRecord.id, error);
        return false;
    }
}

function renderBillingBanner(approvedBooking, paymentRecord) {
    const banner = document.getElementById("billingBanner");
    const title = document.getElementById("billingBannerTitle");
    const subtitle = document.getElementById("billingBannerSubtitle");
    const icon = document.getElementById("billingBannerIcon");
    const payBtn = document.getElementById("billingBannerPayBtn");

    if (!banner || !title || !subtitle || !icon || !payBtn) {
        return;
    }

    if (!approvedBooking) {
        banner.style.display = "none";
        return;
    }

    banner.style.display = "flex";
    banner.classList.remove("delinquent");
    const monthlySchedule = getMonthlyBillingSchedule(approvedBooking, paymentRecord, billingState.billingInvoices);
    const usesRenewalInvoices = isRenewalBilling(approvedBooking) && billingState.billingInvoices.length > 0;
    const billingRestrictionMessage = getBillingRestrictionMessage(approvedBooking);

    if (billingRestrictionMessage) {
        banner.classList.add("delinquent");
        title.textContent = approvedBooking.manualBillingHold === true ? "Billing Hold" : "Account Delinquent";
        subtitle.textContent = `${billingRestrictionMessage} You can still open Billing and settle your account from here.`;
        icon.textContent = "!";
        payBtn.textContent = "Open Billing";
        return;
    }

    if ((!paymentRecord || paymentRecord.status !== "paid") && !usesRenewalInvoices) {
        title.textContent = "Down Payment Required";
        subtitle.textContent = `Your approved booking requires a ${formatCurrency(DOWN_PAYMENT_AMOUNT)} down payment before monthly billing can begin.`;
        icon.textContent = "!";
        payBtn.textContent = "Pay Now";
        return;
    }

    if (monthlySchedule?.missingMoveInDate) {
        title.textContent = "Move-in Date Needed";
        subtitle.textContent = "Your down payment is already recorded, but your monthly billing schedule still needs an approved move-in date.";
        icon.textContent = "!";
        payBtn.textContent = "Open Billing";
        return;
    }

    if (monthlySchedule?.nextDue) {
        const nextDue = monthlySchedule.nextDue;
        const addonSummary = getInvoiceAddonSummary(nextDue.invoice);
        const addonText = addonSummary.addonsAmount
            ? ` Includes ${addonSummary.labels.join(", ")} worth ${formatCurrency(addonSummary.addonsAmount)}.`
            : "";

        title.textContent = nextDue.status.key === "overdue" ? "Billing Overdue" : "Billing Reminder";
        subtitle.textContent = `Your current bill is ${formatCurrency(nextDue.amount)} (${buildBillingCalculation(nextDue, monthlySchedule.monthlyAmount)}) and is ${nextDue.status.key === "overdue" ? "already overdue" : `due on ${formatLongDate(nextDue.dueDate)}`}.${addonText}`;
        icon.textContent = nextDue.status.key === "overdue" ? "!" : "#";
        payBtn.textContent = "Open Billing";
        return;
    }

    banner.style.display = "none";
}

function renderBillingActivity(approvedBooking, paymentRecord) {
    const list = document.getElementById("billingActivityList");
    const nextPaymentStat = document.getElementById("nextPaymentStat");

    if (!list || !nextPaymentStat) {
        return;
    }

    if (!approvedBooking) {
        list.innerHTML = `
            <div class="billing-item">
                <div class="bi-left">
                    <span class="bi-status-icon">&#9432;</span>
                    <div>
                        <div class="bi-title">No approved billing yet</div>
                        <div class="bi-sub">Your billing activity will appear here after your booking is approved.</div>
                    </div>
                </div>
                <div class="bi-amount">--</div>
            </div>
        `;
        nextPaymentStat.textContent = "--";
        return;
    }

    const items = [];
    const usesRenewalInvoices = isRenewalBilling(approvedBooking) && billingState.billingInvoices.length > 0;

    if ((!paymentRecord || paymentRecord.status !== "paid") && !usesRenewalInvoices) {
        items.push({
            className: "pending",
            icon: "!",
            title: "Required Down Payment - Pending",
            sub: `Settle ${formatCurrency(DOWN_PAYMENT_AMOUNT)} to activate your monthly billing schedule.`,
            amount: formatCurrency(DOWN_PAYMENT_AMOUNT)
        });
        nextPaymentStat.textContent = "Down Payment";
    } else {
        if (usesRenewalInvoices && (!paymentRecord || paymentRecord.status !== "paid")) {
            items.push({
                className: "",
                icon: "&#10004;",
                title: "Renewal Billing Activated",
                sub: "Your renewed contract uses your existing tenant profile and continues to monthly billing.",
                amount: "No new deposit"
            });
        } else {
            items.push({
                className: "",
                icon: "&#10004;",
                title: "Required Down Payment - Paid",
                sub: `Paid ${formatLongDate(paymentRecord.paidAt || paymentRecord.updatedAt || paymentRecord.createdAt)}`,
                amount: formatCurrency(paymentRecord.amount || DOWN_PAYMENT_AMOUNT)
            });
        }

        const schedule = getMonthlyBillingSchedule(approvedBooking, paymentRecord, billingState.billingInvoices);
        if (schedule?.missingMoveInDate) {
            items.push({
                className: "pending",
                icon: "!",
                title: "Move-in date still needed",
                sub: "Monthly due dates will appear once your approved move-in date is confirmed.",
                amount: "--"
            });
            nextPaymentStat.textContent = "Pending";
        } else if (schedule?.entries?.length) {
            schedule.entries.forEach((entry, index) => {
                const addonSummary = getInvoiceAddonSummary(entry.invoice);
                const addonText = addonSummary.addonsAmount
                    ? ` Includes ${addonSummary.labels.join(", ")} worth ${formatCurrency(addonSummary.addonsAmount)}.`
                    : "";
                items.push({
                    className: entry.status.key === "pending" ? "pending" : "",
                    icon: entry.status.key === "overdue" ? "!" : entry.status.key === "pending" ? "!" : "#",
                    title: `${entry.invoiceType === "first_prorated_rent" ? "First Prorated Rent" : entry.invoiceType === "final_rent" ? "Final Month Rent" : index === 0 ? "Current Monthly Rent" : "Upcoming Monthly Rent"} - ${entry.status.label}`,
                    sub: `Due ${formatLongDate(entry.dueDate)}. ${buildBillingCalculation(entry, schedule.monthlyAmount)}.${entry.depositCredit ? " Deposit credit applied." : ""}${addonText}`,
                    amount: formatCurrency(entry.amount)
                });
            });
            nextPaymentStat.textContent = formatShortDate(schedule.nextDue?.dueDate);
        } else {
            nextPaymentStat.textContent = "--";
        }
    }

    list.innerHTML = items.map((item) => `
        <div class="billing-item ${item.className}">
            <div class="bi-left">
                <span class="bi-status-icon">${item.icon}</span>
                <div>
                    <div class="bi-title">${escapeHtml(item.title)}</div>
                    <div class="bi-sub">${escapeHtml(item.sub)}</div>
                </div>
            </div>
            <div class="bi-amount">${escapeHtml(item.amount)}</div>
        </div>
    `).join("");
}

function renderRenewalSection(approvedBooking, pendingRenewal) {
    const section = document.getElementById("renewalSection");
    const title = document.getElementById("renewalTitle");
    const sub = document.getElementById("renewalSub");
    const button = document.getElementById("renewalSubmitBtn");
    const select = document.getElementById("renewalTermSelect");

    if (!section || !title || !sub || !button || !select) {
        return;
    }

    if (!approvedBooking || isRenewalBilling(approvedBooking) || !canRequestRenewal(approvedBooking)) {
        section.style.display = "none";
        return;
    }

    section.style.display = "flex";
    const contractEnd = getContractEndDate(approvedBooking);
    const endLabel = contractEnd ? formatLongDate(contractEnd) : "your contract end date";

    if (pendingRenewal) {
        title.textContent = pendingRenewal.status === "approved" ? "Renewal approved" : "Renewal under review";
        sub.textContent = pendingRenewal.status === "approved"
            ? "Your renewal has been approved. Billing will continue from your renewed contract."
            : `Your renewal request ${pendingRenewal.referenceId || pendingRenewal.id} is waiting for admin review.`;
        button.textContent = pendingRenewal.status === "approved" ? "Renewed" : "Pending";
        button.disabled = true;
        select.disabled = true;
        return;
    }

    title.textContent = "Renew your stay";
    sub.textContent = `Your current contract ends on ${endLabel}. Choose a new term and send it for admin review.`;
    button.textContent = renewalState.submitting ? "Sending..." : "Request Renewal";
    button.disabled = renewalState.submitting;
    select.disabled = renewalState.submitting;
}

async function submitRenewalRequest() {
    const approvedBooking = billingState.approvedBooking;
    const select = document.getElementById("renewalTermSelect");

    if (!approvedBooking?.id || renewalState.submitting) {
        return;
    }

    renewalState.submitting = true;
    renderRenewalSection(approvedBooking, renewalState.pendingRenewal);

    try {
        const result = await callTenantApi("/api/bookings/renewal/create", {
            bookingRequestId: approvedBooking.id,
            contractTerm: select?.value || approvedBooking.contractTerm || "1_year"
        });
        renewalState.pendingRenewal = {
            id: result.id,
            referenceId: result.referenceId,
            status: result.status || "pending"
        };
        showToast("Your renewal request was sent for admin review.");
    } catch (error) {
        console.error("Renewal request failed:", error);
        showToast(error.message || "Unable to send your renewal request right now.");
    } finally {
        renewalState.submitting = false;
        renderRenewalSection(approvedBooking, renewalState.pendingRenewal);
    }
}

function bindRenewalActions() {
    document.getElementById("renewalSubmitBtn")?.addEventListener("click", submitRenewalRequest);
}

async function loadTenantBillingSummary(userId) {
    const approvedBooking = await loadLatestApprovedBooking(userId);
    let paymentRecord = approvedBooking
        ? await loadLatestPaymentRecord(userId, approvedBooking)
        : null;

    if (approvedBooking && await verifyPendingBillingPayment(paymentRecord)) {
        paymentRecord = await loadLatestPaymentRecord(userId, approvedBooking);
    }

    const billingInvoices = (paymentRecord?.status === "paid" || isRenewalBilling(approvedBooking)) && approvedBooking
        ? await loadBillingInvoices(userId, approvedBooking)
        : [];
    const pendingRenewal = approvedBooking
        ? await loadPendingRenewalRequest(userId, approvedBooking)
        : null;

    billingState.approvedBooking = approvedBooking;
    billingState.paymentRecord = paymentRecord;
    billingState.billingInvoices = billingInvoices;
    renewalState.pendingRenewal = pendingRenewal;

    renderBillingBanner(approvedBooking, paymentRecord);
    renderBillingActivity(approvedBooking, paymentRecord);
    renderRenewalSection(approvedBooking, pendingRenewal);
}

function getSeenNotificationTimestamp(userId) {
    if (!userId) {
        return 0;
    }

    return Number(localStorage.getItem(getNotificationStorageKey(userId)) || 0);
}

function buildTenantNotifications() {
    const notifications = [];

    notificationState.announcements.slice(0, 5).forEach((announcement) => {
        notifications.push({
            id: `announcement-${announcement.id || announcement.title || ""}`,
            type: "announcement",
            title: `Announcement: ${announcement.title || "CitiHub Update"}`,
            body: announcement.body || "A new dormitory update is available.",
            timestamp: announcement.date || announcement.createdAt || null
        });
    });

    if (notificationState.latestBooking) {
        const booking = notificationState.latestBooking;
        let title = "Booking update";
        let body = "Your booking request has been updated.";

        if (booking.status === "pending") {
            title = "Booking under review";
            body = "Your booking request is still being reviewed by CitiHub management.";
        } else if (booking.status === BOOKING_STATUS_APPROVED_PENDING_DOWN_PAYMENT) {
            title = "Booking approved - down payment needed";
            body = `Your booking for Room ${booking.room}, Bed ${booking.bed} is reserved. Complete the down payment to activate your stay.`;
        } else if (booking.status === "approved") {
            title = "Booking approved";
            body = `Your booking for Room ${booking.room}, Bed ${booking.bed} has been approved.`;
        } else if (booking.status === "cancelled") {
            title = "Booking cancelled";
            if (booking.cancelledBy === "admin") {
                body = booking.cancellationReason
                    ? `CitiHub management cancelled this booking request. Reason: ${booking.cancellationReason}`
                    : "CitiHub management cancelled this booking request.";
            } else {
                body = booking.cancellationReason
                    ? `You cancelled this booking request. Reason: ${booking.cancellationReason}`
                    : "You cancelled this booking request.";
            }
        } else if (booking.status === "rejected") {
            title = "Booking request rejected";
            body = booking.rejectionReason
                ? `Reason: ${booking.rejectionReason}`
                : "Your booking request was not approved. You may submit a new request.";
        }

        notifications.push({
            id: `booking-${booking.id || booking.referenceId || ""}`,
            type: "booking",
            title,
            body,
            timestamp: booking.createdAt || null
        });
    }

    if (notificationState.latestTransientBed) {
        const transient = notificationState.latestTransientBed;
        let title = "Transient Bed update";
        let body = "Your Transient Bed request has been updated.";

        if (transient.status === "pending_payment") {
            title = "Transient Bed payment needed";
            body = "Continue payment to submit your Transient Bed request for admin review.";
        } else if (transient.status === "pending") {
            title = "Transient Bed pending review";
            body = "Your Transient Bed request is waiting for admin approval.";
        } else if (transient.status === "approved") {
            title = transient.paymentStatus === "paid" ? "Transient Bed approved" : "Transient Bed approved - payment needed";
            body = transient.paymentStatus === "paid"
                ? `Your Transient Bed for Room ${transient.room}, Bed ${transient.bed} has been approved.`
                : "Your Transient Bed request has been approved. Pay your bill from the Transient Bed page.";
        } else if (transient.status === "checked_in") {
            title = "Transient Bed checked in";
            body = `You are checked in for Room ${transient.room}, Bed ${transient.bed}.`;
        } else if (transient.status === "checked_out") {
            title = "Transient Bed checked out";
            body = "Your Transient Bed stay has been marked as checked out.";
        } else if (transient.status === "rejected") {
            title = "Transient Bed rejected";
            body = transient.reason ? `Reason: ${transient.reason}` : "Your Transient Bed request was rejected.";
        } else if (transient.status === "cancelled") {
            title = "Transient Bed cancelled";
            body = transient.reason ? `Reason: ${transient.reason}` : "Your Transient Bed booking was cancelled.";
        }

        notifications.push({
            id: `transient-${transient.id || transient.referenceId || ""}`,
            type: "booking",
            title,
            body,
            timestamp: transient.updatedAt || transient.createdAt || null
        });
    }

    tenantChatState.messages
        .filter((message) => message.senderType === "admin")
        .slice(-5)
        .forEach((message, index) => {
            notifications.push({
                id: `message-${message.id || index}`,
                type: "message",
                title: "Admin replied to your message",
                body: message.text || "You received a new reply from CitiHub admin.",
                timestamp: message.createdAt || null
            });
        });

    maintenanceState.tickets
        .filter((ticket) => ticket.status !== "open" || ticket.adminNote)
        .slice(0, 6)
        .forEach((ticket) => {
            const statusLabel = formatMaintenanceLabel(ticket.status || "open");
            notifications.push({
                id: `maintenance-${ticket.id}`,
                type: "maintenance",
                title: `Maintenance ticket ${statusLabel.toLowerCase()}`,
                body: ticket.adminNote || `${ticket.subject || "Your ticket"} is now marked as ${statusLabel}.`,
                timestamp: ticket.updatedAt || ticket.createdAt || null
            });
        });

    return notifications
        .sort((left, right) => getTimestampMs(right.timestamp) - getTimestampMs(left.timestamp))
        .slice(0, 12);
}

function updateTenantNotificationCenter() {
    const list = document.getElementById("tenantNotifList");
    const badge = document.getElementById("tenantNotifBadge");
    const sub = document.getElementById("tenantNotifSub");
    const userId = window.currentUserId;

    if (!list || !badge) {
        return;
    }

    const notifications = buildTenantNotifications();
    const seenAt = getSeenNotificationTimestamp(userId);
    const unreadCount = notifications.filter((item) => getTimestampMs(item.timestamp) > seenAt).length;

    list.innerHTML = "";

    if (!notifications.length) {
        list.innerHTML = `<div class="tenant-notif-empty">No notifications yet.</div>`;
    } else {
        notifications.forEach((item) => {
            const row = document.createElement("div");
            row.className = "tenant-notif-item";
            row.innerHTML = `
                <div class="tenant-notif-icon ${item.type}">${item.type === "announcement" ? "!" : item.type === "booking" ? "#" : item.type === "message" ? "..." : "*"}</div>
                <div class="tenant-notif-content">
                    <div class="tenant-notif-item-title">${escapeHtml(item.title)}</div>
                    <div class="tenant-notif-item-body">${escapeHtmlWithBreaks(item.body)}</div>
                    <div class="tenant-notif-item-time">${formatNotificationTime(item.timestamp)}</div>
                </div>
            `;
            list.appendChild(row);
        });
    }

    if (sub) {
        sub.textContent = unreadCount > 0
            ? `${unreadCount} unread update${unreadCount === 1 ? "" : "s"}`
            : "You are all caught up";
    }

    if (unreadCount > 0) {
        badge.style.display = "flex";
        badge.textContent = unreadCount > 9 ? "9+" : String(unreadCount);
    } else {
        badge.style.display = "none";
        badge.textContent = "";
    }
}

function markTenantNotificationsRead() {
    const userId = window.currentUserId;
    if (!userId) {
        return;
    }

    const notifications = buildTenantNotifications();
    const latestTimestamp = notifications.reduce((max, item) => Math.max(max, getTimestampMs(item.timestamp)), 0);

    if (latestTimestamp > 0) {
        localStorage.setItem(getNotificationStorageKey(userId), String(latestTimestamp));
    }

    updateTenantNotificationCenter();
}

async function loadOccupancyStats() {
    const statEl = document.getElementById("totalOccupantsStat");
    const hintEl = document.getElementById("totalOccupantsHint");
    if (!statEl) {
        return;
    }

    if (tenantChatState.userData?.status !== "approved") {
        occupancyState.totalCapacity = 0;
        occupancyState.occupiedCount = 0;
        occupancyState.occupants = [];
        statEl.textContent = "--";
        if (hintEl) {
            hintEl.textContent = "Visible after booking approval";
        }
        return;
    }

    try {
        const snapshot = await db.collection("ROOMS").get();
        const totalCapacity = snapshot.size;
        let occupiedCount = 0;
        const occupants = [];

        snapshot.forEach((doc) => {
            const data = doc.data() || {};
            const availability = String(data.avail || "").toLowerCase();
            if (availability === "occupied") {
                occupiedCount += 1;
                const [fallbackRoom, fallbackBed] = String(doc.id || "").split("_");
                occupants.push({
                    room: data.room || fallbackRoom || "",
                    bed: data.bed || fallbackBed || "",
                    occupant: data.occupant || "Current Tenant",
                    type: data.type || "Room"
                });
            }
        });

        occupants.sort((left, right) => {
            const roomCompare = String(left.room || "").localeCompare(String(right.room || ""), undefined, { numeric: true });
            if (roomCompare !== 0) {
                return roomCompare;
            }

            return String(left.bed || "").localeCompare(String(right.bed || ""), undefined, { numeric: true });
        });

        occupancyState.totalCapacity = totalCapacity;
        occupancyState.occupiedCount = occupiedCount;
        occupancyState.occupants = occupants;
        statEl.textContent = `${occupiedCount}/${totalCapacity}`;
        if (hintEl) {
            hintEl.textContent = occupiedCount ? "Tap to view current tenants" : "No occupants recorded yet";
        }
    } catch (error) {
        console.error("Failed to load occupancy stats:", error);
        statEl.textContent = "Unavailable";
        if (hintEl) {
            hintEl.textContent = "Occupant list is unavailable right now";
        }
    }
}

function renderOccupantsModal() {
    const list = document.getElementById("occupantsModalList");
    const sub = document.getElementById("occupantsModalSub");
    if (!list || !sub) {
        return;
    }

    sub.textContent = `${occupancyState.occupiedCount} approved tenant${occupancyState.occupiedCount === 1 ? "" : "s"} currently occupying bedspaces in CitiHub Dormitory.`;

    if (!occupancyState.occupants.length) {
        list.innerHTML = `<div class="occupants-empty">There are no recorded occupants right now.</div>`;
        return;
    }

    list.innerHTML = occupancyState.occupants.map((entry) => `
        <div class="occupants-item">
            <div class="occupants-item-left">
                <div class="occupants-avatar">${escapeHtml(getInitials(entry.occupant))}</div>
                <div>
                    <div class="occupants-name">${escapeHtml(entry.occupant)}</div>
                    <div class="occupants-meta">Current approved tenant occupying this bedspace</div>
                </div>
            </div>
            <div class="occupants-room">
                <div class="occupants-room-label">Room ${escapeHtml(entry.room)}${entry.bed ? ` - Bed ${escapeHtml(entry.bed)}` : ""}</div>
                <div class="occupants-room-type">${escapeHtml(entry.type)}</div>
            </div>
        </div>
    `).join("");
}

function openOccupantsModal() {
    const overlay = document.getElementById("occupantsModal");
    if (!overlay) {
        return;
    }

    renderOccupantsModal();
    overlay.classList.add("open");
    document.body.style.overflow = "hidden";
}

function closeOccupantsModal() {
    const overlay = document.getElementById("occupantsModal");
    if (!overlay) {
        return;
    }

    overlay.classList.remove("open");
    document.body.style.overflow = "";
}

function bindOccupantsCard() {
    const card = document.getElementById("occupantsStatCard");
    const overlay = document.getElementById("occupantsModal");
    const closeBtn = document.getElementById("occupantsModalClose");

    if (!card || !overlay || !closeBtn) {
        return;
    }

    const tryOpen = () => {
        const userData = tenantChatState.userData || {};
        if (userData.status !== "approved") {
            showToast("Only tenants with an approved booking can view the current occupants.");
            return;
        }

        openOccupantsModal();
    };

    card.addEventListener("click", tryOpen);
    card.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            tryOpen();
        }
    });

    closeBtn.addEventListener("click", closeOccupantsModal);
    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) {
            closeOccupantsModal();
        }
    });
}

function formatMessageTime(timestamp) {
    const date = getMessageDate(timestamp);

    if (!date) {
        return "";
    }

    return new Intl.DateTimeFormat("en-PH", {
        hour: "numeric",
        minute: "2-digit"
    }).format(date);
}

function getMaintenanceSortTime(ticket) {
    return getMessageDate(ticket.updatedAt || ticket.createdAt);
}

function formatMaintenanceDate(timestamp) {
    const date = getMessageDate(timestamp);
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

function formatMaintenanceLabel(value) {
    return String(value || "")
        .split(/[_\s-]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
}

function renderTenantMaintenanceTickets(tickets) {
    const list = document.getElementById("maintenanceList");
    if (!list) {
        return;
    }

    list.innerHTML = "";

    if (!tickets.length) {
        list.innerHTML = `<div class="maintenance-empty">No maintenance tickets yet. Your submitted concerns will appear here.</div>`;
        return;
    }

    tickets.forEach((ticket) => {
        const item = document.createElement("div");
        item.className = "maintenance-ticket";

        const statusClass = String(ticket.status || "open").toLowerCase().replace(/\s+/g, "-");
        const priorityClass = String(ticket.priority || "medium").toLowerCase();
        const categoryLabel = formatMaintenanceLabel(ticket.category || "other concern");
        const statusLabel = formatMaintenanceLabel(ticket.status || "open");
        const priorityLabel = formatMaintenanceLabel(ticket.priority || "medium");

        item.innerHTML = `
            <div class="maintenance-ticket-top">
                <div>
                    <div class="maintenance-ticket-subject">${escapeHtml(ticket.subject || "Untitled Ticket")}</div>
                    <div class="maintenance-ticket-meta">${escapeHtml(categoryLabel)} | ${escapeHtml(ticket.room || "No room assigned")}</div>
                </div>
                <div class="maintenance-ticket-badges">
                    <span class="maintenance-badge ${statusClass}">${escapeHtml(statusLabel)}</span>
                    <span class="maintenance-priority ${priorityClass}">${escapeHtml(priorityLabel)}</span>
                </div>
            </div>
            <div class="maintenance-ticket-desc">${escapeHtmlWithBreaks(ticket.description || "No details provided.")}</div>
            ${ticket.adminNote ? `<div class="maintenance-ticket-note"><strong>Admin update</strong>${escapeHtmlWithBreaks(ticket.adminNote)}</div>` : ""}
            <div class="maintenance-ticket-time">Updated ${formatMaintenanceDate(ticket.updatedAt || ticket.createdAt)}</div>
        `;

        list.appendChild(item);
    });
}

function subscribeToTenantMaintenanceTickets(userId) {
    if (maintenanceState.unsubscribe) {
        maintenanceState.unsubscribe();
        maintenanceState.unsubscribe = null;
    }

    maintenanceState.unsubscribe = getMaintenanceTicketsRef()
        .where("userId", "==", userId)
        .onSnapshot((snapshot) => {
            const tickets = [];

            snapshot.forEach((doc) => {
                tickets.push({
                    id: doc.id,
                    ...doc.data()
                });
            });

            tickets.sort((left, right) => {
                const leftDate = getMaintenanceSortTime(left);
                const rightDate = getMaintenanceSortTime(right);

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

            maintenanceState.tickets = tickets;
            renderTenantMaintenanceTickets(tickets);
            updateTenantNotificationCenter();
        }, (error) => {
            console.error("Failed to load maintenance tickets:", error);
        });
}

async function submitMaintenanceTicket() {
    const userId = window.currentUserId;
    const userData = tenantChatState.userData || {};
    const submitBtn = document.getElementById("maintenanceSubmitBtn");
    const note = document.getElementById("maintenanceSectionNote");

    if (!userId || !submitBtn) {
        return;
    }

    const category = document.getElementById("maintenanceCategory")?.value || "other";
    const priority = document.getElementById("maintenancePriority")?.value || "medium";
    const subject = document.getElementById("maintenanceSubject")?.value.trim() || "";
    const description = document.getElementById("maintenanceDescription")?.value.trim() || "";

    if (!subject || !description) {
        showToast("Please complete the subject and description before submitting.");
        return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting...";

    try {
        await getMaintenanceTicketsRef().add({
            userId,
            tenantName: userData.fullName || userData.username || "Tenant",
            tenantEmail: userData.email || auth.currentUser?.email || "",
            room: userData.room || "",
            category,
            priority,
            subject,
            description,
            status: "open",
            adminNote: "",
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        document.getElementById("maintenanceSubject").value = "";
        document.getElementById("maintenanceDescription").value = "";
        document.getElementById("maintenanceCategory").value = "plumbing";
        document.getElementById("maintenancePriority").value = "medium";

        if (note) {
            note.textContent = "Your concern has been submitted. The admin team will update the ticket status here.";
        }

        showToast("Your maintenance ticket has been submitted.");
    } catch (error) {
        console.error("Failed to submit maintenance ticket:", error);
        showToast("Unable to submit your maintenance ticket right now. Please try again.");
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "Submit Ticket";
    }
}

function scrollTenantChatToBottom() {
    const messagesEl = document.getElementById("tenantChatMessages");
    if (!messagesEl) {
        return;
    }

    messagesEl.scrollTop = messagesEl.scrollHeight;
}

function closeAllTenantMessageMenus() {
    document.querySelectorAll(".chatbot-message-menu.open").forEach((menu) => {
        menu.classList.remove("open");
    });
}

function createTenantChatMessage(text, senderType, timestamp) {
    const row = document.createElement("div");
    row.className = `chatbot-message-row ${senderType === "admin" ? "bot" : "user"}`;

    const bubble = document.createElement("div");
    bubble.className = `chatbot-message ${senderType === "admin" ? "bot" : "user"}`;
    bubble.textContent = text;

    const meta = document.createElement("div");
    meta.className = `chatbot-message-meta ${senderType === "admin" ? "bot" : "user"}`;
    meta.textContent = formatMessageTime(timestamp);

    row.appendChild(bubble);
    row.appendChild(meta);

    return { row, bubble, meta };
}

async function syncTenantChatSummary(userId) {
    const snapshot = await getUserMessagesRef(userId)
        .orderBy("createdAt", "desc")
        .limit(1)
        .get();

    const userRef = db.collection("users").doc(userId);

    if (snapshot.empty) {
        await userRef.set({
            chatLastMessage: "",
            chatLastSender: "",
            chatLastAt: null,
            chatUnreadForAdmin: 0
        }, { merge: true });
        return;
    }

    const latestMessage = snapshot.docs[0].data();
    await userRef.set({
        chatLastMessage: latestMessage.text || "",
        chatLastSender: latestMessage.senderType || "",
        chatLastAt: latestMessage.createdAt || firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
}

async function deleteTenantMessage(messageId) {
    const userId = window.currentUserId;
    if (!userId || !messageId) {
        return;
    }

    try {
        await getUserMessagesRef(userId).doc(messageId).delete();
        await syncTenantChatSummary(userId);
    } catch (error) {
        console.error("Failed to delete tenant message:", error);
        showToast("Unable to remove your message right now. Please try again.");
    }
}

function renderTenantMessages(messages) {
    const messagesEl = document.getElementById("tenantChatMessages");
    if (!messagesEl) {
        return;
    }

    messagesEl.innerHTML = "";

    if (!messages.length) {
        const emptyState = createTenantChatMessage(
            "Welcome to CitiHub support. You can send a message to the admin here.",
            "admin"
        );
        messagesEl.appendChild(emptyState.row);
        return;
    }

    messages.forEach((message) => {
        const senderType = message.senderType === "admin" ? "admin" : "tenant";
        const messageNode = createTenantChatMessage(message.text || "", senderType, message.createdAt);

        if (senderType === "tenant") {
            const actionRow = document.createElement("div");
            actionRow.className = "chatbot-message-actions";

            const menu = document.createElement("div");
            menu.className = "chatbot-message-menu";

            const menuToggle = document.createElement("button");
            menuToggle.type = "button";
            menuToggle.className = "chatbot-message-menu-toggle";
            menuToggle.setAttribute("aria-label", "Message options");
            menuToggle.textContent = "...";
            menuToggle.addEventListener("click", (event) => {
                event.stopPropagation();
                const willOpen = !menu.classList.contains("open");
                closeAllTenantMessageMenus();
                if (willOpen) {
                    menu.classList.add("open");
                }
            });

            const menuPanel = document.createElement("div");
            menuPanel.className = "chatbot-message-menu-panel";

            const removeBtn = document.createElement("button");
            removeBtn.type = "button";
            removeBtn.className = "chatbot-message-menu-item danger";
            removeBtn.textContent = "Remove";
            removeBtn.addEventListener("click", async () => {
                closeAllTenantMessageMenus();
                await deleteTenantMessage(message.id);
            });

            menuPanel.appendChild(removeBtn);
            menu.appendChild(menuToggle);
            menu.appendChild(menuPanel);
            actionRow.appendChild(menu);
            messageNode.row.appendChild(actionRow);
        }

        messagesEl.appendChild(messageNode.row);
    });

    scrollTenantChatToBottom();
}

function bindTenantChatBubble() {
    const toggle = document.getElementById("tenantChatToggle");
    const panel = document.getElementById("tenantChatPanel");
    const close = document.getElementById("tenantChatClose");

    if (!toggle || !panel || !close) {
        return;
    }

    toggle.addEventListener("click", () => {
        panel.classList.toggle("open");
        if (panel.classList.contains("open")) {
            scrollTenantChatToBottom();
        }
    });

    close.addEventListener("click", () => {
        panel.classList.remove("open");
    });
}

function bindMaintenanceBubble() {
    const widget = document.getElementById("tenantMaintenanceWidget");
    const toggle = document.getElementById("maintenanceToggle");
    const panel = document.getElementById("maintenanceSection");
    const close = document.getElementById("maintenanceClose");

    if (!widget || !toggle || !panel || !close) {
        return;
    }

    toggle.addEventListener("click", () => {
        panel.classList.toggle("open");
    });

    close.addEventListener("click", () => {
        panel.classList.remove("open");
    });
}

function bindTenantNotificationPanel() {
    const wrap = document.querySelector(".tenant-notif-wrap");
    const button = document.getElementById("tenantNotifBtn");
    const panel = document.getElementById("tenantNotifPanel");

    if (!wrap || !button || !panel) {
        return;
    }

    button.addEventListener("click", (event) => {
        event.stopPropagation();
        wrap.classList.toggle("open");

        if (wrap.classList.contains("open")) {
            markTenantNotificationsRead();
        }
    });

    panel.addEventListener("click", (event) => {
        event.stopPropagation();
    });

    document.addEventListener("click", () => {
        wrap.classList.remove("open");
    });
}

async function sendTenantChatMessage() {
    const userId = window.currentUserId;
    const input = document.getElementById("tenantChatInput");
    const sendBtn = document.getElementById("tenantChatSendBtn");

    if (!userId || !input || !sendBtn) {
        return;
    }

    const text = input.value.trim();
    if (!text) {
        return;
    }

    sendBtn.disabled = true;

    try {
        const userData = tenantChatState.userData || {};
        const senderName = userData.fullName || userData.username || auth.currentUser?.email || "Tenant";
        const userRef = db.collection("users").doc(userId);

        await getUserMessagesRef(userId).add({
            text,
            senderType: "tenant",
            senderName,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        await userRef.set({
            chatLastMessage: text,
            chatLastSender: "tenant",
            chatLastAt: firebase.firestore.FieldValue.serverTimestamp(),
            chatUnreadForAdmin: firebase.firestore.FieldValue.increment(1),
            chatUnreadForTenant: 0
        }, { merge: true });

        input.value = "";
    } catch (error) {
        console.error("Failed to send tenant message:", error);
        showToast("Unable to send your message right now. Please try again.");
    } finally {
        sendBtn.disabled = false;
        input.focus();
    }
}

function bindTenantChatInput() {
    const form = document.getElementById("tenantChatForm");
    const input = document.getElementById("tenantChatInput");

    if (!form || !input) {
        return;
    }

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        await sendTenantChatMessage();
    });
}

async function markTenantMessagesRead(userId) {
    if (!userId) {
        return;
    }

    try {
        await db.collection("users").doc(userId).set({
            chatUnreadForTenant: 0
        }, { merge: true });
    } catch (error) {
        console.error("Failed to update tenant read state:", error);
    }
}

function subscribeToTenantMessages(userId) {
    if (tenantChatState.unsubscribe) {
        tenantChatState.unsubscribe();
        tenantChatState.unsubscribe = null;
    }

    tenantChatState.unsubscribe = getUserMessagesRef(userId)
        .orderBy("createdAt", "asc")
        .onSnapshot((snapshot) => {
            const messages = [];

            snapshot.forEach((doc) => {
                messages.push({
                    id: doc.id,
                    ...doc.data()
                });
            });

            tenantChatState.messages = messages;
            renderTenantMessages(messages);
            markTenantMessagesRead(userId);
            updateTenantNotificationCenter();
        }, (error) => {
            console.error("Failed to load tenant messages:", error);
        });
}

async function logoutTenant() {
    try {
        if (tenantChatState.unsubscribe) {
            tenantChatState.unsubscribe();
            tenantChatState.unsubscribe = null;
        }

        if (maintenanceState.unsubscribe) {
            maintenanceState.unsubscribe();
            maintenanceState.unsubscribe = null;
        }

        await firebase.auth().signOut();
        window.currentUserId = null;
        sessionStorage.clear();
        localStorage.clear();
        window.location.href = "intro.html";
    } catch (error) {
        console.error("Logout failed:", error);
        showToast("Unable to log out right now. Please try again.");
    }
}

function formatRatingUpdated(timestamp) {
    const date = getMessageDate(timestamp);
    if (!date) {
        return "Share your feedback with CitiHub management.";
    }

    return `Last updated ${new Intl.DateTimeFormat("en-PH", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit"
    }).format(date)}`;
}

function hideRatingSection() {
    const ratingSection = document.getElementById("ratingSection");
    if (ratingSection) {
        ratingSection.style.display = "none";
    }
}

function dismissRatingSection() {
    const userId = window.currentUserId;
    if (userId) {
        localStorage.setItem(getRatingDismissStorageKey(userId), "true");
    }

    hideRatingSection();
}

function setRatingStars(groupId, value) {
    const numericValue = Number(value) || 0;
    const input = document.getElementById(groupId);
    const label = document.getElementById(`${groupId}Label`);
    const group = document.querySelector(`.rating-stars[data-group="${groupId}"]`);

    if (input) {
        input.value = numericValue ? String(numericValue) : "";
    }

    if (label) {
        label.textContent = numericValue ? RATING_LABELS[numericValue] : "Select a rating";
    }

    if (!group) {
        return;
    }

    group.querySelectorAll(".rating-star").forEach((button) => {
        const starValue = Number(button.dataset.value || 0);
        const isActive = starValue <= numericValue;
        button.classList.toggle("active", isActive);
        button.setAttribute("aria-checked", starValue === numericValue ? "true" : "false");
    });
}

function bindRatingStars() {
    document.querySelectorAll(".rating-stars").forEach((group) => {
        if (group.dataset.bound === "true") {
            return;
        }

        const groupId = group.dataset.group;
        group.querySelectorAll(".rating-star").forEach((button) => {
            button.addEventListener("click", () => {
                setRatingStars(groupId, Number(button.dataset.value || 0));
            });
        });

        setRatingStars(groupId, Number(document.getElementById(groupId)?.value || 0));
        group.dataset.bound = "true";
    });
}

async function loadTenantRating(userId, userData) {
    const ratingSection = document.getElementById("ratingSection");
    const updatedText = document.getElementById("ratingUpdatedText");

    if (!ratingSection) {
        return;
    }

    if (userData.status !== "approved") {
        ratingSection.style.display = "none";
        return;
    }

    const isDismissed = localStorage.getItem(getRatingDismissStorageKey(userId)) === "true";
    ratingSection.style.display = "block";

    try {
        const ratingSnap = await getRatingRef(userId).get();
        if (!ratingSnap.exists) {
            if (isDismissed) {
                hideRatingSection();
                return;
            }

            setRatingStars("overallRating", 0);
            setRatingStars("roomRating", 0);
            setRatingStars("serviceRating", 0);
            const commentField = document.getElementById("ratingComment");
            if (commentField) {
                commentField.value = "";
            }
            if (updatedText) {
                updatedText.textContent = "Share your feedback with CitiHub management.";
            }
            return;
        }

        const rating = ratingSnap.data();
        setRatingStars("overallRating", rating.overallRating || 0);
        setRatingStars("roomRating", rating.roomRating || 0);
        setRatingStars("serviceRating", rating.adminServiceRating || 0);

        const commentField = document.getElementById("ratingComment");
        if (commentField) {
            commentField.value = rating.comment || "";
        }

        if (updatedText) {
            updatedText.textContent = formatRatingUpdated(rating.updatedAt || rating.createdAt);
        }

        hideRatingSection();
    } catch (error) {
        console.error("Failed to load tenant rating:", error);
    }
}

function updateMaintenanceSectionVisibility(userData) {
    const widget = document.getElementById("tenantMaintenanceWidget");
    const section = document.getElementById("maintenanceSection");
    const note = document.getElementById("maintenanceSectionNote");

    if (!widget || !section) {
        return;
    }

    if (userData.status !== "approved") {
        widget.style.display = "none";
        section.classList.remove("open");
        return;
    }

    widget.style.display = "block";

    if (note) {
        const roomLabel = userData.room || "your assigned room";
        note.textContent = `Report concerns for ${roomLabel}. CitiHub management can update the ticket status in real time.`;
    }
}

async function submitTenantRating() {
    const userId = window.currentUserId;
    const userData = tenantChatState.userData || {};
    const submitBtn = document.getElementById("ratingSubmitBtn");
    const updatedText = document.getElementById("ratingUpdatedText");

    if (!userId || !submitBtn) {
        return;
    }

    const overallRating = Number(document.getElementById("overallRating")?.value || 0);
    const roomRating = Number(document.getElementById("roomRating")?.value || 0);
    const serviceRating = Number(document.getElementById("serviceRating")?.value || 0);
    const comment = document.getElementById("ratingComment")?.value.trim() || "";

    if (!overallRating || !roomRating || !serviceRating) {
        showToast("Please complete all rating fields before submitting.");
        return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting...";

    try {
        const ratingRef = getRatingRef(userId);
        const existingRating = await ratingRef.get();

        await getRatingRef(userId).set({
            userId,
            fullName: userData.fullName || userData.username || "Tenant",
            email: userData.email || auth.currentUser?.email || "",
            room: userData.room || "",
            overallRating,
            roomRating,
            adminServiceRating: serviceRating,
            comment,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            createdAt: existingRating.exists && existingRating.data().createdAt
                ? existingRating.data().createdAt
                : firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        if (updatedText) {
            updatedText.textContent = "Feedback submitted successfully.";
        }

        localStorage.removeItem(getRatingDismissStorageKey(userId));
        hideRatingSection();
        showToast("Thank you for sharing your feedback.");
    } catch (error) {
        console.error("Failed to submit rating:", error);
        showToast("Unable to submit your feedback right now. Please try again.");
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "Submit Feedback";
    }
}

function bindAvatarDropdown() {
    const avatarContainer = document.querySelector(".avatar-container");
    const avatar = avatarContainer?.querySelector(".avatar");

    if (!avatarContainer || !avatar) {
        return;
    }

    avatar.addEventListener("click", function (event) {
        avatarContainer.classList.toggle("open");
        event.stopPropagation();
    });

    document.addEventListener("click", function () {
        avatarContainer.classList.remove("open");
    });

    avatarContainer.querySelectorAll(".dropdown-item").forEach((item) => {
        item.addEventListener("click", async function (event) {
            event.preventDefault();
            const action = this.dataset.action;

            if (action === "logout") {
                await logoutTenant();
            } else if (action === "profile") {
                window.location.href = "userprofile.html";
            } else if (action === "payment") {
                openSecureBilling("payment.html");
            } else if (action === "settings") {
                window.location.href = "settings.html";
            } else if (action === "terms") {
                const modal = document.getElementById("terms-modal");
                if (modal) {
                    modal.style.display = "flex";
                }
            }

            avatarContainer.classList.remove("open");
        });
    });
}

function bindBannerActions() {
    const payBtn = document.querySelector(".pay-btn");
    if (payBtn) {
        payBtn.addEventListener("click", () => {
            openSecureBilling("payment.html");
        });
    }

    const banner = document.querySelector(".billing-banner");
    const closeBtn = document.querySelector(".billing-banner .close-btn");
    if (banner && closeBtn) {
        closeBtn.addEventListener("click", () => {
            banner.style.display = "none";
        });
    }
}

function bindBillingSecurity() {
    document.querySelectorAll("[data-secure-billing-link]").forEach((link) => {
        link.addEventListener("click", (event) => {
            event.preventDefault();
            const destination = link.getAttribute("href") || "payment.html";
            openSecureBilling(destination.replace("../pages/", ""));
        });
    });

    document.getElementById("billingPasswordForm")?.addEventListener("submit", reauthenticateBillingWithPassword);
    document.getElementById("billingGoogleSubmit")?.addEventListener("click", reauthenticateBillingWithGoogle);
    document.getElementById("billingSecurityClose")?.addEventListener("click", closeBillingSecurityModal);

    const modal = document.getElementById("billingSecurityModal");
    modal?.addEventListener("click", (event) => {
        if (event.target === modal) {
            closeBillingSecurityModal();
        }
    });

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && modal?.classList.contains("open")) {
            closeBillingSecurityModal();
        }
    });
}

function bindBulletinToggle() {
    const section = document.getElementById("bulletinSection");
    const button = document.getElementById("bulletinToggleBtn");

    if (!section || !button) {
        return;
    }

    const storageKey = "citihub_bulletin_collapsed";
    const applyState = (collapsed) => {
        section.classList.toggle("collapsed", collapsed);
        button.textContent = collapsed ? "Show Bulletin" : "Minimize";
        button.setAttribute("aria-expanded", collapsed ? "false" : "true");
    };

    applyState(localStorage.getItem(storageKey) === "true");

    button.addEventListener("click", () => {
        const collapsed = !section.classList.contains("collapsed");
        applyState(collapsed);
        localStorage.setItem(storageKey, String(collapsed));
    });
}

function bindBookingButtons() {
    const primaryButton = document.querySelector(".book-btn");
    if (primaryButton) {
        primaryButton.addEventListener("click", function () {
            window.location.href = "booking.html";
        });
    }

    const premiumButton = document.querySelector(".book-btn.teal");
    if (premiumButton) {
        premiumButton.addEventListener("click", function () {
            window.location.href = "booking.html";
        });
    }
}

async function updateBookingButtonState() {
    const userId = window.currentUserId;
    const buttons = document.querySelectorAll(".book-btn");
    const bookingTitle = document.getElementById("bookingSectionTitle");
    const bookingSub = document.getElementById("bookingSectionSub");
    const bookingGrid = document.getElementById("bookingRoomsGrid");
    const transientCard = document.querySelector(".transient-card");

    buttons.forEach((btn) => {
        btn.style.display = "block";
        btn.disabled = true;
        btn.style.opacity = "0.5";
        btn.textContent = "Checking...";
    });

    const allowed = await canUserRequest(userId);
    const restrictionMessage = sessionStorage.getItem("bookingRestrictionMessage");
    if (restrictionMessage) {
        sessionStorage.removeItem("bookingRestrictionMessage");
        showToast(restrictionMessage);
    }

    buttons.forEach((btn) => {
        if (allowed) {
            if (bookingTitle) bookingTitle.style.display = "block";
            if (bookingSub) bookingSub.style.display = "block";
            if (bookingGrid) bookingGrid.style.display = "grid";
            if (transientCard) transientCard.style.display = "";
            btn.style.display = "block";
            btn.disabled = false;
            btn.style.opacity = "1";
            btn.textContent = "Request Booking";
        } else {
            if (bookingTitle) bookingTitle.style.display = "none";
            if (bookingSub) bookingSub.style.display = "none";
            if (bookingGrid) bookingGrid.style.display = "none";
            if (transientCard) transientCard.style.display = "none";
            btn.style.display = "none";
            btn.disabled = true;
        }
    });
}

async function loadAnnouncements() {
    if (tenantChatState.userData?.status !== "approved") {
        notificationState.announcements = [];
        const bulletinContainer = document.getElementById("bulletinList");
        if (bulletinContainer) {
            bulletinContainer.innerHTML = "";
        }
        updateTenantNotificationCenter();
        return;
    }

    const cached = localStorage.getItem("announcements");

    if (cached) {
        try {
            const cachedList = JSON.parse(cached);
            notificationState.announcements = cachedList;
            renderAnnouncements(cachedList);
            updateTenantNotificationCenter();
        } catch (error) {
            localStorage.removeItem("announcements");
        }
    }

    try {
        const snapshot = await db.collection("announcements")
            .orderBy("date", "desc")
            .limit(10)
            .get();

        const list = [];
        snapshot.forEach((doc) => {
            list.push({
                id: doc.id,
                ...doc.data()
            });
        });

        localStorage.setItem("announcements", JSON.stringify(list));
        notificationState.announcements = list;
        renderAnnouncements(list);
        updateTenantNotificationCenter();
    } catch (error) {
        console.error("Error loading announcements:", error);
    }
}

function renderAnnouncements(dataList) {
    const bulletinContainer = document.getElementById("bulletinList");
    if (!bulletinContainer) {
        return;
    }

    bulletinContainer.innerHTML = "";

    dataList.forEach((data) => {
        const dotClass = data.type === "urgent" ? "dot-urgent" : data.type === "notice" ? "dot-notice" : "dot-info";
        const badgeClass = data.type === "urgent" ? "badge-urgent" : data.type === "notice" ? "badge-notice" : "badge-general";
        const badgeText = data.type === "urgent" ? "Urgent" : data.type === "notice" ? "Reminder" : "General";
        const prefix = data.type === "urgent" ? "Urgent" : data.type === "notice" ? "Reminder" : "Info";

        const div = document.createElement("div");
        div.className = "bulletin-item";
        div.innerHTML = `
            <div class="bulletin-dot ${dotClass}"></div>
            <div class="bulletin-content">
                <div class="bulletin-item-title">${prefix}: ${data.title}</div>
                <div class="bulletin-item-body">${data.body}</div>
                <div class="bulletin-meta">
                    <span class="bulletin-badge ${badgeClass}">${badgeText}</span>
                    <span class="bulletin-date">Posted: ${data.displayDate} | ${data.author}</span>
                </div>
            </div>
        `;

        bulletinContainer.appendChild(div);
    });
}

async function canUserRequest(userId) {
    const userSnap = await db.collection("users").doc(userId).get();
    const userData = userSnap.exists ? (userSnap.data() || {}) : {};
    const normalizedUserStatus = normalizeBookingStatus(userData.status);

    if (userData.bookingBlocked === true) {
        return false;
    }

    if (["approved", BOOKING_STATUS_APPROVED_PENDING_DOWN_PAYMENT].includes(normalizedUserStatus)) {
        sessionStorage.setItem("bookingRestrictionMessage", "You already have an active monthly booking request, so new room and transient booking requests are hidden until that booking is resolved.");
        return false;
    }

    const snapshot = await db.collection("bookingRequest")
        .where("userId", "==", userId)
        .where("status", "in", ["pending", "approved", BOOKING_STATUS_APPROVED_PENDING_DOWN_PAYMENT, "rejected"])
        .get();

    if (!snapshot.empty) {
        const rejectedDoc = snapshot.docs.find((doc) => doc.data()?.status === "rejected");
        const activeDoc = snapshot.docs.find((doc) => ["pending", "approved", BOOKING_STATUS_APPROVED_PENDING_DOWN_PAYMENT].includes(doc.data()?.status));
        if (activeDoc) {
            sessionStorage.setItem("bookingRestrictionMessage", "You already have an active monthly booking request, so new room and transient booking requests are hidden until that booking is resolved.");
        } else if (rejectedDoc) {
            sessionStorage.setItem("bookingRestrictionMessage", "Please edit and resubmit your rejected booking request instead of creating a new one.");
        }
        return false;
    }

    const transientSnapshot = await db.collection("transientBedBookings")
        .where("userId", "==", userId)
        .get();
    const hasActiveTransientBed = transientSnapshot.docs.some((doc) => {
        return ["pending_payment", "pending", "approved", "checked_in"].includes(doc.data().status);
    });

    if (hasActiveTransientBed) {
        sessionStorage.setItem("bookingRestrictionMessage", "You already have an active Transient Bed request, so monthly booking is temporarily disabled.");
        return false;
    }

    return true;
}

function renderStatus(box, type, title, sub, iconLabel, referenceId = "", requestId = "", reason = "") {
    box.className = "request-status " + type;
    box.classList.toggle("clickable", Boolean(requestId));
    box.dataset.requestId = requestId || "";
    const reasonText = String(reason || "").trim();
    const reasonLabel = title.toLowerCase().includes("cancelled") ? "Reason for cancellation" : "Reason for rejection";

    box.innerHTML = `
        <div class="status-icon" aria-hidden="true">${iconLabel}</div>
        <div class="status-content">
            <div class="status-title">${escapeHtml(title)}</div>
            <div class="status-sub">${escapeHtml(sub)}</div>
            ${reasonText ? `
                <div class="status-reason">
                    <div class="status-reason-label">${escapeHtml(reasonLabel)}</div>
                    <div class="status-reason-text">${escapeHtmlWithBreaks(reasonText)}</div>
                </div>
            ` : ""}
            ${referenceId ? `<div class="status-ref">Reference #: ${escapeHtml(referenceId)}</div>` : ""}
        </div>
    `;
}

function createRequestStatusItemHtml(item) {
    const reasonText = String(item.reason || "").trim();
    const reasonLabel = item.title.toLowerCase().includes("cancelled") ? "Reason for cancellation" : "Reason for rejection";

    return `
        <div class="combined-status-item ${escapeHtml(item.type)}${item.clickable ? " clickable" : ""}" data-target="${escapeHtml(item.target)}" data-request-id="${escapeHtml(item.requestId || "")}">
            <div class="status-icon" aria-hidden="true">${item.icon}</div>
            <div class="status-content">
                <div class="combined-status-kicker">${escapeHtml(item.kicker)}</div>
                <div class="status-title">${escapeHtml(item.title)}</div>
                <div class="status-sub">${escapeHtml(item.sub)}</div>
                ${reasonText ? `
                    <div class="status-reason">
                        <div class="status-reason-label">${escapeHtml(reasonLabel)}</div>
                        <div class="status-reason-text">${escapeHtmlWithBreaks(reasonText)}</div>
                    </div>
                ` : ""}
                ${item.referenceId ? `<div class="status-ref">Reference #: ${escapeHtml(item.referenceId)}</div>` : ""}
            </div>
        </div>
    `;
}

function renderCombinedRequestStatus() {
    const box = document.getElementById("requestStatusBox");
    if (!box || !dashboardRequestState.monthly || !dashboardRequestState.transient) {
        return;
    }

    const allItems = [dashboardRequestState.monthly, dashboardRequestState.transient].filter(Boolean);
    const activeItems = allItems.filter((item) => item.active === true);
    const visibleItems = activeItems.length
        ? activeItems
        : allItems.filter((item) => item.type !== "empty" || item.referenceId || item.requestId);
    const itemsToRender = visibleItems.length ? visibleItems : allItems;
    const hasSingleItem = itemsToRender.length === 1;

    box.className = "request-status combined-request-status";
    box.innerHTML = `
        <div class="combined-request-head">
            <div>
                <div class="combined-request-title">Request Status</div>
                <div class="combined-request-sub">${hasSingleItem ? "Your current request is shown below." : "Monthly booking and Transient Bed requests in one place."}</div>
            </div>
        </div>
        <div class="combined-request-list">
            ${itemsToRender.map(createRequestStatusItemHtml).join("")}
        </div>
    `;
}

async function loadRequestStatus() {
    const userId = window.currentUserId;
    const box = document.getElementById("requestStatusBox");

    if (!userId || !box) {
        return;
    }

    const snapshot = await db.collection("bookingRequest")
        .where("userId", "==", userId)
        .orderBy("createdAt", "desc")
        .limit(1)
        .get();

    if (snapshot.empty) {
        notificationState.latestBooking = null;
        updateTenantNotificationCenter();
        dashboardRequestState.monthly = {
            target: "monthly",
            kicker: "Monthly Booking",
            type: "empty",
            title: "No Booking Yet",
            sub: "You haven't submitted any monthly booking request.",
            icon: "&#9432;",
            clickable: false
        };
        renderCombinedRequestStatus();
        return;
    }

    const requestDoc = snapshot.docs[0];
    const data = requestDoc.data();
    const referenceId = data.referenceId || requestDoc.id;
    notificationState.latestBooking = {
        id: requestDoc.id,
        referenceId,
        status: data.status || "",
        paymentStatus: data.paymentStatus || "unpaid",
        room: data.room || "",
        bed: data.bed || "",
        rejectionReason: data.rejectionReason || "",
        cancellationReason: data.cancellationReason || "",
        cancelledBy: data.cancelledBy || "",
        createdAt: data.createdAt || null
    };
    updateTenantNotificationCenter();

    if (data.status === "pending") {
        dashboardRequestState.monthly = {
            target: "monthly",
            kicker: "Monthly Booking",
            type: "pending",
            title: "Request Pending",
            sub: "Your booking request is under review.",
            icon: "&#9203;",
            referenceId,
            requestId: requestDoc.id,
            clickable: true,
            active: true
        };
    } else if (data.status === BOOKING_STATUS_APPROVED_PENDING_DOWN_PAYMENT) {
        dashboardRequestState.monthly = {
            target: "monthly",
            kicker: "Monthly Booking",
            type: "approved",
            title: "Booking Approved - Payment Needed",
            sub: `Room ${data.room}, Bed ${data.bed} is reserved pending your down payment.`,
            icon: "&#128179;",
            referenceId,
            requestId: requestDoc.id,
            clickable: true,
            active: true
        };
    } else if (data.status === "approved") {
        dashboardRequestState.monthly = {
            target: "monthly",
            kicker: "Monthly Booking",
            type: "approved",
            title: "Booking Approved",
            sub: `Room ${data.room}, Bed ${data.bed} has been reserved for you.`,
            icon: "&#10003;",
            referenceId,
            requestId: requestDoc.id,
            clickable: true,
            active: true
        };
    } else if (data.status === "rejected") {
        dashboardRequestState.monthly = {
            target: "monthly",
            kicker: "Monthly Booking",
            type: "rejected",
            title: "Request Rejected",
            sub: "Click here to edit and resubmit the same booking request.",
            icon: "&times;",
            referenceId,
            requestId: requestDoc.id,
            reason: data.rejectionReason || "No specific reason was recorded by the admin.",
            clickable: true
        };
    } else if (data.status === "cancelled") {
        const cancelledByAdmin = data.cancelledBy === "admin";
        dashboardRequestState.monthly = {
            target: "monthly",
            kicker: "Monthly Booking",
            type: "empty",
            title: "Booking Cancelled",
            sub: cancelledByAdmin
                ? "This booking request was cancelled by CitiHub management."
                : "This booking request was cancelled from your settings page.",
            icon: "&#10060;",
            referenceId,
            requestId: requestDoc.id,
            reason: data.cancellationReason || "No cancellation reason was provided.",
            clickable: true
        };
    }
    renderCombinedRequestStatus();
}

async function loadTransientBedStatus() {
    const userId = window.currentUserId;
    const box = document.getElementById("requestStatusBox");

    if (!userId || !box) {
        return;
    }

    const snapshot = await db.collection("transientBedBookings")
        .where("userId", "==", userId)
        .get();

    if (snapshot.empty) {
        notificationState.latestTransientBed = null;
        updateTenantNotificationCenter();
        dashboardRequestState.transient = {
            target: "transient",
            kicker: "Transient Bed",
            type: "empty",
            title: "No Transient Bed Request",
            sub: "Your daily stay requests will appear here after you book a Transient Bed.",
            icon: "&#9432;",
            clickable: true
        };
        renderCombinedRequestStatus();
        return;
    }

    const docs = snapshot.docs.slice().sort((left, right) => {
        const leftDate = getTimestampMs(left.data().createdAt);
        const rightDate = getTimestampMs(right.data().createdAt);
        return rightDate - leftDate;
    });
    const transientDoc = docs[0];
    const data = transientDoc.data();
    const referenceId = data.referenceId || transientDoc.id;

    notificationState.latestTransientBed = {
        id: transientDoc.id,
        referenceId,
        status: data.status || "",
        room: data.room || "",
        bed: data.bed || "",
        reason: data.reason || "",
        createdAt: data.createdAt || null,
        updatedAt: data.updatedAt || null
    };
    updateTenantNotificationCenter();

    if (data.status === "pending_payment") {
        dashboardRequestState.transient = {
            target: "transient",
            kicker: "Transient Bed",
            type: "pending",
            title: "Payment Needed",
            sub: `Room ${data.room}, Bed ${data.bed} is waiting for payment before admin review.`,
            icon: "&#9203;",
            referenceId,
            requestId: transientDoc.id,
            clickable: true,
            active: true
        };
    } else if (data.status === "pending") {
        dashboardRequestState.transient = {
            target: "transient",
            kicker: "Transient Bed",
            type: "pending",
            title: "Pending Review",
            sub: "Your Transient Bed request is waiting for admin approval.",
            icon: "&#9203;",
            referenceId,
            requestId: transientDoc.id,
            clickable: true,
            active: true
        };
    } else if (data.status === "approved") {
        const isPaid = data.paymentStatus === "paid";
        dashboardRequestState.transient = {
            target: "transient",
            kicker: "Transient Bed",
            type: "approved",
            title: isPaid ? "Approved" : "Approved - Payment Needed",
            sub: isPaid
                ? `Room ${data.room}, Bed ${data.bed} has been approved for your stay.`
                : `Room ${data.room}, Bed ${data.bed} is approved. Pay your bill from the Transient Bed page.`,
            icon: "&#10003;",
            referenceId,
            requestId: transientDoc.id,
            clickable: true,
            active: true
        };
    } else if (data.status === "checked_in") {
        dashboardRequestState.transient = {
            target: "transient",
            kicker: "Transient Bed",
            type: "approved",
            title: "Checked In",
            sub: `You are checked in at Room ${data.room}, Bed ${data.bed}.`,
            icon: "&#10003;",
            referenceId,
            requestId: transientDoc.id,
            clickable: true,
            active: true
        };
    } else if (data.status === "checked_out") {
        dashboardRequestState.transient = {
            target: "transient",
            kicker: "Transient Bed",
            type: "empty",
            title: "Checked Out",
            sub: "Your Transient Bed stay has been completed.",
            icon: "&#9432;",
            referenceId,
            requestId: transientDoc.id,
            clickable: true
        };
    } else if (data.status === "rejected") {
        dashboardRequestState.transient = {
            target: "transient",
            kicker: "Transient Bed",
            type: "rejected",
            title: "Rejected",
            sub: "You may submit another Transient Bed request.",
            icon: "&times;",
            referenceId,
            requestId: transientDoc.id,
            reason: data.reason || "No specific reason was recorded by the admin.",
            clickable: true
        };
    } else if (data.status === "cancelled") {
        dashboardRequestState.transient = {
            target: "transient",
            kicker: "Transient Bed",
            type: "empty",
            title: "Cancelled",
            sub: "This Transient Bed booking was cancelled.",
            icon: "&#10060;",
            referenceId,
            requestId: transientDoc.id,
            reason: data.reason || "No cancellation reason was provided.",
            clickable: true
        };
    }
    renderCombinedRequestStatus();
}

const requestStatusBox = document.getElementById("requestStatusBox");
if (requestStatusBox) {
    requestStatusBox.addEventListener("click", (event) => {
        const row = event.target.closest(".combined-status-item");
        if (!row) {
            return;
        }

        if (row.dataset.target === "transient") {
            const requestId = row.dataset.requestId;
            window.location.href = requestId
                ? `submit.html?type=transient&requestId=${encodeURIComponent(requestId)}`
                : "transient-bed.html";
            return;
        }

        const requestId = row.dataset.requestId;
        if (requestId) {
            window.location.href = `submit.html?requestId=${encodeURIComponent(requestId)}`;
        }
    });
}

auth.onAuthStateChanged(async (user) => {
    if (!user) {
        window.location.href = "intro.html";
        return;
    }

    window.currentUserId = user.uid;

    try {
        await touchTenantSession();
        const doc = await db.collection("users").doc(user.uid).get();

        if (!doc.exists) {
            window.hidePageLoader?.();
            showToast("User account information could not be found.");
            return;
        }

        const userData = doc.data();
        const username = userData.username || "User";
        const welcomeLogger = document.getElementById("welcome-logger");
        if (welcomeLogger) {
            welcomeLogger.textContent = username;
        }

        const roomElement = document.querySelector(".user-info .room");
        if (roomElement) {
            roomElement.textContent = userData.room || "Tenant account";
        }

        const avatarElement = document.querySelector(".avatar");
        if (avatarElement) {
            avatarElement.textContent = getInitials(userData.fullName || username);
        }

        const subtitle = document.getElementById("tenantChatSubtitle");
        if (subtitle) {
            subtitle.textContent = `Signed in as ${userData.fullName || username}`;
        }

        tenantChatState.userData = userData;
        window.currentUsername = username;
        updateApprovedOnlyDashboardSections(userData.status);
        updateTenantNotificationCenter();

        subscribeToTenantMessages(user.uid);
        updateMaintenanceSectionVisibility(userData);
        if (userData.status === "approved") {
            subscribeToTenantMaintenanceTickets(user.uid);
        }
        await loadTenantRating(user.uid, userData);
        await updateBookingButtonState();
        await loadOccupancyStats();
        await loadRequestStatus();
        await loadTransientBedStatus();
        await loadTenantBillingSummary(user.uid);
        await loadAnnouncements();
        window.hidePageLoader?.();
    } catch (error) {
        console.error("Failed to load main dashboard state:", error);
        window.hidePageLoader?.();
    }
});

document.addEventListener("DOMContentLoaded", () => {
    updateApprovedOnlyDashboardSections(null);
    bindAvatarDropdown();
    bindBannerActions();
    bindBillingSecurity();
    bindBulletinToggle();
    bindBookingButtons();
    bindTenantChatBubble();
    bindMaintenanceBubble();
    bindTenantNotificationPanel();
    bindTenantChatInput();
    bindRatingStars();
    bindOccupantsCard();
    bindRenewalActions();
    document.addEventListener("click", closeAllTenantMessageMenus);
    document.getElementById("ratingSubmitBtn")?.addEventListener("click", submitTenantRating);
    document.getElementById("ratingDismissBtn")?.addEventListener("click", dismissRatingSection);
    document.getElementById("maintenanceSubmitBtn")?.addEventListener("click", submitMaintenanceTicket);
});

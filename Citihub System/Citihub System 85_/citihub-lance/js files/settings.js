let activeCancelableBooking = null;
let activeApprovedBooking = null;
let activeTransferRequest = null;
let transferBedOptions = [];
let selectedTransferBed = null;
let transferTypeFilter = "all";
let pendingTransferConfirmation = null;
let currentUserProfile = null;
const SETTINGS_API_BASE_URL = window.CITIHUB_API_BASE_URL || "http://localhost:4000";
const BOOKING_STATUS_APPROVED_PENDING_DOWN_PAYMENT = "approved_pending_down_payment";
const BOOKING_STATUS_TENANT_CANCEL_REQUESTED = "tenant_cancel_requested";
const TRANSFER_CONTRACT_RATES = {
    standard: {
        "1_5_months": 3600,
        "6_11_months": 2893,
        "1_year": 1900
    },
    premium: {
        "1_5_months": 5075,
        "6_11_months": 4095,
        "1_year": 2500
    }
};

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

function formatLastLogin(dateString) {
    if (!dateString) {
        return "Unavailable";
    }

    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) {
        return "Unavailable";
    }

    return new Intl.DateTimeFormat("en-PH", {
        month: "long",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit"
    }).format(date).replace(",", " -");
}

async function callSettingsApi(path, payload) {
    const user = firebase.auth().currentUser;
    if (!user) {
        throw new Error("You must be signed in to continue.");
    }

    const token = await user.getIdToken();
    const response = await fetch(`${SETTINGS_API_BASE_URL}${path}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify(payload || {})
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(result.error || "The booking service request failed.");
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
        await callSettingsApi("/api/sessions/touch", {
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

        console.warn("Unable to update session activity:", error);
        return true;
    }
}

function formatSessionDate(value) {
    if (!value) return "Unavailable";

    return new Intl.DateTimeFormat("en-PH", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit"
    }).format(new Date(value));
}

function renderSessionList(sessions = []) {
    const list = document.getElementById("sessionList");
    if (!list) return;

    if (!sessions.length) {
        list.innerHTML = `<div class="session-empty">No session activity has been recorded yet.</div>`;
        return;
    }

    list.innerHTML = sessions.map((session) => {
        const statusClass = session.revokedAt ? "revoked" : session.isCurrent ? "current" : "";
        const badge = session.revokedAt ? "Signed out" : session.isCurrent ? "This device" : "Active";
        const badgeClass = session.revokedAt ? "revoked" : "";
        const title = `${session.browser || "Unknown Browser"} on ${session.os || "Unknown OS"}`;
        const details = [
            session.deviceType || "Unknown device",
            session.timezone || ""
        ].filter(Boolean).join(" • ");

        return `
            <div class="session-card ${statusClass}">
                <div>
                    <div class="session-title">${escapeHtml(title)}</div>
                    <div class="session-meta">${escapeHtml(details || "Session details unavailable")}</div>
                    <div class="session-sub">Last active: ${formatSessionDate(session.lastActiveAt)}</div>
                </div>
                <div class="session-badge ${badgeClass}">${badge}</div>
            </div>
        `;
    }).join("");
}

async function loadAccountSessions() {
    const list = document.getElementById("sessionList");
    if (list) {
        list.innerHTML = `<div class="session-empty">Loading account sessions...</div>`;
    }

    try {
        const payload = await callSettingsApi("/api/sessions/list", {
            sessionId: getTenantSessionId()
        });
        renderSessionList(payload.sessions || []);
    } catch (error) {
        console.error("Failed to load sessions:", error);
        if (list) {
            list.innerHTML = `<div class="session-empty">Unable to load session activity right now.</div>`;
        }
    }
}

async function signOutOtherDevices() {
    const button = document.getElementById("signOutOtherDevicesBtn");
    setButtonLoading(button, "Signing out...");

    try {
        const payload = await callSettingsApi("/api/sessions/revoke-others", {
            sessionId: getTenantSessionId()
        });
        showToast(`${payload.revokedCount || 0} other device session${payload.revokedCount === 1 ? "" : "s"} signed out.`);
        await loadAccountSessions();
    } catch (error) {
        console.error("Failed to sign out other devices:", error);
        showToast("Unable to sign out other devices right now.");
    } finally {
        restoreButton(button);
    }
}

function openSignOutDevicesModal() {
    const modal = document.getElementById("signOutDevicesModal");
    if (modal) {
        modal.style.display = "flex";
    }
}

function closeSignOutDevicesModal() {
    const modal = document.getElementById("signOutDevicesModal");
    if (modal) {
        modal.style.display = "none";
    }
}

async function confirmSignOutOtherDevices() {
    const confirmBtn = document.getElementById("signOutDevicesConfirm");
    const cancelBtn = document.getElementById("signOutDevicesCancel");

    setButtonLoading(confirmBtn, "Signing out...");
    if (cancelBtn) {
        cancelBtn.disabled = true;
    }

    try {
        await signOutOtherDevices();
        closeSignOutDevicesModal();
    } finally {
        restoreButton(confirmBtn);
        if (cancelBtn) {
            cancelBtn.disabled = false;
        }
    }
}

async function loadApprovedRoom(userId, userStatus) {
    const roomText = document.getElementById("userRoomText");
    if (!roomText) {
        return;
    }

    if (userStatus !== "approved") {
        roomText.textContent = "No room assigned yet";
        return;
    }

    try {
        const snapshot = await db.collection("bookingRequest")
            .where("userId", "==", userId)
            .where("status", "==", "approved")
            .get();

        if (snapshot.empty) {
            roomText.textContent = "No room assigned yet";
            return;
        }

        const latestDoc = snapshot.docs.slice().sort((left, right) => {
            const leftDate = left.data().createdAt?.toDate?.() || new Date(0);
            const rightDate = right.data().createdAt?.toDate?.() || new Date(0);
            return rightDate - leftDate;
        })[0];

        const data = latestDoc.data();
        const room = data.room ? `Room ${data.room}` : "Room unavailable";
        const bed = data.bed ? ` - Bed ${data.bed}` : "";
        roomText.textContent = `${room}${bed}`;
    } catch (error) {
        console.error("Failed to load approved room:", error);
        roomText.textContent = "No room assigned yet";
    }
}

async function logoutTenant() {
    try {
        await firebase.auth().signOut();
        sessionStorage.clear();
        localStorage.clear();
        window.location.href = "intro.html";
    } catch (error) {
        console.error("Logout failed:", error);
        alert("Unable to log out right now. Please try again.");
    }
}

function bindSettingsDropdown() {
    const avatarContainer = document.getElementById("avatarContainer");
    const avatarBtn = document.getElementById("avatarBtn");
    if (!avatarContainer || !avatarBtn) {
        return;
    }

    avatarBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        avatarContainer.classList.toggle("open");
    });

    document.addEventListener("click", () => avatarContainer.classList.remove("open"));

    avatarContainer.querySelectorAll(".dropdown-item").forEach((item) => {
        item.addEventListener("click", async (e) => {
            e.preventDefault();
            const action = item.dataset.action;

            if (action === "logout") {
                await logoutTenant();
            } else if (action === "profile") {
                window.location.href = "userprofile.html";
            } else if (action === "payment") {
                window.location.href = "payment.html";
            } else if (action === "settings") {
                window.location.href = "settings.html";
            } else if (action === "dashboard") {
                window.location.href = "main.html";
            }

            avatarContainer.classList.remove("open");
        });
    });
}

function togglePass(id, btn) {
    const input = document.getElementById(id);
    if (!input) {
        return;
    }

    if (input.type === "password") {
        input.type = "text";
        btn.textContent = "Hide";
    } else {
        input.type = "password";
        btn.textContent = "Show";
    }
}

function showToast(msg) {
    const toast = document.getElementById("toast");
    if (!toast) {
        return;
    }

    toast.textContent = msg;
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 3000);
}

function getFriendlySettingsApiError(error, fallbackMessage) {
    if (error?.message === "Failed to fetch") {
        return "Cannot connect to the booking server. Please make sure the backend is running, then try again.";
    }

    return error?.message || fallbackMessage;
}

function formatBookingDate(value) {
    if (!value) {
        return "Unavailable";
    }

    if (typeof value.toDate === "function") {
        return formatBookingDate(value.toDate());
    }

    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        return "Unavailable";
    }

    return new Intl.DateTimeFormat("en-PH", {
        month: "long",
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

async function loadLatestCancelableBooking(userId) {
    const snapshot = await db.collection("bookingRequest")
        .where("userId", "==", userId)
        .get();

    const sortedDocs = snapshot.docs
        .filter((doc) => ["pending", "approved", BOOKING_STATUS_APPROVED_PENDING_DOWN_PAYMENT].includes(String(doc.data()?.status || "").trim().toLowerCase()))
        .sort((left, right) => {
            const leftDate = left.data().createdAt?.toDate?.() || new Date(0);
            const rightDate = right.data().createdAt?.toDate?.() || new Date(0);
            return rightDate - leftDate;
        });

    if (!sortedDocs.length) {
        return null;
    }

    const doc = sortedDocs[0];
    const booking = {
        id: doc.id,
        ...doc.data()
    };
    booking.downPaymentRecord = await loadDownPaymentForBooking(userId, booking);
    booking.downPaymentPaid = booking.downPaymentRecord?.status === "paid";
    booking.hasOutstandingBilling = await loadOutstandingBillingForBooking(userId, booking);
    return booking;
}

async function loadLatestApprovedBooking(userId) {
    const snapshot = await db.collection("bookingRequest")
        .where("userId", "==", userId)
        .get();

    const docs = snapshot.docs.filter((doc) =>
        ["approved", BOOKING_STATUS_APPROVED_PENDING_DOWN_PAYMENT].includes(String(doc.data()?.status || "").trim().toLowerCase())
    );

    if (!docs.length) {
        return null;
    }

    const doc = docs.slice().sort((left, right) => {
        const leftDate = left.data().createdAt?.toDate?.() || new Date(0);
        const rightDate = right.data().createdAt?.toDate?.() || new Date(0);
        return rightDate - leftDate;
    })[0];

    const booking = {
        id: doc.id,
        ...doc.data()
    };
    booking.downPaymentRecord = await loadDownPaymentForBooking(userId, booking);
    booking.downPaymentPaid = booking.downPaymentRecord?.status === "paid";
    booking.hasOutstandingBilling = await loadOutstandingBillingForBooking(userId, booking);
    return booking;
}

async function loadLatestTransferRequest(userId) {
    const result = await callSettingsApi("/api/transfers/mine", {});
    const transfers = Array.isArray(result.transfers) ? result.transfers : [];
    if (!transfers.length) {
        return null;
    }
    return transfers[0];
}

async function loadDownPaymentForBooking(userId, booking) {
    if (!booking?.id) return null;

    const identifiers = [booking.id, booking.referenceId]
        .map((value) => String(value || "").trim())
        .filter((value, index, list) => value && list.indexOf(value) === index);
    const recordsById = new Map();

    for (const field of ["bookingRequestId", "bookingReferenceId"]) {
        for (const identifier of identifiers) {
            const snapshot = await db.collection("payments")
                .where("userId", "==", userId)
                .where(field, "==", identifier)
                .where("type", "==", "down_payment")
                .get();

            snapshot.forEach((doc) => {
                recordsById.set(doc.id, { id: doc.id, ...doc.data() });
            });
        }
    }

    const records = [...recordsById.values()].sort((left, right) => {
        const leftDate = left.createdAt?.toDate?.() || new Date(0);
        const rightDate = right.createdAt?.toDate?.() || new Date(0);
        return rightDate - leftDate;
    });
    return records.find((record) => record.status === "paid") || records[0] || null;
}

async function loadOutstandingBillingForBooking(userId, booking) {
    if (!booking?.id) return false;

    const identifiers = [booking.id, booking.referenceId]
        .map((value) => String(value || "").trim())
        .filter((value, index, list) => value && list.indexOf(value) === index);

    for (const field of ["bookingRequestId", "bookingReferenceId"]) {
        for (const identifier of identifiers) {
            const snapshot = await db.collection("billingInvoices")
                .where("userId", "==", userId)
                .where(field, "==", identifier)
                .get();

            const hasOutstanding = snapshot.docs.some((doc) => {
                const invoice = doc.data() || {};
                const status = String(invoice.status || "").trim().toLowerCase();
                return !["paid", "deducted_by_deposit", "cancelled"].includes(status)
                    && Number(invoice.amount || 0) > 0;
            });

            if (hasOutstanding) {
                return true;
            }
        }
    }

    return false;
}

function getRoomTypeRank(type) {
    return String(type || "").toLowerCase() === "premium" ? 2 : 1;
}

function formatPeso(amount) {
    return new Intl.NumberFormat("en-PH", {
        style: "currency",
        currency: "PHP"
    }).format(Number(amount || 0));
}

function formatBillingMonthLabel(value) {
    const safeValue = String(value || "").trim();
    if (/^\d{4}-\d{2}$/.test(safeValue)) {
        const [year, month] = safeValue.split("-").map(Number);
        return new Intl.DateTimeFormat("en-PH", { month: "long", year: "numeric" }).format(new Date(year, month - 1, 1));
    }

    const parsed = new Date(safeValue);
    if (!Number.isNaN(parsed.getTime())) {
        return new Intl.DateTimeFormat("en-PH", { month: "long", year: "numeric" }).format(parsed);
    }

    return "Upcoming Bill";
}

function calculateTransferFeePreview(targetType) {
    if (!activeApprovedBooking || !targetType) return null;

    const currentType = String(activeApprovedBooking.type || activeApprovedBooking.contractType || "").toLowerCase();
    const safeTargetType = String(targetType || "").toLowerCase();
    if (safeTargetType === currentType) {
        return {
            kind: "same_type",
            amount: 200,
            detail: "Same room type transfer fee"
        };
    }

    const currentRate = Number(activeApprovedBooking.monthlyRate || 0);
    const targetRate = TRANSFER_CONTRACT_RATES[safeTargetType]?.[activeApprovedBooking.contractTerm] || currentRate;
    const rateDifference = Math.max(0, targetRate - currentRate);
    return {
        kind: "upgrade",
        amount: 1000 + rateDifference,
        detail: `Upgrade fee ${formatPeso(1000)} + rate difference ${formatPeso(rateDifference)}`
    };
}

function transferBlocksNewRequest(transfer) {
    return Boolean(transfer && transfer.status !== "rejected");
}

function getTenantBillingRestrictionMessage(booking = activeApprovedBooking, userProfile = currentUserProfile) {
    if (userProfile?.manualBillingHold === true || booking?.manualBillingHold === true) {
        return "Your account is on billing hold. Transfer requests and add-on changes are disabled until CitiHub management removes the hold.";
    }

    if (
        userProfile?.delinquentAccount === true
        || booking?.delinquentAccount === true
        || String(userProfile?.billingStatus || "").toLowerCase() === "delinquent"
        || String(booking?.billingStatus || "").toLowerCase() === "delinquent"
    ) {
        return "Your account is now delinquent because of overdue billing. Transfer requests and add-on changes are disabled until your balance is settled.";
    }

    return "";
}

function isTenantBillingRestricted(booking = activeApprovedBooking, userProfile = currentUserProfile) {
    return Boolean(getTenantBillingRestrictionMessage(booking, userProfile));
}

function getBookingCancellationBlockMessage(booking = activeCancelableBooking, userProfile = currentUserProfile) {
    if (!booking) {
        return "";
    }

    if ((booking.status === "approved" || booking.downPaymentPaid) && booking.hasOutstandingBilling) {
        return "Please settle your outstanding billing first before requesting cancellation of this active booking.";
    }

    return getTenantBillingRestrictionMessage(booking, userProfile);
}

function canTenantRequestTransfer(booking = activeApprovedBooking) {
    return Boolean(booking && booking.downPaymentPaid && !isTenantBillingRestricted(booking));
}

async function loadTransferBillingInvoices(booking) {
    const identifiers = [booking?.id, booking?.referenceId]
        .map((value) => String(value || "").trim())
        .filter((value, index, list) => value && list.indexOf(value) === index);

    if (!window.currentUserId || !identifiers.length) {
        return [];
    }

    const recordsById = new Map();
    const snapshots = await Promise.all(
        identifiers.map((identifier) =>
            db.collection("billingInvoices")
                .where("userId", "==", window.currentUserId)
                .where("bookingRequestId", "==", identifier)
                .get()
        )
    );

    snapshots.forEach((snapshot) => {
        snapshot.forEach((doc) => {
            recordsById.set(doc.id, { id: doc.id, ...doc.data() });
        });
    });

    return [...recordsById.values()]
        .filter((invoice) => !["paid", "deducted_by_deposit", "cancelled"].includes(String(invoice.status || "").toLowerCase()))
        .sort((left, right) => String(left.billingMonth || left.dueDate || "").localeCompare(String(right.billingMonth || right.dueDate || "")));
}

function buildTransferBillingRows(booking, selected, invoices = []) {
    const currentRate = Number(booking?.monthlyRate || 0);
    const targetRate = TRANSFER_CONTRACT_RATES[String(selected?.type || "").toLowerCase()]?.[booking?.contractTerm] || currentRate;
    const hasRateChange = currentRate > 0 && targetRate > 0 && targetRate !== currentRate;

    if (!invoices.length) {
        return [{
            billingMonth: "Next unpaid billing cycle",
            currentAmount: currentRate,
            projectedAmount: targetRate,
            note: hasRateChange
                ? `Expected monthly rent changes by ${formatPeso(targetRate - currentRate)}.`
                : "Monthly invoice amount stays the same. Only the transfer fee applies."
        }];
    }

    return invoices.map((invoice) => {
        const currentInvoiceAmount = Number(invoice.amount || 0);
        const currentRentAmount = Number(invoice.rentAmount || currentRate || 0);
        const projectedRentAmount = hasRateChange && currentRate > 0
            ? Number(((currentRentAmount / currentRate) * targetRate).toFixed(2))
            : currentRentAmount;
        const projectedAmount = Number((currentInvoiceAmount - currentRentAmount + projectedRentAmount).toFixed(2));

        return {
            billingMonth: invoice.billingMonth || invoice.dueDate || "",
            currentAmount: currentInvoiceAmount,
            projectedAmount,
            note: hasRateChange
                ? `Rent changes from ${formatPeso(currentRentAmount)} to ${formatPeso(projectedRentAmount)}.`
                : "Monthly invoice amount stays the same. Only the transfer fee applies."
        };
    });
}

function closeTransferConfirmModal() {
    const modal = document.getElementById("transferConfirmModal");
    if (modal) {
        modal.style.display = "none";
    }
    pendingTransferConfirmation = null;
}

async function openTransferConfirmModal(selected, reason) {
    const modal = document.getElementById("transferConfirmModal");
    const summary = document.getElementById("transferConfirmSummary");
    const tbody = document.getElementById("transferConfirmTableBody");
    if (!modal || !summary || !tbody || !activeApprovedBooking) {
        return false;
    }

    const feePreview = calculateTransferFeePreview(selected.type);
    const invoices = await loadTransferBillingInvoices(activeApprovedBooking);
    const rows = buildTransferBillingRows(activeApprovedBooking, selected, invoices);
    const currentLabel = `Room ${activeApprovedBooking.room}, Bed ${activeApprovedBooking.bed}`;
    const targetLabel = `Room ${selected.room}, Bed ${selected.bed}`;

    summary.innerHTML = `
        <strong>Current:</strong> ${escapeHtml(currentLabel)}<br>
        <strong>Requested transfer:</strong> ${escapeHtml(targetLabel)} (${escapeHtml(String(selected.type || "").toUpperCase())})<br>
        <strong>Transfer fee:</strong> ${feePreview ? formatPeso(feePreview.amount) : "Unavailable"}${feePreview ? ` - ${escapeHtml(feePreview.detail)}` : ""}<br>
        <strong>Payment window:</strong> Pay within 48 hours after admin approval or this request will expire.${reason ? `<br><strong>Reason:</strong> ${escapeHtml(reason)}` : ""}
    `;

    tbody.innerHTML = rows.map((row) => `
        <tr>
            <td>${escapeHtml(formatBillingMonthLabel(row.billingMonth))}</td>
            <td class="transfer-confirm-current">${formatPeso(row.currentAmount)}</td>
            <td class="transfer-confirm-next">
                ${formatPeso(row.projectedAmount)}
                <span class="transfer-confirm-note">${escapeHtml(row.note)}</span>
            </td>
        </tr>
    `).join("");

    pendingTransferConfirmation = { selected, reason };
    modal.style.display = "flex";
    return true;
}

async function confirmTransferRequestSubmission() {
    const button = document.getElementById("submitTransferRequestBtn");
    if (!pendingTransferConfirmation) {
        closeTransferConfirmModal();
        return;
    }

    try {
        setButtonLoading(button, "Submitting...");
        await callSettingsApi("/api/transfers/create", {
            targetRoom: pendingTransferConfirmation.selected.room,
            targetBed: pendingTransferConfirmation.selected.bed,
            targetType: pendingTransferConfirmation.selected.type,
            reason: pendingTransferConfirmation.reason
        });
        closeTransferConfirmModal();
        showToast("Transfer request submitted for admin approval.");
        await refreshTransferPanel();
    } catch (error) {
        console.error("Transfer request failed:", error);
        showToast(getFriendlySettingsApiError(error, "Unable to submit transfer request."));
    } finally {
        restoreButton(button);
    }
}

function renderTransferStatus(transfer) {
    const card = document.getElementById("transferRequestStatus");
    const payBtn = document.getElementById("payTransferFeeBtn");
    const submitBtn = document.getElementById("submitTransferRequestBtn");

    activeTransferRequest = transfer;
    if (!card || !payBtn || !submitBtn) return;

    card.className = "transfer-status-card";
    payBtn.style.display = "none";
    submitBtn.disabled = !canTenantRequestTransfer();

    const billingRestrictionMessage = getTenantBillingRestrictionMessage();

    if (billingRestrictionMessage) {
        card.classList.add("rejected");
        card.textContent = billingRestrictionMessage;
        return;
    }

    if (!canTenantRequestTransfer()) {
        card.classList.add("pending");
        card.textContent = "Complete your down payment first before you can submit a room transfer request.";
        return;
    }

    if (!transfer) {
        card.textContent = "No active transfer request. Select an available bedspace and submit your request for admin review.";
        return;
    }

    const target = `Room ${transfer.targetRoom}, Bed ${transfer.targetBed}`;
    if (transfer.status === "pending_admin") {
        card.classList.add("pending");
        card.textContent = `Pending admin approval: ${target}. Estimated fee: ${formatPeso(transfer.feeAmount)}.`;
        submitBtn.disabled = true;
    } else if (transfer.status === "approved_pending_payment") {
        card.classList.add("approved");
        card.textContent = `Approved. Please pay ${formatPeso(transfer.feeAmount)} so CitiHub can complete your transfer to ${target}.`;
        payBtn.style.display = "";
        submitBtn.disabled = true;
    } else if (transfer.status === "completed") {
        card.classList.add("completed");
        card.textContent = `Completed. You have been transferred to ${target}.`;
        submitBtn.disabled = true;
    } else if (transfer.status === "expired") {
        card.classList.add("rejected");
        card.textContent = transfer.expirationReason || "Expired. The transfer fee was not paid within 48 hours.";
    } else if (transfer.status === "rejected") {
        card.classList.add("rejected");
        card.textContent = `Rejected. ${transfer.adminNote || "No admin note provided."}`;
    } else {
        card.textContent = `Latest transfer status: ${String(transfer.status || "unknown").replace(/_/g, " ")}.`;
        submitBtn.disabled = transferBlocksNewRequest(transfer);
    }
}

function updateTransferFeePreview() {
    const select = document.getElementById("transferTargetBed");
    const feeEl = document.getElementById("transferFeePreview");
    if (!feeEl) return;

    const selected = selectedTransferBed || transferBedOptions.find((option) => option.key === select?.value);
    if (!selected) {
        feeEl.textContent = "Select a target bed";
        return;
    }

    const preview = calculateTransferFeePreview(selected.type);
    feeEl.textContent = preview ? `${formatPeso(preview.amount)} - ${preview.detail}` : "Unable to calculate fee";
}

function renderTransferPanel(booking, transfer) {
    const banner = document.getElementById("transferStatusBanner");
    const current = document.getElementById("transferCurrentAssignment");
    const targetSelect = document.getElementById("transferTargetBed");
    const roomsContainer = document.getElementById("transferRoomsContainer");
    const submitBtn = document.getElementById("submitTransferRequestBtn");
    const paymentBtn = document.getElementById("goToTransferPaymentBtn");

    activeApprovedBooking = booking;

    if (!banner || !current || !targetSelect || !submitBtn) return;
    if (paymentBtn) {
        paymentBtn.style.display = "none";
    }

    if (!booking) {
        banner.className = "info-banner red";
        banner.innerHTML = "&#9432; You need an approved monthly booking before requesting a room transfer.";
        current.textContent = "No approved bedspace";
        targetSelect.innerHTML = `<option value="">No approved booking found</option>`;
        targetSelect.disabled = true;
        if (roomsContainer) {
            roomsContainer.innerHTML = `<div class="transfer-empty-state">No approved booking found.</div>`;
        }
        selectedTransferBed = null;
        submitBtn.disabled = true;
        renderTransferStatus(transfer);
        return;
    }

    if (!booking.downPaymentPaid) {
        banner.className = "info-banner red";
        banner.innerHTML = "&#9432; Please complete your down payment before requesting a room transfer.";
        current.textContent = `Room ${booking.room}, Bed ${booking.bed} - ${String(booking.type || "standard").toUpperCase()} (${formatPeso(booking.monthlyRate || 0)}/month)`;
        targetSelect.innerHTML = `<option value="">Down payment required first</option>`;
        targetSelect.disabled = true;
        if (roomsContainer) {
            roomsContainer.innerHTML = `
                <div class="transfer-empty-state">
                    Your booking is approved, but the required down payment is not marked as paid yet. Complete the down payment first, then return here to choose a transfer bedspace.
                </div>
            `;
        }
        selectedTransferBed = null;
        submitBtn.disabled = true;
        if (paymentBtn) {
            paymentBtn.style.display = "";
        }
        renderTransferStatus(transfer);
        return;
    }

    const billingRestrictionMessage = getTenantBillingRestrictionMessage(booking);
    if (billingRestrictionMessage) {
        banner.className = "info-banner red";
        banner.innerHTML = `&#9888;&#65039; ${escapeHtml(billingRestrictionMessage)}`;
        targetSelect.innerHTML = `<option value="">Transfer temporarily unavailable</option>`;
        targetSelect.disabled = true;
        if (roomsContainer) {
            roomsContainer.innerHTML = `
                <div class="transfer-empty-state">
                    ${escapeHtml(billingRestrictionMessage)} You can still open Billing to settle your account.
                </div>
            `;
        }
        selectedTransferBed = null;
        submitBtn.disabled = true;
        renderTransferStatus(transfer);
        return;
    }

    banner.className = "info-banner green";
    banner.innerHTML = "&#8644; Same type transfers cost PHP 200. Standard to Premium upgrades cost PHP 1,000 plus the monthly rate difference.";
    current.textContent = `Room ${booking.room}, Bed ${booking.bed} - ${String(booking.type || "standard").toUpperCase()} (${formatPeso(booking.monthlyRate || 0)}/month)`;
    targetSelect.disabled = false;
    submitBtn.disabled = false;
    renderTransferStatus(transfer);
}

function selectTransferBed(optionKey) {
    const targetSelect = document.getElementById("transferTargetBed");
    const selected = transferBedOptions.find((option) => option.key === optionKey);

    if (!selected) return;

    selectedTransferBed = selected;
    if (targetSelect) {
        targetSelect.value = selected.key;
    }

    document.querySelectorAll(".transfer-bed-box.selected").forEach((box) => {
        box.classList.remove("selected");
    });

    const selectedBox = Array.from(document.querySelectorAll(".transfer-bed-box"))
        .find((box) => box.dataset.key === selected.key);
    if (selectedBox) {
        selectedBox.classList.add("selected");
    }

    updateTransferFeePreview();
}

function updateTransferTypeFilterButtons() {
    document.querySelectorAll(".transfer-type-btn").forEach((button) => {
        button.classList.toggle("active", button.dataset.transferType === transferTypeFilter);
    });
}

function setTransferTypeFilter(type) {
    transferTypeFilter = ["standard", "premium"].includes(type) ? type : "all";
    updateTransferTypeFilterButtons();
    renderTransferBedGrid();
    updateTransferFeePreview();
}

function renderTransferBedGrid() {
    const container = document.getElementById("transferRoomsContainer");
    if (!container) return;

    selectedTransferBed = null;
    container.innerHTML = "";
    const hasExistingTransfer = transferBlocksNewRequest(activeTransferRequest);

    if (!activeApprovedBooking) {
        container.innerHTML = `<div class="transfer-empty-state">No approved booking found.</div>`;
        return;
    }

    const visibleOptions = transferTypeFilter === "all"
        ? transferBedOptions
        : transferBedOptions.filter((option) => String(option.type || "").toLowerCase() === transferTypeFilter);

    if (selectedTransferBed && !visibleOptions.some((option) => option.key === selectedTransferBed.key)) {
        const targetSelect = document.getElementById("transferTargetBed");
        selectedTransferBed = null;
        if (targetSelect) {
            targetSelect.value = "";
        }
    }

    if (!visibleOptions.length) {
        const filterLabel = transferTypeFilter === "all" ? "" : ` ${transferTypeFilter}`;
        container.innerHTML = `<div class="transfer-empty-state">No eligible available bedspaces. You can refresh again later.</div>`;
        if (filterLabel) {
            container.innerHTML = `<div class="transfer-empty-state">No eligible available${filterLabel} bedspaces right now.</div>`;
        }
        return;
    }

    const rooms = visibleOptions.reduce((grouped, option) => {
        if (!grouped[option.room]) {
            grouped[option.room] = {
                room: option.room,
                type: option.type,
                gender: option.gender || "Mixed",
                beds: []
            };
        }
        grouped[option.room].beds.push(option);
        return grouped;
    }, {});

    Object.values(rooms)
        .sort((left, right) => String(left.room).localeCompare(String(right.room), undefined, { numeric: true }))
        .forEach((room) => {
            const roomGender = String(room.gender || "Mixed").toLowerCase();
            const bedsHtml = room.beds
                .sort((left, right) => String(left.bed).localeCompare(String(right.bed), undefined, { numeric: true }))
                .map((option) => `
                    <button class="transfer-bed-box available${hasExistingTransfer ? " disabled" : ""}${selectedTransferBed?.key === option.key ? " selected" : ""}" type="button" data-key="${escapeHtml(option.key)}" ${hasExistingTransfer ? "disabled" : ""}>
                        <span class="transfer-bed-num">Bed ${escapeHtml(option.bed)}</span>
                        <span class="transfer-bed-type">${escapeHtml(option.type || "standard")}</span>
                        <span class="transfer-bed-status-label">${hasExistingTransfer ? "Locked" : "Available"}</span>
                    </button>
                `)
                .join("");

            container.insertAdjacentHTML("beforeend", `
                <div class="transfer-room-section">
                    <div class="transfer-room-section-header">
                        <span class="transfer-room-section-name">Room ${escapeHtml(room.room)}</span>
                        <span class="transfer-gender-tag ${escapeHtml(roomGender)}">${escapeHtml(room.gender || "Mixed")}</span>
                    </div>
                    <div class="transfer-beds-grid">${bedsHtml}</div>
                </div>
            `);
        });

    container.querySelectorAll(".transfer-bed-box:not(.disabled)").forEach((box) => {
        box.addEventListener("click", () => selectTransferBed(box.dataset.key));
    });
    updateTransferTypeFilterButtons();
}

async function loadTransferBedOptions() {
    const targetSelect = document.getElementById("transferTargetBed");
    const roomsContainer = document.getElementById("transferRoomsContainer");
    if (!targetSelect || !activeApprovedBooking) {
        renderTransferBedGrid();
        return;
    }

    if (isTenantBillingRestricted(activeApprovedBooking)) {
        transferBedOptions = [];
        selectedTransferBed = null;
        targetSelect.innerHTML = `<option value="">Transfer temporarily unavailable</option>`;
        if (roomsContainer) {
            roomsContainer.innerHTML = `<div class="transfer-empty-state">${escapeHtml(getTenantBillingRestrictionMessage(activeApprovedBooking))}</div>`;
        }
        updateTransferFeePreview();
        return;
    }

    targetSelect.innerHTML = `<option value="">Loading available bedspaces...</option>`;
    if (roomsContainer) {
        roomsContainer.innerHTML = `<div class="transfer-empty-state">Loading available bedspaces...</div>`;
    }
    selectedTransferBed = null;

    const currentType = String(activeApprovedBooking.type || activeApprovedBooking.contractType || "").toLowerCase();
    const userGender = String(activeApprovedBooking.gender || "").toLowerCase();
    const snapshot = await db.collection("ROOMS").get();

    transferBedOptions = [];
    snapshot.forEach((doc) => {
        const data = doc.data() || {};
        const [room, bed] = doc.id.split("_");
        const type = String(data.type || "").toLowerCase();
        const gender = String(data.gender || "").toLowerCase();
        const avail = String(data.avail || "available").toLowerCase();

        if (!room || !bed || avail !== "available") return;
        if (room === String(activeApprovedBooking.room) && bed === String(activeApprovedBooking.bed)) return;
        if (getRoomTypeRank(type) < getRoomTypeRank(currentType)) return;
        if (gender && gender !== "mixed" && userGender && userGender !== "mixed" && gender !== userGender) return;

        transferBedOptions.push({
            key: doc.id,
            room,
            bed,
            type,
            gender: data.gender || "Mixed",
            label: `Room ${room}, Bed ${bed} - ${type.toUpperCase()}`
        });
    });

    transferBedOptions.sort((left, right) => left.label.localeCompare(right.label, undefined, { numeric: true }));
    targetSelect.innerHTML = transferBedOptions.length
        ? `<option value="">Select target bedspace</option>` + transferBedOptions.map((option) => `<option value="${option.key}">${option.label}</option>`).join("")
        : `<option value="">No eligible available bedspaces</option>`;
    renderTransferBedGrid();
    updateTransferFeePreview();
}

async function refreshTransferPanel() {
    if (!window.currentUserId) return;

    const [booking, transfer] = await Promise.all([
        loadLatestApprovedBooking(window.currentUserId),
        loadLatestTransferRequest(window.currentUserId)
    ]);
    renderTransferPanel(booking, transfer);
    await loadTransferBedOptions();
}

async function verifyTransferPaymentFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const paymentId = params.get("paymentId");
    const result = params.get("result");
    const type = params.get("type");

    if (!paymentId || result !== "success" || type !== "transfer") return;

    try {
        await callSettingsApi("/api/payments/verify", { paymentId });
        showToast("Transfer payment verified. Your transfer will be completed automatically.");
        const cleanUrl = new URL(window.location.href);
        ["paymentId", "result", "type", "transferRequestId"].forEach((key) => cleanUrl.searchParams.delete(key));
        window.history.replaceState({}, document.title, cleanUrl.toString());
    } catch (error) {
        console.error("Transfer payment verification failed:", error);
        showToast(getFriendlySettingsApiError(error, "Unable to verify transfer payment right now."));
    }
}

async function submitTransferRequest() {
    const select = document.getElementById("transferTargetBed");
    const reason = document.getElementById("transferReason")?.value.trim() || "";
    const selected = selectedTransferBed || transferBedOptions.find((option) => option.key === select?.value);

    if (transferBlocksNewRequest(activeTransferRequest)) {
        showToast("You already have a transfer request.");
        return;
    }

    if (!activeApprovedBooking) {
        showToast("You need an approved booking before requesting a transfer.");
        return;
    }

    if (isTenantBillingRestricted(activeApprovedBooking)) {
        showToast(getTenantBillingRestrictionMessage(activeApprovedBooking));
        return;
    }

    if (!canTenantRequestTransfer(activeApprovedBooking)) {
        showToast("Please complete your down payment before requesting a room transfer.");
        return;
    }

    if (!selected) {
        showToast("Please select your target bedspace.");
        document.getElementById("transferRoomsContainer")?.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
    }

    try {
        await openTransferConfirmModal(selected, reason);
    } catch (error) {
        console.error("Transfer preview failed:", error);
        showToast("Unable to load the billing comparison right now.");
    }
}

async function payTransferFee() {
    const button = document.getElementById("payTransferFeeBtn");
    const method = document.getElementById("transferPaymentMethod")?.value || "gcash";

    if (!activeTransferRequest || activeTransferRequest.status !== "approved_pending_payment") {
        showToast("No approved transfer fee is ready for payment.");
        return;
    }

    try {
        setButtonLoading(button, "Opening payment...");
        const result = await callSettingsApi("/api/payments/transfer/create", {
            transferRequestId: activeTransferRequest.id,
            method,
            baseUrl: window.location.href.split("?")[0]
        });

        if (result.status === "paid") {
            showToast("Transfer fee is already paid.");
            await refreshTransferPanel();
            return;
        }

        window.location.href = result.checkoutUrl;
    } catch (error) {
        console.error("Transfer payment failed:", error);
        showToast(getFriendlySettingsApiError(error, "Unable to open transfer payment."));
        restoreButton(button);
    }
}

function goToTransferPaymentPage() {
    window.location.href = "payment.html";
}

function renderBookingCancellationPanel(booking) {
    const infoBanner = document.getElementById("bookingCancelInfoBanner");
    const summary = document.getElementById("cancelBookingSummary");
    const meta = document.getElementById("cancelBookingMeta");
    const openBtn = document.getElementById("openCancelBookingBtn");
    const reasonField = document.getElementById("cancelBookingReason");

    activeCancelableBooking = booking;

    if (!infoBanner || !summary || !meta || !openBtn || !reasonField) {
        return;
    }

    if (!booking) {
        infoBanner.className = "info-banner green";
        infoBanner.innerHTML = "&#9432; You do not have any pending or approved booking request that can still be cancelled.";
        summary.textContent = "No active booking request found.";
        meta.innerHTML = "Once you have a pending or approved booking request, its status and cancellation options will appear here.";
        openBtn.disabled = true;
        openBtn.textContent = "✖ Cancel Booking";
        reasonField.value = "";
        reasonField.disabled = true;
        return;
    }

    const roomLabel = booking.room ? `Room ${booking.room}` : "Room not assigned";
    const bedLabel = booking.bed ? ` - Bed ${booking.bed}` : "";
    const moveInDate = booking.moveInDate ? formatBookingDate(`${booking.moveInDate}T00:00:00`) : "Not yet specified";
    const isReserved = booking.status === BOOKING_STATUS_APPROVED_PENDING_DOWN_PAYMENT;
    const isApproved = booking.status === "approved";
    const hasCancellationRequest = booking.tenantCancellationRequested === true
        || String(booking.tenantCancellationRequestStatus || "").trim().toLowerCase() === "pending_review";
    const cancellationBlockMessage = getBookingCancellationBlockMessage(booking);
    const statusLabel = isApproved
        ? "Approved"
        : isReserved
            ? "Awaiting Down Payment"
            : "Pending Review";

    if (hasCancellationRequest && (isApproved || isReserved)) {
        infoBanner.className = "info-banner yellow";
        infoBanner.innerHTML = "&#9888;&#65039; Your cancellation request is already pending CitiHub management review.";
    } else if (cancellationBlockMessage) {
        infoBanner.className = "info-banner red";
        infoBanner.innerHTML = `&#9888;&#65039; ${escapeHtml(cancellationBlockMessage)}`;
    } else {
        infoBanner.className = isApproved || isReserved ? "info-banner red" : "info-banner green";
        infoBanner.innerHTML = isApproved || isReserved
            ? "&#9888;&#65039; Cancelling this booking will release your reserved bedspace and remove your room assignment."
            : "&#128197; Cancelling this request will stop the current booking review and notify CitiHub management.";
    }

    summary.textContent = `${hasCancellationRequest ? "Cancellation Requested" : statusLabel} booking for ${roomLabel}${bedLabel}`;
    meta.innerHTML = `
        <strong>Reference:</strong> ${booking.referenceId || booking.id}<br>
        <strong>Requested Move-in Date:</strong> ${moveInDate}<br>
        <strong>Monthly Rate:</strong> ${booking.leasePrice || "Not available"}<br>
        <strong>Current Status:</strong> ${hasCancellationRequest ? "Cancellation Requested" : statusLabel}
    `;
    if (hasCancellationRequest) {
        meta.innerHTML += `<br><strong>Request Reason:</strong> ${escapeHtml(booking.tenantCancellationReason || "Not provided")}`;
    }
    openBtn.disabled = hasCancellationRequest || Boolean(cancellationBlockMessage);
    openBtn.textContent = isApproved ? "📝 Request Cancellation" : "✖ Cancel Booking";
    reasonField.disabled = hasCancellationRequest || Boolean(cancellationBlockMessage);
}

function openCancelBookingModal() {
    const modal = document.getElementById("cancelBookingModal");
    const desc = document.getElementById("cancelBookingModalDesc");
    const reason = document.getElementById("cancelBookingReason")?.value.trim() || "";

    if (!activeCancelableBooking) {
        showToast("No active booking request is available for cancellation.");
        return;
    }

    const cancellationBlockMessage = getBookingCancellationBlockMessage(activeCancelableBooking);
    if (cancellationBlockMessage) {
        showToast(cancellationBlockMessage);
        return;
    }

    if (!reason) {
        showToast("Please provide your reason for cancelling the booking.");
        document.getElementById("cancelBookingReason")?.focus();
        return;
    }

    if (desc) {
        desc.textContent = activeCancelableBooking.status === "approved"
            ? "This will send a cancellation request to CitiHub management for review. Your active booking will stay in place until management finalizes the cancellation."
            : activeCancelableBooking.status === BOOKING_STATUS_APPROVED_PENDING_DOWN_PAYMENT
                ? "This will cancel your reserved CitiHub booking, release your bedspace, and notify the admin team."
                : "This will cancel your pending CitiHub booking request and notify the admin team.";
    }

    if (modal) {
        modal.style.display = "flex";
    }
}

function closeCancelBookingModal() {
    const modal = document.getElementById("cancelBookingModal");
    if (modal) {
        modal.style.display = "none";
    }
}

async function handleTenantBookingCancellation() {
    const confirmBtn = document.getElementById("confirmCancelBookingBtn");
    const openBtn = document.getElementById("openCancelBookingBtn");
    const closeBtn = document.getElementById("cancelBookingModalClose");
    const reasonField = document.getElementById("cancelBookingReason");
    const reason = reasonField?.value.trim() || "";

    if (!activeCancelableBooking) {
        showToast("No active booking request is available for cancellation.");
        closeCancelBookingModal();
        return;
    }

    const cancellationBlockMessage = getBookingCancellationBlockMessage(activeCancelableBooking);
    if (cancellationBlockMessage) {
        showToast(cancellationBlockMessage);
        closeCancelBookingModal();
        return;
    }

    if (!reason) {
        showToast("Please provide your reason for cancelling the booking.");
        closeCancelBookingModal();
        reasonField?.focus();
        return;
    }

    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = "Cancelling...";
    }
    setButtonLoading(confirmBtn, "Cancelling...");
    if (openBtn) {
        openBtn.disabled = true;
    }
    if (closeBtn) {
        closeBtn.disabled = true;
    }
    if (reasonField) {
        reasonField.disabled = true;
    }

    try {
        const payload = await callSettingsApi("/api/bookings/cancel", {
            bookingRequestId: activeCancelableBooking.id,
            cancellationReason: reason
        });

        closeCancelBookingModal();
        reasonField.value = "";
        showToast(payload.message || "Your booking update was sent successfully.");

        if (window.currentUserId) {
            const latestBooking = await loadLatestCancelableBooking(window.currentUserId);
            renderBookingCancellationPanel(latestBooking);
            await loadApprovedRoom(window.currentUserId, latestBooking && latestBooking.status === "approved" ? "approved" : "registered");
        }
    } catch (error) {
        console.error("Failed to cancel booking:", error);
        showToast(getFriendlySettingsApiError(error, "Unable to cancel your booking right now."));
    } finally {
        if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.textContent = "✖ Confirm Cancellation";
        }
        restoreButton(confirmBtn);
        if (openBtn) {
            openBtn.disabled = !activeCancelableBooking
                || activeCancelableBooking.tenantCancellationRequested === true
                || String(activeCancelableBooking.tenantCancellationRequestStatus || "").trim().toLowerCase() === "pending_review"
                || Boolean(getBookingCancellationBlockMessage(activeCancelableBooking));
        }
        if (closeBtn) {
            closeBtn.disabled = false;
        }
        if (reasonField) {
            reasonField.disabled = !activeCancelableBooking || Boolean(getBookingCancellationBlockMessage(activeCancelableBooking));
        }
    }
}

auth.onAuthStateChanged(async (user) => {
    if (!user) {
        window.location.href = "intro.html";
        return;
    }

    try {
        const userId = user.uid;
        window.currentUserId = userId;
        await touchTenantSession();

        const doc = await db.collection("users").doc(userId).get();
        if (!doc.exists) {
            window.hidePageLoader?.();
            alert("User data not found.");
            return;
        }

        const userData = doc.data();
        currentUserProfile = userData;
        const username = userData.username || "User";
        window.currentUsername = username;

        const welcomeLogger = document.getElementById("welcome-logger");
        if (welcomeLogger) {
            welcomeLogger.textContent = username;
        }

        const avatarBtn = document.getElementById("avatarBtn");
        if (avatarBtn) {
            avatarBtn.textContent = String(userData.fullName || username)
                .split(/\s+/)
                .filter(Boolean)
                .slice(0, 2)
                .map((part) => part[0].toUpperCase())
                .join("") || "U";
        }

        const lastLoginText = document.getElementById("lastLoginText");
        if (lastLoginText) {
            lastLoginText.textContent = formatLastLogin(user.metadata?.lastSignInTime);
        }

        await loadApprovedRoom(userId, userData.status);
        const latestCancelableBooking = await loadLatestCancelableBooking(userId);
        renderBookingCancellationPanel(latestCancelableBooking);
        await verifyTransferPaymentFromUrl();
        await refreshTransferPanel();
        await loadAccountSessions();
        window.hidePageLoader?.();
    } catch (error) {
        console.error("Auth error:", error);
        window.hidePageLoader?.();
    }
});

document.addEventListener("DOMContentLoaded", () => {
    bindSettingsDropdown();

    const navItems = document.querySelectorAll(".nav-item[data-tab]");
    const panels = document.querySelectorAll(".settings-panel");
    navItems.forEach((btn) => {
        btn.addEventListener("click", () => {
            navItems.forEach((b) => b.classList.remove("active"));
            panels.forEach((p) => p.classList.remove("active"));
            btn.classList.add("active");
            document.getElementById("tab-" + btn.dataset.tab)?.classList.add("active");
        });
    });

    document.querySelectorAll(".theme-card").forEach((card) => {
        card.addEventListener("click", () => {
            document.querySelectorAll(".theme-card").forEach((c) => c.classList.remove("selected"));
            card.classList.add("selected");
        });
    });

    const updatePasswordBtn = document.querySelector("#btn-update-password");
    if (updatePasswordBtn) {
        updatePasswordBtn.addEventListener("click", async () => {
            const emailInput = document.getElementById("settings-change-pass")?.value;
            const currentPass = document.getElementById("currentPass")?.value;
            const user = auth.currentUser;

            updatePasswordBtn.disabled = true;
            updatePasswordBtn.textContent = "Processing...";

            try {
                if (!user) throw new Error("not-logged-in");
                if (!currentPass) throw new Error("empty");
                if (!emailInput) throw new Error("email-empty");
                if (emailInput !== user.email) throw new Error("email-mismatch");

                const credential = firebase.auth.EmailAuthProvider.credential(user.email, currentPass);
                await user.reauthenticateWithCredential(credential);
                await auth.sendPasswordResetEmail(user.email);

                showToast(`Password reset email sent to ${user.email}.`);
                document.getElementById("currentPass").value = "";
                document.getElementById("settings-change-pass").value = "";
            } catch (error) {
                console.error(error);
                if (error.code === "auth/wrong-password") {
                    showToast("Current password incorrect.");
                } else if (error.code === "auth/too-many-requests") {
                    showToast("Too many attempts. Try again later.");
                } else if (error.code === "auth/requires-recent-login") {
                    showToast("Please log in again before changing password.");
                } else if (error.message === "empty") {
                    showToast("Please enter your current password.");
                } else if (error.message === "email-empty") {
                    showToast("Please enter your email.");
                } else if (error.message === "email-mismatch") {
                    showToast("Email does not match your account.");
                } else {
                    showToast("Failed to send password reset email.");
                }
            } finally {
                updatePasswordBtn.disabled = false;
                updatePasswordBtn.textContent = "Send Change Password Email";
            }
        });
    }

    const clearBtn = document.getElementById("btn-clear");
    if (clearBtn) {
        clearBtn.addEventListener("click", () => {
            const emailField = document.getElementById("settings-change-pass");
            const currentPassField = document.getElementById("currentPass");
            if (emailField) emailField.value = "";
            if (currentPassField) currentPassField.value = "";
        });
    }

    document.getElementById("signOutOtherDevicesBtn")?.addEventListener("click", openSignOutDevicesModal);
    document.getElementById("signOutDevicesCancel")?.addEventListener("click", closeSignOutDevicesModal);
    document.getElementById("signOutDevicesConfirm")?.addEventListener("click", confirmSignOutOtherDevices);
    document.getElementById("signOutDevicesModal")?.addEventListener("click", (event) => {
        if (event.target.id === "signOutDevicesModal") {
            closeSignOutDevicesModal();
        }
    });

    const themeRadios = document.querySelectorAll('input[name="theme"]');
    const themeCards = document.querySelectorAll(".theme-card");
    const applyAppearanceBtn = document.getElementById("applyAppearanceBtn");
    const resetAppearanceBtn = document.getElementById("resetAppearanceBtn");

    function updateThemeCardSelection(selectedTheme) {
        themeCards.forEach((card) => {
            const radio = card.querySelector('input[name="theme"]');
            card.classList.toggle("selected", radio && radio.value === selectedTheme);
        });
    }

    const storedTheme = localStorage.getItem("theme");
    const initialTheme = storedTheme === "dark" || storedTheme === "light" ? storedTheme : "light";
    const initialThemeRadio = document.querySelector(`input[name="theme"][value="${initialTheme}"]`);
    if (initialThemeRadio) {
        initialThemeRadio.checked = true;
        updateThemeCardSelection(initialTheme);
    }

    themeRadios.forEach((radio) => {
        radio.addEventListener("change", () => {
            updateThemeCardSelection(radio.value);
        });
    });

    if (applyAppearanceBtn) {
        applyAppearanceBtn.addEventListener("click", () => {
            const selectedTheme = document.querySelector('input[name="theme"]:checked')?.value || "light";
            localStorage.setItem("theme", selectedTheme);
            applyTheme(selectedTheme);
            showToast(`Theme applied: ${selectedTheme}.`);
        });
    }

    if (resetAppearanceBtn) {
        resetAppearanceBtn.addEventListener("click", () => {
            const defaultThemeRadio = document.querySelector('input[name="theme"][value="light"]');
            if (!defaultThemeRadio) return;

            defaultThemeRadio.checked = true;
            updateThemeCardSelection("light");
            localStorage.setItem("theme", "light");
            applyTheme("light");
            showToast("Appearance reset to default.");
        });
    }

    document.getElementById("openCancelBookingBtn")?.addEventListener("click", openCancelBookingModal);
    document.getElementById("cancelBookingModalClose")?.addEventListener("click", closeCancelBookingModal);
    document.getElementById("confirmCancelBookingBtn")?.addEventListener("click", handleTenantBookingCancellation);
    document.getElementById("transferTargetBed")?.addEventListener("change", () => {
        const select = document.getElementById("transferTargetBed");
        const selected = transferBedOptions.find((option) => option.key === select?.value);
        selectedTransferBed = selected || null;
        updateTransferFeePreview();
    });
    document.querySelectorAll(".transfer-type-btn").forEach((button) => {
        button.addEventListener("click", () => setTransferTypeFilter(button.dataset.transferType));
    });
    document.getElementById("refreshTransferBtn")?.addEventListener("click", refreshTransferPanel);
    document.getElementById("submitTransferRequestBtn")?.addEventListener("click", submitTransferRequest);
    document.getElementById("payTransferFeeBtn")?.addEventListener("click", payTransferFee);
    document.getElementById("goToTransferPaymentBtn")?.addEventListener("click", goToTransferPaymentPage);
    document.getElementById("transferConfirmClose")?.addEventListener("click", closeTransferConfirmModal);
    document.getElementById("confirmTransferRequestBtn")?.addEventListener("click", confirmTransferRequestSubmission);
    document.getElementById("cancelBookingModal")?.addEventListener("click", (event) => {
        if (event.target === event.currentTarget) {
            closeCancelBookingModal();
        }
    });
    document.getElementById("transferConfirmModal")?.addEventListener("click", (event) => {
        if (event.target === event.currentTarget) {
            closeTransferConfirmModal();
        }
    });
});

requireAdminAccess();

const bookingsState = {
    rows: [],
    modalData: null,
    pendingActionId: null
};
const BOOKINGS_API_BASE_URL = window.CITIHUB_API_BASE_URL;
const BOOKING_STATUS_TENANT_CANCEL_REQUESTED = "tenant_cancel_requested";
const REQUIRED_DOWN_PAYMENT_AMOUNT = 1000;

document.querySelector(".avatar-container").addEventListener("click", function (event) {
    this.classList.toggle("open");
    event.stopPropagation();
});

document.addEventListener("click", () => {
    document.querySelector(".avatar-container").classList.remove("open");
});

function handleOverlayClick(event) {
    if (event.target === document.getElementById("bookingModal")) {
        closeBookingModal();
    }
}

function capitalize(str) {
    if (!str) {
        return "N/A";
    }

    return str.charAt(0).toUpperCase() + str.slice(1);
}

function formatBookingStatusLabel(status) {
    const normalized = String(status || "").trim().toLowerCase();
    if (normalized === "approved_pending_down_payment") {
        return "Awaiting Down Payment";
    }
    if (normalized === BOOKING_STATUS_TENANT_CANCEL_REQUESTED) {
        return "Cancellation Requested";
    }

    return capitalize(normalized.replace(/_/g, " "));
}

function getEffectiveBookingStatus(data = {}) {
    const normalized = String(data.status || "").trim().toLowerCase();
    const requestStatus = String(data.tenantCancellationRequestStatus || "").trim().toLowerCase();
    if (
        data.tenantCancellationRequested === true
        && ["approved", "approved_pending_down_payment"].includes(normalized)
    ) {
        return BOOKING_STATUS_TENANT_CANCEL_REQUESTED;
    }
    if (
        requestStatus === "pending_review"
        && ["approved", "approved_pending_down_payment"].includes(normalized)
    ) {
        return BOOKING_STATUS_TENANT_CANCEL_REQUESTED;
    }
    return normalized;
}

function formatDate(timestamp) {
    if (!timestamp || typeof timestamp.toDate !== "function") {
        return "N/A";
    }

    return timestamp.toDate().toLocaleString();
}

function formatPeso(amount) {
    return `PHP ${Number(amount || 0).toLocaleString("en-PH", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    })}`;
}

function parseMoneyValue(value) {
    const amount = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
    return Number.isFinite(amount) ? amount : 0;
}

function showToast(msg) {
    const toast = document.getElementById("toast");
    toast.textContent = msg;
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 3000);
}

function getFriendlyBookingsApiError(error, fallbackMessage) {
    if (error?.message === "Failed to fetch") {
        return "Cannot connect to the email server. Please make sure the backend is running, then try again.";
    }

    if (error?.message === "Route not found.") {
        return "The backend is still running an older version. Please restart the CitiHub backend server, then try again.";
    }

    return error?.message || fallbackMessage;
}

function setButtonLoading(button, loadingLabel) {
    if (!button) {
        return;
    }

    if (!button.dataset.originalHtml) {
        button.dataset.originalHtml = button.innerHTML;
    }

    button.disabled = true;
    button.classList.add("btn-loading");
    button.innerHTML = `<span class="btn-loading-spinner" aria-hidden="true"></span><span>${loadingLabel}</span>`;
}

function restoreLoadingButtons(scope = document) {
    scope.querySelectorAll(".btn-loading").forEach((button) => {
        button.disabled = false;
        button.classList.remove("btn-loading");
        if (button.dataset.originalHtml) {
            button.innerHTML = button.dataset.originalHtml;
        }
    });
}

function setBookingActionLoading(actionName) {
    bookingsState.pendingActionId = bookingsState.modalData?.ref || null;

    const footer = document.getElementById("bkModalFooter");
    if (footer) {
        footer.querySelectorAll("button").forEach((button) => {
            const label = button.textContent.trim().toLowerCase();
            if (actionName === "approve" && label.includes("approve")) {
                setButtonLoading(button, "Approving...");
            } else if (actionName === "reject" && label.includes("reject")) {
                setButtonLoading(button, "Rejecting...");
            } else if (actionName === "cancel" && (label.includes("cancel") || label.includes("terminate"))) {
                setButtonLoading(button, "Cancelling...");
            } else if (actionName === "delete" && label.includes("delete")) {
                setButtonLoading(button, "Deleting...");
            } else {
                button.disabled = true;
            }
        });
    }

    const tableRows = document.querySelectorAll("#bookingTableBody tr");
    tableRows.forEach((row) => {
        const cells = row.querySelectorAll(".approve-btn, .reject-btn, .view-btn");
        cells.forEach((button) => {
            const rowRef = row.children?.[4]?.textContent?.trim();
            if (!rowRef) {
                button.disabled = true;
                return;
            }

            if (rowRef === bookingsState.pendingActionId) {
                if (actionName === "approve" && button.classList.contains("approve-btn")) {
                    setButtonLoading(button, "Approving...");
                } else if (actionName === "reject" && button.classList.contains("reject-btn")) {
                    setButtonLoading(button, "Rejecting...");
                } else if (actionName === "cancel" && button.classList.contains("cancel-btn")) {
                    setButtonLoading(button, "Cancelling...");
                } else {
                    button.disabled = true;
                }
            } else {
                button.disabled = true;
            }
        });
    });
}

function clearBookingActionLoading() {
    restoreLoadingButtons(document);
    document.querySelectorAll("#bookingTableBody .approve-btn, #bookingTableBody .reject-btn, #bookingTableBody .view-btn").forEach((button) => {
        button.disabled = false;
    });
    document.querySelectorAll("#bookingTableBody .cancel-btn").forEach((button) => {
        button.disabled = false;
    });
    bookingsState.pendingActionId = null;
}

async function callBookingsApi(path, payload) {
    const user = firebase.auth().currentUser;
    if (!user) {
        throw new Error("You must be signed in to continue.");
    }

    const token = await user.getIdToken();
    const response = await fetch(`${BOOKINGS_API_BASE_URL}${path}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify(payload || {})
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(result.error || "The email service request failed.");
    }

    return result;
}

function formatFileSize(size) {
    if (size >= 1024 * 1024) {
        return `${(size / (1024 * 1024)).toFixed(1)} MB`;
    }

    if (size >= 1024) {
        return `${Math.round(size / 1024)} KB`;
    }

    return `${size || 0} B`;
}

function normalizeFileType(type) {
    if (!type) {
        return "File";
    }

    if (type.includes("pdf")) {
        return "PDF";
    }

    if (type.includes("image/")) {
        return "Image";
    }

    return type;
}

function hasSelfieWithIdDocument(documents = []) {
    return documents.some((doc) => {
        const normalizedLabel = String(doc?.label || "").trim().toLowerCase();
        return normalizedLabel === "selfie holding id" && Array.isArray(doc.files) && doc.files.length > 0;
    });
}

function formatIdentityStatusLabel(status) {
    const normalized = String(status || "pending_review").trim().toLowerCase();
    const labels = {
        pending_review: "Pending Review",
        verified: "Verified",
        needs_clearer_image: "Needs Clearer Image",
        rejected_identity: "Rejected Identity"
    };

    return labels[normalized] || "Pending Review";
}

function getIdentityStatusBadgeClass(status) {
    const normalized = String(status || "pending_review").trim().toLowerCase();

    if (normalized === "verified") {
        return "bk-badge-green";
    }

    if (normalized === "needs_clearer_image") {
        return "bk-badge-teal";
    }

    if (normalized === "rejected_identity") {
        return "bk-badge-purple";
    }

    return "bk-badge-teal";
}

function buildIdentityReviewPayload() {
    const select = document.getElementById("bkIdentityStatus");
    const note = document.getElementById("bkIdentityNote");
    const currentUser = firebase.auth().currentUser;

    return {
        identityVerificationStatus: String(select?.value || "pending_review").trim(),
        identityVerificationNote: String(note?.value || "").trim(),
        identityVerificationReviewedBy: currentUser?.email || currentUser?.uid || "admin"
    };
}

function focusIdentityReviewControls() {
    const identityCard = document.getElementById("bkIdentityCard");
    const identityStatus = document.getElementById("bkIdentityStatus");

    identityCard?.scrollIntoView({ behavior: "smooth", block: "center" });
    identityStatus?.focus();
}

function renderIdentityReview(data) {
    const uploadStateEl = document.getElementById("bkIdentityUploadState");
    const statusBadgeEl = document.getElementById("bkIdentityStatusBadge");
    const reviewedMetaEl = document.getElementById("bkIdentityReviewedMeta");
    const select = document.getElementById("bkIdentityStatus");
    const note = document.getElementById("bkIdentityNote");
    const helperNote = document.getElementById("bkIdentityDecisionNote");
    const hasSelfieUpload = hasSelfieWithIdDocument(data.documents || []);
    const identityStatus = data.identityVerificationStatus || "pending_review";
    const isPending = data.status === "Pending";

    if (uploadStateEl) {
        uploadStateEl.innerHTML = hasSelfieUpload
            ? `<span class="bk-badge bk-badge-green">Uploaded and ready for review</span>`
            : `<span class="bk-badge bk-badge-purple">Missing required selfie with ID</span>`;
    }

    if (statusBadgeEl) {
        statusBadgeEl.innerHTML = `<span class="bk-badge ${getIdentityStatusBadgeClass(identityStatus)}">${formatIdentityStatusLabel(identityStatus)}</span>`;
    }

    if (reviewedMetaEl) {
        const reviewedAt = data.identityVerificationReviewedAt && typeof data.identityVerificationReviewedAt.toDate === "function"
            ? data.identityVerificationReviewedAt.toDate().toLocaleString()
            : "";
        const reviewedBy = String(data.identityVerificationReviewedBy || "").trim();

        reviewedMetaEl.textContent = reviewedAt || reviewedBy
            ? [reviewedBy, reviewedAt].filter(Boolean).join(" | ")
            : "No identity review has been saved yet.";
    }

    if (select) {
        select.value = identityStatus;
        select.disabled = !isPending;
    }

    if (note) {
        note.value = data.identityVerificationNote || "";
        note.readOnly = !isPending;
        note.placeholder = isPending
            ? "Document why the ID submission is accepted, unclear, or rejected."
            : "No identity review note was recorded.";
    }

    if (helperNote) {
        helperNote.textContent = isPending
            ? "Mark identity as Verified before approving the booking request."
            : data.identityVerificationNote
                ? "This is the saved identity review note for this request."
                : "No identity review note has been recorded for this request.";
    }
}

function renderBookingDocuments(documents) {
    const checklist = document.getElementById("bkDocChecklist");
    if (!checklist) {
        return;
    }

    checklist.innerHTML = "";

    if (!documents.length) {
        checklist.innerHTML = `
            <div class="bk-doc-check-item">
                <div class="bk-doc-check-icon">!</div>
                <div class="bk-doc-check-info">
                    <div class="bk-doc-check-name">No uploaded documents found</div>
                    <div class="bk-doc-check-files">The applicant has no saved file uploads on this booking request.</div>
                </div>
            </div>
        `;
        return;
    }

    documents.forEach((doc) => {
        const item = document.createElement("div");
        item.className = "bk-doc-check-item uploaded";

        const icon = document.createElement("div");
        icon.className = "bk-doc-check-icon";
        icon.innerHTML = "&#10004;";

        const info = document.createElement("div");
        info.className = "bk-doc-check-info";

        const name = document.createElement("div");
        name.className = "bk-doc-check-name";
        name.textContent = doc.label || "Document";

        const files = document.createElement("div");
        files.className = "bk-doc-check-files";

        const fileList = document.createElement("div");
        fileList.className = "bk-doc-file-list";

        (doc.files || []).forEach((file) => {
            const link = document.createElement("a");
            link.className = "bk-doc-file-chip";
            link.href = file.url || "#";
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.textContent = `${file.name} (${normalizeFileType(file.type)}, ${formatFileSize(file.size || 0)})`;
            fileList.appendChild(link);
        });

        files.appendChild(fileList);
        info.appendChild(name);
        info.appendChild(files);

        const count = document.createElement("div");
        count.className = "bk-doc-check-count";
        count.textContent = `${(doc.files || []).length} file${(doc.files || []).length === 1 ? "" : "s"}`;

        item.appendChild(icon);
        item.appendChild(info);
        item.appendChild(count);
        checklist.appendChild(item);
    });
}

function normalizeRequestedAddons(addons = []) {
    if (!Array.isArray(addons)) {
        return [];
    }

    return addons.map((addon) => ({
        addonId: String(addon?.addonId || addon?.id || "").trim(),
        addonName: String(addon?.addonName || addon?.name || "Add-on service").trim(),
        price: Number(addon?.price || 0),
        billingType: String(addon?.billingType || "monthly").trim(),
        description: String(addon?.description || "").trim()
    })).filter((addon) => addon.addonName);
}

function renderSelectedAddons(addons = []) {
    const list = document.getElementById("bkSelectedAddons");
    if (!list) {
        return;
    }

    const normalizedAddons = normalizeRequestedAddons(addons);
    list.innerHTML = "";

    if (!normalizedAddons.length) {
        const empty = document.createElement("div");
        empty.className = "bk-addon-item";
        empty.innerHTML = `
            <div>
                <div class="bk-addon-name">No add-ons selected</div>
                <div class="bk-addon-desc">The tenant did not request monthly add-on services with this booking.</div>
            </div>
            <div class="bk-addon-price">${formatPeso(0)}</div>
        `;
        list.appendChild(empty);
        return;
    }

    normalizedAddons.forEach((addon) => {
        const item = document.createElement("div");
        item.className = "bk-addon-item active";

        const info = document.createElement("div");
        const name = document.createElement("div");
        name.className = "bk-addon-name";
        name.textContent = addon.addonName;

        const desc = document.createElement("div");
        desc.className = "bk-addon-desc";
        desc.textContent = addon.description || `${capitalize(addon.billingType || "monthly")} recurring add-on`;

        const price = document.createElement("div");
        price.className = "bk-addon-price";
        price.textContent = `${formatPeso(addon.price)} / ${addon.billingType === "monthly" ? "month" : addon.billingType || "month"}`;

        info.appendChild(name);
        info.appendChild(desc);
        item.appendChild(info);
        item.appendChild(price);
        list.appendChild(item);
    });

    const monthlyTotal = normalizedAddons.reduce((sum, addon) => sum + Number(addon.price || 0), 0);
    const total = document.createElement("div");
    total.className = "bk-addon-total";
    total.innerHTML = `<span>Total Monthly Add-ons</span><span>${formatPeso(monthlyTotal)}</span>`;
    list.appendChild(total);
}

function buildBookingPdf(data) {
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
    pdf.text("CITIHUB Booking Summary", 14, y);
    y += 12;

    pdf.setFontSize(11);
    addLine("Reference", data.ref);
    addLine("Applicant", data.name);
    addLine("Email", data.email);
    addLine("Phone", data.phone);
    addLine("Status", data.status);
    addLine("Room Type", data.roomType);
    addLine("Assigned Bed", data.bedspace);
    addLine("Room", data.floor);
    addLine("Monthly Rate", data.rate);
    addLine("Selected Add-ons", normalizeRequestedAddons(data.requestedAddons).length
        ? normalizeRequestedAddons(data.requestedAddons).map((addon) => `${addon.addonName} (${formatPeso(addon.price)})`).join(", ")
        : "None");
    addLine("Submitted", data.submitted);
    addLine("Emergency Contact", `${data.ecName} (${data.ecRel})`);
    addLine("Emergency Phone", data.ecPhone);
    addLine("Home Address", data.homeAddr);

    pdf.save(`booking_summary_${String(data.ref || "record").replace(/\s+/g, "_")}.pdf`);
}

function downloadCurrentBookingPdf() {
    if (!bookingsState.modalData) {
        return;
    }

    buildBookingPdf(bookingsState.modalData);
}

function openBookingModal(d) {
    bookingsState.modalData = d;

    const init = d.name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
    const sc = d.status === "Approved"
        ? "approved"
        : d.status === "Awaiting Down Payment"
            ? "pending"
            : d.status === "Cancellation Requested"
                ? "pending"
        : d.status === "Rejected"
            ? "overdue"
            : d.status === "Cancelled"
                ? "cancelled"
                : "pending";

    document.getElementById("bkRef").textContent = d.ref;
    document.getElementById("bkAvatar").textContent = init;
    document.getElementById("bkName").textContent = d.name;
    document.getElementById("bkMeta").textContent = `${d.email} | ${d.phone}`;
    document.getElementById("bkStatusWrap").innerHTML = `<span class="status-pill ${sc}">${d.status}</span>`;
    document.getElementById("bkSubmittedLabel").textContent = `${d.requestType || "New Booking"} | Submitted ${d.submitted}`;

    const isPremium = String(d.roomType).toLowerCase().includes("premium");
    document.getElementById("bkRoomTypeBadge").innerHTML = isPremium
        ? `<span class="bk-badge bk-badge-teal">Premium - Aircon Room</span>`
        : `<span class="bk-badge bk-badge-green">Standard Room</span>`;
    document.getElementById("bkBedspace").textContent = d.bedspace;
    document.getElementById("bkRate").textContent = `${d.rate} / month`;
    document.getElementById("bkFloor").textContent = d.floor;

    const gColor =
        d.gender === "Female" ? "bk-badge-purple" :
        d.gender === "Male" ? "bk-badge-teal" :
        "bk-badge-purple";
    document.getElementById("bkGender").innerHTML = `<span class="bk-badge ${gColor}">${d.gender}</span>`;
    document.getElementById("bkPrefDate").textContent = d.requestType === "Renewal" && d.renewalOfReferenceId
        ? `${d.prefDate} (continues ${d.renewalOfReferenceId})`
        : d.prefDate;

    const rateNum = Number(d.monthlyRate || 0) || parseMoneyValue(d.rate);
    const requestedAddons = normalizeRequestedAddons(d.requestedAddons || []);
    const addOnsTotal = requestedAddons.reduce((sum, addon) => sum + Number(addon.price || 0), 0);
    const firstCheckoutTotal = REQUIRED_DOWN_PAYMENT_AMOUNT + addOnsTotal;

    document.getElementById("bkCostRent").textContent = formatPeso(rateNum);
    document.getElementById("bkCostDeposit").textContent = formatPeso(REQUIRED_DOWN_PAYMENT_AMOUNT);
    document.getElementById("bkCostAdvance").textContent = formatPeso(addOnsTotal);
    document.getElementById("bkCostTotal").textContent = formatPeso(firstCheckoutTotal);
    renderSelectedAddons(d.requestedAddons || []);

    document.getElementById("bkFullName").textContent = d.name;
    document.getElementById("bkEmail").textContent = d.email;
    document.getElementById("bkPhone").textContent = d.phone;
    document.getElementById("bkDob").textContent = d.dob;
    document.getElementById("bkHomeAddr").textContent = d.homeAddr;

    document.getElementById("bkEcName").textContent = d.ecName;
    document.getElementById("bkEcRel").textContent = d.ecRel;
    document.getElementById("bkEcPhone").textContent = d.ecPhone;

    document.getElementById("bkAppType").textContent = d.appType;
    renderBookingDocuments(d.documents || []);
    renderIdentityReview(d);
    const rejectionReasonInput = document.getElementById("bkRejectionReason");
    const decisionNote = document.getElementById("bkDecisionNote");
    if (rejectionReasonInput) {
        rejectionReasonInput.value = d.rejectionReason || "";
        rejectionReasonInput.readOnly = d.status !== "Pending";
        rejectionReasonInput.placeholder = d.status === "Pending"
            ? "Enter the reason for rejecting this request."
            : "No rejection reason recorded.";
    }
    if (decisionNote) {
        decisionNote.textContent = d.status === "Pending"
            ? "This note is stored with the booking request for admin reference."
            : d.rejectionReason
                ? "This is the saved rejection reason for this request."
                : "No rejection reason has been recorded for this request.";
    }
    document.getElementById("bkNextSteps").style.display = d.status === "Pending" ? "" : "none";

    const cancellationCard = document.getElementById("bkCancellationCard");
    const cancellationReasonInput = document.getElementById("bkCancellationReason");
    const blockFutureBookingInput = document.getElementById("bkBlockFutureBooking");
    const cancellationNote = document.getElementById("bkCancellationNote");
    if (cancellationCard) {
        cancellationCard.style.display = d.status === "Approved" || d.status === "Awaiting Down Payment" || d.status === "Cancelled" ? "" : "none";
    }
    if (cancellationReasonInput) {
        cancellationReasonInput.value = d.cancellationReason || d.tenantCancellationReason || "";
        cancellationReasonInput.readOnly = !["Approved", "Awaiting Down Payment", "Cancellation Requested"].includes(d.status);
        cancellationReasonInput.placeholder = ["Approved", "Awaiting Down Payment", "Cancellation Requested"].includes(d.status)
            ? "Enter the reason for cancelling or terminating this approved booking."
            : "No cancellation reason recorded.";
    }
    if (blockFutureBookingInput) {
        blockFutureBookingInput.checked = Boolean(d.bookingBlocked);
        blockFutureBookingInput.disabled = !["Approved", "Awaiting Down Payment", "Cancellation Requested"].includes(d.status);
    }
    if (cancellationNote) {
        cancellationNote.textContent = d.status === "Cancellation Requested"
            ? "The tenant already requested cancellation. Finalize this booking only after reviewing any remaining financial obligations."
            : ["Approved", "Awaiting Down Payment"].includes(d.status)
                ? "This reason will be saved on the booking request and sent to the tenant as an admin notification."
            : d.cancellationReason
                ? "This is the saved cancellation reason for this booking."
                : "No cancellation reason has been recorded for this booking.";
    }

    const footer = document.getElementById("bkModalFooter");
    const pdfBtn = `<button onclick="downloadCurrentBookingPdf()" class="bk-footer-btn bk-btn-cancel">&#128196; Download PDF</button>`;

    if (d.status === "Pending") {
        footer.innerHTML = `
            ${pdfBtn}
            <button onclick="closeBookingModal()" class="bk-footer-btn bk-btn-cancel">Close</button>
            <button onclick="rejectBooking()" class="bk-footer-btn bk-btn-reject">Reject Application</button>
            <button onclick="approveBooking()" class="bk-footer-btn bk-btn-approve">Approve &amp; Reserve Bedspace</button>`;
    } else if (d.status === "Rejected" || d.status === "Cancelled") {
        footer.innerHTML = `
            ${pdfBtn}
            <button onclick="closeBookingModal()" class="bk-footer-btn bk-btn-cancel">Close</button>
            <button onclick="deleteBookingPermanently()" class="bk-footer-btn bk-btn-reject">Delete Permanently</button>
        `;
    } else {
        footer.innerHTML = `
            ${pdfBtn}
            <button onclick="closeBookingModal()" class="bk-footer-btn bk-btn-cancel">Close</button>
            <button onclick="cancelApprovedBooking()" class="bk-footer-btn bk-btn-reject">Cancel / Terminate Booking</button>
        `;
    }

    document.getElementById("bookingModal").classList.add("open");
    document.body.style.overflow = "hidden";
}

function closeBookingModal() {
    document.getElementById("bookingModal").classList.remove("open");
    document.body.style.overflow = "";
}

function confirmBookingAction({
    message,
    title = "Confirm Action",
    confirmLabel = "Confirm",
    confirmClass = "bk-btn-reject",
    icon = "&#9888;",
    invoiceCheckbox = false
}) {
    const overlay = document.getElementById("bookingDeleteConfirm");
    const titleEl = document.getElementById("bkConfirmTitle");
    const iconEl = document.querySelector("#bookingDeleteConfirm .bk-confirm-icon");
    const text = document.getElementById("bkConfirmText");
    const cancelBtn = document.getElementById("bkConfirmCancel");
    const confirmBtn = document.getElementById("bkConfirmDelete");
    const invoiceOption = document.getElementById("bkConfirmInvoiceOption");
    const invoiceCheckboxInput = document.getElementById("bkConfirmDeleteInvoices");

    if (!overlay || !text || !cancelBtn || !confirmBtn) {
        const confirmed = window.confirm(message);
        return Promise.resolve(invoiceCheckbox ? { confirmed, deleteBillingInvoices: false } : confirmed);
    }

    const originalTitle = titleEl?.textContent || "";
    const originalIcon = iconEl?.innerHTML || "";
    const originalConfirmText = confirmBtn.textContent;
    const originalConfirmClass = confirmBtn.className;

    if (titleEl) {
        titleEl.textContent = title;
    }
    if (iconEl) {
        iconEl.innerHTML = icon;
    }
    text.textContent = message;
    confirmBtn.textContent = confirmLabel;
    confirmBtn.className = `bk-footer-btn ${confirmClass}`;
    if (invoiceOption && invoiceCheckboxInput) {
        invoiceOption.style.display = invoiceCheckbox ? "flex" : "none";
        invoiceCheckboxInput.checked = false;
    }
    overlay.classList.add("open");

    return new Promise((resolve) => {
        const close = (result) => {
            const deleteBillingInvoices = Boolean(invoiceCheckboxInput?.checked);
            overlay.classList.remove("open");
            cancelBtn.removeEventListener("click", handleCancel);
            confirmBtn.removeEventListener("click", handleConfirm);
            overlay.removeEventListener("click", handleOverlay);
            document.removeEventListener("keydown", handleKeydown);
            if (invoiceOption && invoiceCheckboxInput) {
                invoiceOption.style.display = "none";
                invoiceCheckboxInput.checked = false;
            }
            if (titleEl) {
                titleEl.textContent = originalTitle;
            }
            if (iconEl) {
                iconEl.innerHTML = originalIcon;
            }
            confirmBtn.textContent = originalConfirmText;
            confirmBtn.className = originalConfirmClass;
            resolve(invoiceCheckbox ? { confirmed: result, deleteBillingInvoices: result && deleteBillingInvoices } : result);
        };

        const handleCancel = () => close(false);
        const handleConfirm = () => close(true);
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
        confirmBtn.addEventListener("click", handleConfirm);
        overlay.addEventListener("click", handleOverlay);
        document.addEventListener("keydown", handleKeydown);
        confirmBtn.focus();
    });
}

function confirmPermanentDelete(message) {
    return confirmBookingAction({
        title: "Delete Booking Permanently?",
        message,
        confirmLabel: "Delete Permanently",
        confirmClass: "bk-btn-reject",
        icon: "&#9888;",
        invoiceCheckbox: true
    });
}

async function approveBookingHandler(id) {
    try {
        const identityReview = buildIdentityReviewPayload();

        if (identityReview.identityVerificationStatus !== "verified") {
            showToast("Set Identity Review Status to Verified before approving this booking.");
            focusIdentityReviewControls();
            return;
        }

        setBookingActionLoading("approve");
        const result = await callBookingsApi("/api/bookings/admin/approve", {
            bookingRequestId: id,
            ...identityReview
        });

        closeBookingModal();
        showToast(result.emailSent === false
            ? "Booking approved and awaiting down payment. Email notification could not be sent."
            : "Booking approved, bedspace reserved pending down payment, and email sent.");
        await loadBookings();
    } catch (error) {
        console.error("Approve booking failed:", error);
        showToast(`Approval failed: ${getFriendlyBookingsApiError(error, "Please try again.")}`);
    } finally {
        clearBookingActionLoading();
    }
}



async function rejectBookingHandler(id) {
    try {
        const reasonInput = document.getElementById("bkRejectionReason");
        const rejectionReason = String(reasonInput?.value || "").trim();
        const identityReview = buildIdentityReviewPayload();

        if (!rejectionReason) {
            showToast("Please enter a rejection reason before rejecting this request.");
            reasonInput?.focus();
            return;
        }

        setBookingActionLoading("reject");
        const result = await callBookingsApi("/api/bookings/admin/reject", {
            bookingRequestId: id,
            rejectionReason,
            ...identityReview
        });

        closeBookingModal();
        showToast(result.emailSent === false
            ? "Booking rejected. Email notification could not be sent."
            : "Booking rejected and email sent.");
        await loadBookings();
    } catch (error) {
        console.error("Reject booking failed:", error);
        showToast(`Rejection failed: ${getFriendlyBookingsApiError(error, "Please try again.")}`);
    } finally {
        clearBookingActionLoading();
    }
}

async function cancelApprovedBookingHandler(id) {
    try {
        const reasonInput = document.getElementById("bkCancellationReason");
        const blockFutureBooking = Boolean(document.getElementById("bkBlockFutureBooking")?.checked);
        const cancellationReason = String(reasonInput?.value || "").trim();

        if (!cancellationReason) {
            showToast("Please enter a cancellation reason before terminating this booking.");
            reasonInput?.focus();
            return;
        }

        const confirmed = await confirmBookingAction({
            title: "Cancel Approved Booking?",
            message: blockFutureBooking
                ? "This will cancel the approved booking, release the reserved bedspace, block this tenant account from future bedspace bookings, and notify the tenant."
                : "This will cancel the approved booking, release the reserved bedspace, reset the tenant account to registered status, cancel pending checkout records, and notify the tenant.",
            confirmLabel: "Cancel Booking",
            confirmClass: "bk-btn-reject",
            icon: "&#9888;"
        });

        if (!confirmed) {
            return;
        }

        setBookingActionLoading("cancel");

        await callBookingsApi("/api/bookings/admin/cancel", {
            bookingRequestId: id,
            cancellationReason,
            blockFutureBooking
        });

        closeBookingModal();
        showToast(blockFutureBooking
            ? "Booking cancelled, bedspace released, tenant blocked from future bookings, and tenant notified."
            : "Approved booking cancelled, bedspace released, and tenant notified.");
        await loadBookings();
    } catch (error) {
        console.error("Cancel approved booking failed:", error);
        showToast(`Cancellation failed: ${error.message || "Please try again."}`);
    } finally {
        clearBookingActionLoading();
    }
}

async function deleteBookingPermanentlyHandler(id) {
    try {
        const normalizedStatus = String(bookingsState.modalData?.status || "").toLowerCase();
        const deleteChoice = await confirmPermanentDelete(
            `Delete this ${normalizedStatus} booking permanently? This will also remove the applicant's uploaded documents from Firebase Storage and cannot be undone.`
        );
        if (!deleteChoice.confirmed) {
            return;
        }

        setBookingActionLoading("delete");
        const result = await callBookingsApi("/api/bookings/admin/delete", {
            bookingRequestId: id,
            deleteBillingInvoices: deleteChoice.deleteBillingInvoices
        });

        closeBookingModal();
        showToast(result.deletedBillingInvoices
            ? `Booking request, uploaded documents, and ${result.deletedBillingInvoices} billing invoice(s) were deleted permanently.`
            : "Booking request and uploaded documents were deleted permanently.");
        await loadBookings();
    } catch (error) {
        console.error("Permanent booking delete failed:", error);
        showToast(`Delete failed: ${error.message}`);
    } finally {
        clearBookingActionLoading();
    }
}

function filterBookings() {
    const search = String(document.getElementById("bookingSearch")?.value || "").trim().toLowerCase();
    const status = document.getElementById("bookingFilter")?.value || "all";
    const type = document.getElementById("bookingTypeFilter")?.value || "all";

    bookingsState.rows.forEach((rowData) => {
        const matchesSearch = !search || rowData.searchText.includes(search);
        const matchesStatus = status === "all" || rowData.status === status;
        const matchesType = type === "all" || rowData.type === type;

        rowData.element.style.display = matchesSearch && matchesStatus && matchesType ? "" : "none";
    });
}

function downloadReport(label) {
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: "landscape" });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    let y = 38;
    const visibleRows = bookingsState.rows.filter((row) => row.element.style.display !== "none");

    pdf.setFillColor(26, 122, 74);
    pdf.rect(0, 0, pageWidth, 28, "F");
    pdf.setTextColor(255, 255, 255);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(16);
    pdf.text("CITIHUB DORMITORY", 14, 13);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(10);
    pdf.text(`${label} Report`, 14, 21);
    pdf.setTextColor(26, 26, 46);

    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(10);
    pdf.text(`Generated: ${new Date().toLocaleString()}`, 14, y); y += 8;
    pdf.text(`Visible bookings: ${visibleRows.length}`, 14, y); y += 12;

    pdf.setFont("helvetica", "bold");
    pdf.text("Applicant", 14, y);
    pdf.text("Type", 72, y);
    pdf.text("Bedspace", 108, y);
    pdf.text("Status", 152, y);
    pdf.text("Email", 190, y);
    y += 6;
    pdf.setDrawColor(229, 231, 235);
    pdf.line(14, y, pageWidth - 14, y);
    y += 7;
    pdf.setFont("helvetica", "normal");

    visibleRows.forEach((row) => {
        pdf.text(String(row.fullName || "Applicant").slice(0, 30), 14, y);
        pdf.text(String(capitalize(row.type)).slice(0, 16), 72, y);
        pdf.text(`Room ${row.room || "N/A"} Bed ${row.bed || "N/A"}`.slice(0, 24), 108, y);
        pdf.text(String(row.status || "N/A").slice(0, 18), 152, y);
        pdf.text(String(row.email || "").slice(0, 42), 190, y);
        y += 7;

        if (y > pageHeight - 18) {
            pdf.addPage();
            y = 18;
        }
    });

    pdf.setFontSize(8);
    pdf.setTextColor(107, 114, 128);
    pdf.text("Generated by CitiHub Admin Bookings", 14, pageHeight - 8);
    pdf.save(`${label.replace(/\s+/g, "_").toLowerCase()}_report.pdf`);
}

async function loadBookings() {
    const tbody = document.getElementById("bookingTableBody");
    const badge = document.querySelector('.sidebar-nav a[href="bookings.html"] .nav-badge');
    const pendingStat = document.querySelector('.stats-grid .stat-card:first-child .stat-value');
    const approvedStat = document.querySelector('.stats-grid .stat-card:nth-child(2) .stat-value');
    const rejectedStat = document.querySelector('.stats-grid .stat-card:nth-child(3) .stat-value');
    tbody.innerHTML = "";
    bookingsState.rows = [];

    const snapshot = await db.collection("bookingRequest").orderBy("createdAt", "desc").get();
    let pendingCount = 0;
    let approvedThisMonthCount = 0;
    let rejectedCount = 0;
    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();

    snapshot.forEach((doc) => {
        const data = doc.data();
        const id = doc.id;
        const effectiveStatus = getEffectiveBookingStatus(data);

        if (data.status === "pending") {
            pendingCount += 1;
        }

        if (data.status === "approved" || data.status === "approved_pending_down_payment") {
            const createdAt = data.createdAt && typeof data.createdAt.toDate === "function"
                ? data.createdAt.toDate()
                : null;

            if (createdAt && createdAt.getMonth() === currentMonth && createdAt.getFullYear() === currentYear) {
                approvedThisMonthCount += 1;
            }
        }

        if (data.status === "rejected") {
            rejectedCount += 1;
        }

        const fullName = `${data.firstName || ""} ${data.lastName || ""}`.trim();
        const initials = `${data.firstName?.[0] || ""}${data.lastName?.[0] || ""}`.toUpperCase();
        const isRenewal = data.isRenewal === true || data.requestType === "renewal";
        const typeLabel = `${capitalize(data.type)}${isRenewal ? " Renewal" : ""}`;
        const statusClass =
            effectiveStatus === "approved" ? "approved" :
            effectiveStatus === "approved_pending_down_payment" ? "pending" :
            effectiveStatus === BOOKING_STATUS_TENANT_CANCEL_REQUESTED ? "pending" :
            effectiveStatus === "rejected" ? "overdue" :
            effectiveStatus === "cancelled" ? "cancelled" :
            "pending";
        const statusLabel = formatBookingStatusLabel(effectiveStatus);

        const row = document.createElement("tr");
        row.dataset.status = effectiveStatus || "";
        row.dataset.type = String(data.type || "").toLowerCase();

        row.innerHTML = `
            <td>
                <div class="td-tenant">
                    <div class="td-avatar amber">${initials}</div>
                    <div>
                        <div class="td-name">${fullName}</div>
                        <div class="td-email">${data.email || ""}</div>
                    </div>
                </div>
            </td>
            <td>${typeLabel}</td>
            <td>Room ${data.room || "N/A"} - Bed ${data.bed || "N/A"}</td>
            <td>${formatDate(data.createdAt)}</td>
            <td>${data.referenceId || id}</td>
            <td>
                <span class="status-pill ${statusClass}">
                    ${statusLabel}
                </span>
            </td>
            <td class="action-btns">
                <button class="tbl-btn view-btn">View</button>
                ${
                    data.status === "pending"
                        ? `
                    <button class="tbl-btn approve-btn">Approve</button>
                    <button class="tbl-btn reject-btn">Reject</button>
                    `
                        : ["approved", "approved_pending_down_payment"].includes(data.status)
                            ? `<button class="tbl-btn danger cancel-btn">Cancel</button>`
                        : ""
                }
            </td>
        `;

        const modalData = {
            ref: data.referenceId || id,
            name: fullName,
            email: data.email || "",
            phone: data.phone || "",
            status: statusLabel,
            rawStatus: data.status || "",
            submitted: formatDate(data.createdAt),
            roomType: data.type === "premium" ? "Premium" : "Standard",
            requestType: isRenewal ? "Renewal" : "New Booking",
            renewalOfReferenceId: data.renewalOfReferenceId || "",
            bedspace: data.bed || "N/A",
            rate: data.leasePrice || "N/A",
            monthlyRate: Number(data.monthlyRate || 0),
            floor: data.room || "N/A",
            gender: data.gender || "N/A",
            prefDate: data.moveInDate || data.preferredDate || "Not specified",
            dob: data.birthDate || "N/A",
            homeAddr: data.address || "N/A",
            ecName: data.emergencyName || "N/A",
            ecRel: data.relationship || "N/A",
            ecPhone: data.emergencyPhone || "N/A",
            appType: capitalize(String(data.applicantType || "").replace("type-", "")),
            userId: data.userId || "",
            documents: data.documents || [],
            requestedAddons: data.requestedAddons || [],
            rejectionReason: data.rejectionReason || "",
            cancellationReason: data.cancellationReason || "",
            tenantCancellationRequested: Boolean(data.tenantCancellationRequested),
            tenantCancellationReason: data.tenantCancellationReason || "",
            cancelledBy: data.cancelledBy || "",
            bookingBlocked: Boolean(data.bookingBlocked),
            identityVerificationStatus: data.identityVerificationStatus || "pending_review",
            identityVerificationNote: data.identityVerificationNote || "",
            identityVerificationReviewedAt: data.identityVerificationReviewedAt || null,
            identityVerificationReviewedBy: data.identityVerificationReviewedBy || ""
        };

        row.querySelector(".view-btn").addEventListener("click", () => {
            openBookingModal(modalData);
            window.approveBooking = () => approveBookingHandler(id);
            window.rejectBooking = () => rejectBookingHandler(id);
            window.deleteBookingPermanently = () => deleteBookingPermanentlyHandler(id);
            window.cancelApprovedBooking = () => cancelApprovedBookingHandler(id);
        });

        const approveBtn = row.querySelector(".approve-btn");
        if (approveBtn) {
            approveBtn.addEventListener("click", () => {
                openBookingModal(modalData);
                window.approveBooking = () => approveBookingHandler(id);
                window.rejectBooking = () => rejectBookingHandler(id);
                window.deleteBookingPermanently = () => deleteBookingPermanentlyHandler(id);
                window.cancelApprovedBooking = () => cancelApprovedBookingHandler(id);
                showToast("Review the identity documents, mark Identity Review Status as Verified, then approve.");
                setTimeout(focusIdentityReviewControls, 0);
            });
        }

        const rejectBtn = row.querySelector(".reject-btn");
        if (rejectBtn) {
            rejectBtn.addEventListener("click", () => {
                openBookingModal(modalData);
                window.approveBooking = () => approveBookingHandler(id);
                window.rejectBooking = () => rejectBookingHandler(id);
                window.deleteBookingPermanently = () => deleteBookingPermanentlyHandler(id);
                window.cancelApprovedBooking = () => cancelApprovedBookingHandler(id);
                document.getElementById("bkRejectionReason")?.focus();
            });
        }

        const cancelBtn = row.querySelector(".cancel-btn");
        if (cancelBtn) {
            cancelBtn.addEventListener("click", () => {
                openBookingModal(modalData);
                window.approveBooking = () => approveBookingHandler(id);
                window.rejectBooking = () => rejectBookingHandler(id);
                window.deleteBookingPermanently = () => deleteBookingPermanentlyHandler(id);
                window.cancelApprovedBooking = () => cancelApprovedBookingHandler(id);
                document.getElementById("bkCancellationReason")?.focus();
            });
        }

        tbody.appendChild(row);
        bookingsState.rows.push({
            element: row,
            id,
            fullName,
            email: data.email || "",
            room: data.room || "",
            bed: data.bed || "",
            status: effectiveStatus || "",
            type: String(data.type || "").toLowerCase(),
            searchText: `${fullName} ${data.email || ""} ${data.room || ""} ${data.bed || ""} ${data.referenceId || id} ${statusLabel} ${data.tenantCancellationReason || ""}`.toLowerCase()
        });
    });

    if (badge) {
        badge.textContent = String(pendingCount);
        badge.style.display = pendingCount > 0 ? "inline-flex" : "none";
    }

    if (pendingStat) {
        pendingStat.textContent = String(pendingCount);
    }

    if (approvedStat) {
        approvedStat.textContent = String(approvedThisMonthCount);
    }

    if (rejectedStat) {
        rejectedStat.textContent = String(rejectedCount);
    }

    filterBookings();
}

document.getElementById("stat-date-approved").textContent =
    "As of " + new Date().toLocaleDateString("en-US", { month: "short", year: "numeric" });
document.getElementById("stat-date-rejected").textContent =
    "As of " + new Date().toLocaleDateString("en-US", { month: "short", year: "numeric" });

loadBookings();

document.querySelectorAll("#btnLogout").forEach((button) => {
    button.addEventListener("click", logoutAdmin);
});

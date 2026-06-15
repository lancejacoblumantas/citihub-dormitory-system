let currentUser = null;
let userData = null;
const requestIdFromUrl = new URLSearchParams(window.location.search).get("requestId");
const submitMode = new URLSearchParams(window.location.search).get("mode");
const submitType = new URLSearchParams(window.location.search).get("type");
let isSubmittingRequest = false;
const REQUIRED_DOWN_PAYMENT = 1000;
let bookingRestrictionReason = "";
const SUBMIT_API_FALLBACK_BASE_URL = "http://localhost:4000";

function hasDraftBookingData() {
  return Boolean(sessionStorage.getItem("bookingData") || sessionStorage.getItem("transientBookingData"));
}

function getSubmitApiBaseUrl() {
  return window.CITIHUB_API_BASE_URL || SUBMIT_API_FALLBACK_BASE_URL;
}

async function postSubmitApi(path, token, payload) {
  const requestOptions = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify(payload || {})
  };

  const targets = [...new Set([
    `${getSubmitApiBaseUrl()}${path}`,
    `${SUBMIT_API_FALLBACK_BASE_URL}${path}`
  ])];

  let lastError = null;

  for (const url of targets) {
    try {
      return await fetch(url, requestOptions);
    } catch (error) {
      lastError = error;
      console.error(`Submit API request failed for ${url}:`, error);
    }
  }

  throw lastError || new Error("Unable to reach the booking server.");
}

function isTransientSubmitMode() {
  const hasMonthlyBooking = Boolean(sessionStorage.getItem("bookingData"));

  if (submitMode === "transient" || submitType === "transient") {
    return true;
  }

  return !hasMonthlyBooking && Boolean(sessionStorage.getItem("transientBookingData"));
}

function normalizeApplicantType(value) {
  return String(value || "").replace(/^type-/, "").toLowerCase();
}

function normalizeRequestedAddons(addons = []) {
  if (!Array.isArray(addons)) {
    return [];
  }

  return addons.map((addon) => ({
    addonId: String(addon?.addonId || addon?.id || "").trim().toLowerCase(),
    addonName: String(addon?.addonName || addon?.name || "").trim(),
    price: Number(addon?.price || 0),
    billingType: String(addon?.billingType || "monthly").trim().toLowerCase(),
    description: String(addon?.description || "").trim()
  })).filter((addon) => addon.addonId && addon.addonName);
}

function getDraftReferenceId() {
  const storageKey = isTransientSubmitMode() ? "transientDraftReferenceId" : "bookingDraftReferenceId";
  const existingReferenceId = sessionStorage.getItem(storageKey);

  if (existingReferenceId) {
    return existingReferenceId;
  }

  const referenceId = isTransientSubmitMode() ? generateTransientRefID() : generateRefID();
  sessionStorage.setItem(storageKey, referenceId);
  return referenceId;
}

firebase.auth().onAuthStateChanged(async (user) => {
  if (!user) {
    window.location.href = "intro.html";
    return;
  }

  currentUser = user;

  const emailEl = document.getElementById("email");
  if (emailEl) emailEl.textContent = user.email;

  try {
    const doc = await db.collection("users").doc(user.uid).get();

    if (doc.exists) {
      userData = doc.data();

      const genderEl = document.querySelector(".badge-purple");
      if (genderEl) {
        genderEl.textContent =
          capitalizeFirstLetter(userData.gender || "Not specified");
      }
    }
  } catch (err) {
    console.error("Error loading user:", err);
  }

  if (requestIdFromUrl) {
    if (submitType === "transient") {
      await loadExistingTransientRequest(requestIdFromUrl);
    } else {
      await loadExistingRequest(requestIdFromUrl);
    }
    window.hidePageLoader?.();
    return;
  }

  await protectPage();
  loadPageData();
  window.hidePageLoader?.();
});

document.addEventListener("DOMContentLoaded", () => {
  const el = document.getElementById("submitDate");
  if (el) {
    const d = new Date();
    el.textContent = d.toLocaleDateString("en-PH", {
      year: "numeric", month: "long", day: "numeric"
    });
  }
});

function toggleSubmit() {
  const checked = document.getElementById("agree-terms").checked;
  document.getElementById("submitBtn").disabled = !checked;
}

function loadPageData() {
  const data = JSON.parse(sessionStorage.getItem("tenantData"));
  const bookingData = JSON.parse(sessionStorage.getItem(isTransientSubmitMode() ? "transientBookingData" : "bookingData"));
  const documentsState = JSON.parse(sessionStorage.getItem("documentsData"));

  if (!data || !bookingData) {
    window.hidePageLoader?.();
    return;
  }

  setDraftMode(isTransientSubmitMode());
  populateSummary({
    referenceId: "Draft",
    createdAt: new Date(),
    status: "pending",
    email: currentUser?.email || "",
    gender: userData?.gender || "Not specified",
    firstName: data.firstName,
    lastName: data.lastName,
    phone: data.phone,
    birthDate: data.birthDate,
    address: data.address,
    emergencyName: data.emergencyName,
    relationship: data.relationship,
    emergencyPhone: data.emergencyPhone,
    emergencyAlt: data.emergencyAlt || "Not provided",
    emergencyAddress: data.emergencyAddress,
    applicantType: normalizeApplicantType(data.applicantType),
    room: bookingData.room,
    bed: bookingData.bed,
    type: bookingData.type || bookingData.roomType,
    contractType: bookingData.contractType || bookingData.type || bookingData.roomType || "",
    contractTerm: bookingData.contractTerm || "",
    contractLabel: bookingData.contractLabel || bookingData.leaseLabel || "",
    contractMonths: Number(bookingData.contractMonths || 0),
    monthlyRate: Number(bookingData.monthlyRate || parseCurrency(bookingData.leasePrice) || 0),
    leasePrice: bookingData.leasePrice || `P${Number(bookingData.ratePerDay || 0).toFixed(2)}`,
    moveInDate: bookingData.moveInDate || bookingData.checkInDate || "",
    moveInTime: bookingData.moveInTime || "",
    checkOutDate: bookingData.checkOutDate || "",
    nights: bookingData.nights || 0,
    totalAmount: bookingData.totalAmount || 0,
    isTransient: isTransientSubmitMode(),
    requestedAddons: normalizeRequestedAddons(data.requestedAddons || bookingData.requestedAddons || []),
    documents: documentsState?.documents || []
  });
}

function goToFillupEdit() {
  window.location.href = isTransientSubmitMode() ? "fillup.html?mode=transient" : "fillup.html";
}

function goToBookingEdit() {
  window.location.href = isTransientSubmitMode() ? "transient-bed.html" : "booking.html";
}

async function handleSubmit() {
  if (!document.getElementById("agree-terms").checked || isSubmittingRequest) return;

  isSubmittingRequest = true;

  const data = JSON.parse(sessionStorage.getItem("tenantData"));
  const bookingData = JSON.parse(sessionStorage.getItem(isTransientSubmitMode() ? "transientBookingData" : "bookingData"));
  const documentsState = JSON.parse(sessionStorage.getItem("documentsData"));
  const submitButton = document.getElementById("submitBtn");
  const originalButtonMarkup = submitButton ? submitButton.innerHTML : "";
  let submittedSuccessfully = false;

  if (!data || !bookingData || !currentUser) {
    console.error("Missing data");
    alert("Your draft booking details are incomplete. Please go back to the previous steps and review your application.");
    isSubmittingRequest = false;
    return;
  }

  if (submitButton) {
    submitButton.disabled = true;
    submitButton.innerHTML = `<span class="submit-btn-icon">&#8635;</span> Checking Request...`;
  }

  let allowed = true;
  try {
    allowed = isTransientSubmitMode()
      ? await canUserSubmitTransientRequest(currentUser.uid)
      : await canUserRequest(currentUser.uid);
  } catch (error) {
    console.error("Pre-submit request check failed, proceeding to server validation:", error);
    allowed = true;
  }
  if (!allowed) {
    alert(bookingRestrictionReason || "You already have a pending or approved request.");
    isSubmittingRequest = false;
    if (submitButton) {
      submitButton.innerHTML = originalButtonMarkup;
      submitButton.disabled = !document.getElementById("agree-terms")?.checked;
    }
    return;
  }

  const refID = getDraftReferenceId();

  try {
    if (submitButton) {
      submitButton.innerHTML = `<span class="submit-btn-icon">&#8635;</span> Uploading Documents...`;
    }

    const uploadedDocuments = await uploadDraftDocumentsToStorage(
      currentUser.uid,
      refID,
      documentsState?.documents || []
    );

    if (isTransientSubmitMode()) {
      await submitTransientRequest({
        refID,
        data,
        bookingData,
        documents: uploadedDocuments
      });
    } else {
      await submitMonthlyBookingRequest({
        refID,
        data,
        bookingData,
        documents: uploadedDocuments
      });
    }

    document.querySelector(".modal-ref").textContent = "Reference #" + refID;
    const submittedFirstName = document.getElementById("submittedFirstName");
    if (submittedFirstName) {
      submittedFirstName.textContent = data.firstName || userData?.firstName || "Tenant";
    }
    document.getElementById("success-modal").style.display = "flex";

    sessionStorage.removeItem("tenantData");
    sessionStorage.removeItem("bookingData");
    sessionStorage.removeItem("transientBookingData");
    sessionStorage.removeItem("documentsData");
    sessionStorage.removeItem("bookingDraftReferenceId");
    sessionStorage.removeItem("transientDraftReferenceId");
    submittedSuccessfully = true;
  } catch (error) {
    console.error("Error:", error);
    alert("We were unable to submit your application at this time. Please try again.");
  } finally {
    if (!submittedSuccessfully) {
      isSubmittingRequest = false;
    }
    if (submitButton && !submittedSuccessfully) {
      submitButton.innerHTML = originalButtonMarkup;
      submitButton.disabled = !document.getElementById("agree-terms")?.checked;
    }
  }
}

async function submitMonthlyBookingRequest({ refID, data, bookingData, documents }) {
  const token = await currentUser.getIdToken();
  const response = await postSubmitApi("/api/bookings/create", token, {
    referenceId: refID,
    firstName: data.firstName,
    lastName: data.lastName,
    phone: data.phone,
    birthDate: data.birthDate,
    address: data.address,
    emergencyName: data.emergencyName,
    relationship: data.relationship,
    emergencyPhone: data.emergencyPhone,
    emergencyAlt: data.emergencyAlt,
    emergencyAddress: data.emergencyAddress,
    applicantType: normalizeApplicantType(data.applicantType),
    room: bookingData.room,
    bed: bookingData.bed,
    type: bookingData.type,
    contractType: bookingData.contractType || bookingData.type || "",
    contractTerm: bookingData.contractTerm || "",
    contractLabel: bookingData.contractLabel || bookingData.leaseLabel || "",
    contractMonths: Number(bookingData.contractMonths || 0),
    monthlyRate: Number(bookingData.monthlyRate || parseCurrency(bookingData.leasePrice) || 0),
    leasePrice: bookingData.leasePrice,
    moveInDate: bookingData.moveInDate || "",
    moveInTime: bookingData.moveInTime || "",
    requestedAddons: normalizeRequestedAddons(data.requestedAddons || bookingData.requestedAddons || []),
    documents
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error || "Unable to submit booking request.");
  }

  return result;
}

async function submitTransientRequest({ refID, data, bookingData, documents }) {
  const token = await currentUser.getIdToken();
  const response = await postSubmitApi("/api/transient-beds/create", token, {
    referenceId: refID,
    roomType: bookingData.roomType || bookingData.type,
    room: bookingData.room,
    bed: bookingData.bed,
    checkInDate: bookingData.checkInDate,
    checkOutDate: bookingData.checkOutDate,
    phone: data.phone || bookingData.phone || "",
    firstName: data.firstName,
    lastName: data.lastName,
    birthDate: data.birthDate,
    address: data.address,
    emergencyName: data.emergencyName,
    relationship: data.relationship,
    emergencyPhone: data.emergencyPhone,
    emergencyAlt: data.emergencyAlt,
    emergencyAddress: data.emergencyAddress,
    applicantType: normalizeApplicantType(data.applicantType),
    documents
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error || "Unable to submit Transient Bed request.");
  }

  return result;
}

async function canUserRequest(userId) {
  const userSnap = await db.collection("users").doc(userId).get();
  if (userSnap.exists && userSnap.data()?.bookingBlocked === true) {
    bookingRestrictionReason = userSnap.data()?.bookingBlockedReason
      ? `Your account is no longer allowed to book a bedspace. Reason: ${userSnap.data().bookingBlockedReason}`
      : "Your account is no longer allowed to book a bedspace. Please contact CitiHub management for assistance.";
    return false;
  }

  const snapshot = await db.collection("bookingRequest")
    .where("userId", "==", userId)
    .where("status", "in", ["pending", "approved"])
    .limit(1)
    .get();

  if (!snapshot.empty) {
    bookingRestrictionReason = "You already have a pending or approved request.";
    return false;
  }

  const transientSnapshot = await db.collection("transientBedBookings")
    .where("userId", "==", userId)
    .get();
  const hasActiveTransientBed = transientSnapshot.docs.some((doc) => {
    return ["pending_payment", "pending", "approved", "checked_in"].includes(doc.data().status);
  });

  bookingRestrictionReason = hasActiveTransientBed
    ? "You already have an active Transient Bed request, so monthly booking is temporarily disabled."
    : "";
  return !hasActiveTransientBed;
}

async function canUserSubmitTransientRequest(userId) {
  const userSnap = await db.collection("users").doc(userId).get();
  if (userSnap.exists && userSnap.data()?.bookingBlocked === true) {
    bookingRestrictionReason = userSnap.data()?.bookingBlockedReason
      ? `Your account is no longer allowed to book a bedspace. Reason: ${userSnap.data().bookingBlockedReason}`
      : "Your account is no longer allowed to book a bedspace. Please contact CitiHub management for assistance.";
    return false;
  }

  const transientSnapshot = await db.collection("transientBedBookings")
    .where("userId", "==", userId)
    .get();
  const hasActiveTransientBed = transientSnapshot.docs.some((doc) => {
    return ["pending_payment", "pending", "approved", "checked_in"].includes(doc.data().status);
  });

  bookingRestrictionReason = hasActiveTransientBed
    ? "You already have an active Transient Bed request."
    : "";
  return !hasActiveTransientBed;
}

async function protectPage() {
  if (hasDraftBookingData()) {
    return;
  }

  const allowed = isTransientSubmitMode()
    ? await canUserSubmitTransientRequest(currentUser.uid)
    : await canUserRequest(currentUser.uid);
  if (!allowed) {
    window.location.href = "main.html";
  }
}

async function loadExistingRequest(requestId) {
  try {
    const doc = await db.collection("bookingRequest").doc(requestId).get();

    if (!doc.exists) {
      window.location.href = "main.html";
      return;
    }

    const data = doc.data();
    if (data.userId !== currentUser.uid) {
      window.location.href = "main.html";
      return;
    }

    if (data.status === "rejected") {
      applyRejectedRevisionMode(data, doc.id);
    } else {
      applyReadOnlyMode();
    }
    populateSummary({
      ...data,
      referenceId: data.referenceId || doc.id,
      documents: data.documents || []
    });
  } catch (error) {
    console.error("Error loading request:", error);
    window.location.href = "main.html";
  }
}

function applyRejectedRevisionMode(data, requestId) {
  const referenceId = data.referenceId || requestId;
  const applicantType = normalizeApplicantType(data.applicantType);
  const tenantData = {
    firstName: data.firstName || "",
    lastName: data.lastName || "",
    email: data.email || currentUser?.email || "",
    gender: data.gender || userData?.gender || "",
    phone: data.phone || "",
    birthDate: data.birthDate || "",
    address: data.address || "",
    emergencyName: data.emergencyName || "",
      relationship: data.relationship || "",
      emergencyPhone: data.emergencyPhone || "",
      emergencyAlt: data.emergencyAlt || "",
      emergencyAddress: data.emergencyAddress || "",
      applicantType,
      requestedAddons: normalizeRequestedAddons(data.requestedAddons || [])
  };
  const bookingData = {
    room: data.room || "",
    bed: data.bed || "",
    type: data.type || "",
    contractType: data.contractType || data.type || "",
    contractTerm: data.contractTerm || "",
    contractLabel: data.contractLabel || data.leaseLabel || "",
    contractMonths: Number(data.contractMonths || 0),
    monthlyRate: Number(data.monthlyRate || parseCurrency(data.leasePrice) || 0),
    leaseLabel: data.contractLabel || data.leaseLabel || "",
    leasePrice: data.leasePrice || "",
    moveInDate: data.moveInDate || "",
    moveInTime: data.moveInTime || "",
    requestedAddons: normalizeRequestedAddons(data.requestedAddons || [])
  };

  sessionStorage.setItem("tenantData", JSON.stringify(tenantData));
  sessionStorage.setItem("bookingData", JSON.stringify(bookingData));
  sessionStorage.setItem("documentsData", JSON.stringify({
    applicantType,
    documents: data.documents || []
  }));
  sessionStorage.setItem("bookingDraftReferenceId", referenceId);

  setDraftMode(false);
  const heroTitle = document.querySelector(".hero-title");
  const heroSub = document.querySelector(".hero-sub");
  const submitBtn = document.getElementById("submitBtn");
  const submitCard = document.querySelector(".submit-card");

  if (heroTitle) heroTitle.textContent = "Revise Your Booking Request";
  if (heroSub) heroSub.textContent = data.rejectionReason
    ? `Please update your request based on the admin note: ${data.rejectionReason}`
    : "Please update your request and resubmit it for another admin review.";
  if (submitBtn) submitBtn.textContent = "Resubmit Application →";
  if (submitCard) submitCard.style.display = "";
}

async function loadExistingTransientRequest(requestId) {
  try {
    const doc = await db.collection("transientBedBookings").doc(requestId).get();

    if (!doc.exists) {
      window.location.href = "main.html";
      return;
    }

    const data = doc.data();
    if (data.userId !== currentUser.uid) {
      window.location.href = "main.html";
      return;
    }

    applyReadOnlyMode(true);
    populateSummary({
      ...data,
      referenceId: data.referenceId || doc.id,
      type: data.roomType || data.type,
      leasePrice: `P${Number(data.ratePerDay || 0).toFixed(2)}`,
      moveInDate: data.checkInDate || "",
      checkOutDate: data.checkOutDate || "",
      nights: data.nights || 0,
      totalAmount: data.totalAmount || 0,
      isTransient: true,
      documents: data.documents || []
    });
  } catch (error) {
    console.error("Error loading Transient Bed request:", error);
    window.location.href = "main.html";
  }
}

function populateSummary(data) {
  document.querySelector(".ref-number").textContent = `#${data.referenceId || "Draft"}`;
  document.getElementById("submitDate").textContent = formatDisplayDate(data.createdAt);

  const refStatus = document.querySelector(".ref-status");
  if (refStatus) {
    refStatus.innerHTML = `<span class="status-dot"></span> ${formatStatusText(data.status)}`;
  }

  document.getElementById("firstName").textContent = data.firstName || "";
  document.getElementById("lastName").textContent = data.lastName || "";
  document.getElementById("email").textContent = data.email || "";
  document.getElementById("phone").textContent = data.phone || "";
  document.getElementById("birthDate").textContent = data.birthDate || "";
  document.getElementById("gender").textContent = capitalizeFirstLetter(data.gender || "Not specified");
  document.getElementById("address").textContent = data.address || "";

  document.getElementById("emergencyName").textContent = data.emergencyName || "";
  document.getElementById("relationship").textContent = data.relationship || "";
  document.getElementById("emergencyPhone").textContent = data.emergencyPhone || "";
  document.getElementById("emergencyAlt").textContent = data.emergencyAlt || "Not provided";
  document.getElementById("emergencyAddress").textContent = data.emergencyAddress || "";

  const applicantType = String(data.applicantType || "").replace("type-", "");
  document.getElementById("applicantType").textContent =
    capitalizeFirstLetter(applicantType || "Not specified");

  const roomTypeEl = document.querySelector(".badge-teal");
  const normalizedType = String(data.type || "").toLowerCase();
  roomTypeEl.textContent =
    normalizedType === "premium"
      ? "Premium - Aircon Room"
      : "Standard - Fan Room";

  const summaryValues = document.querySelectorAll(".summary-value");
  summaryValues[1].textContent = `${data.room || ""} - Bedspace ${data.bed || ""}`;
  summaryValues[2].textContent = data.isTransient
    ? `${data.leasePrice || ""} / day`
    : `P${getContractMonthlyRate(data).toFixed(2)} / month`;
  const contractTermEl = document.getElementById("contractTerm");
  if (contractTermEl) {
    contractTermEl.textContent = data.isTransient
      ? "Transient Bed"
      : getContractTermText(data);
  }
  const contractTermItem = document.getElementById("contractTermSummaryItem");
  if (contractTermItem) {
    contractTermItem.style.display = data.isTransient ? "none" : "";
  }
  summaryValues[4].textContent = data.room ? `${data.room.charAt(0)} Floor` : "";

  const genderBadge = document.querySelector(".badge-purple");
  if (genderBadge) {
    genderBadge.textContent = capitalizeFirstLetter(data.gender || "Not specified");
  }

  const availabilityBadge = document.querySelector(".badge-green");
  if (availabilityBadge) {
    availabilityBadge.textContent = data.status === "approved" ? "Reserved" : "Request Submitted";
  }

  const moveInDateEl = document.getElementById("moveInDate");
  const moveInTimeEl = document.getElementById("moveInTime");
  if (moveInDateEl) {
    moveInDateEl.textContent = formatMoveInDateValue(data.moveInDate);
  }
  if (moveInTimeEl) {
    moveInTimeEl.textContent = data.isTransient
      ? formatMoveInDateValue(data.checkOutDate)
      : formatMoveInTimeValue(data.moveInTime);
  }

  if (data.isTransient) {
    const billingMonthsRow = document.getElementById("billingMonthsRow");
    if (billingMonthsRow) billingMonthsRow.style.display = "none";
    document.getElementById("rent").textContent = "P" + parseCurrency(data.leasePrice).toFixed(2);
    document.getElementById("deposit").textContent = `${Number(data.nights || 0)} ${Number(data.nights) === 1 ? "day" : "days"}`;
    document.getElementById("total").textContent = "P" + Number(data.totalAmount || 0).toFixed(2);
    applyTransientSummaryLabels();
  } else {
    const billingMonthsRow = document.getElementById("billingMonthsRow");
    if (billingMonthsRow) billingMonthsRow.style.display = "";
    const price = getContractMonthlyRate(data);
    const downPaymentAmount = REQUIRED_DOWN_PAYMENT;
    document.getElementById("rent").textContent = "P" + price.toFixed(2);
    document.getElementById("deposit").textContent = "P" + downPaymentAmount.toFixed(2);
    document.getElementById("total").textContent = "P" + downPaymentAmount.toFixed(2);
    const billingMonths = document.getElementById("billingMonths");
    if (billingMonths) {
      billingMonths.textContent = getBillingMonthsText(data);
    }
  }

  renderRequestedAddons(data);
  renderDocuments(data.documents || []);
}

function getContractMonthlyRate(data) {
  const amount = Number(data.monthlyRate || 0);
  return Number.isFinite(amount) && amount > 0 ? amount : parseCurrency(data.leasePrice);
}

function getContractTermText(data) {
  const label = data.contractLabel || data.leaseLabel || "Selected contract";
  const months = Number(data.contractMonths || 0);
  return months ? `${label} (${months} monthly billing cycle${months === 1 ? "" : "s"})` : label;
}

function addMonths(date, offset) {
  const next = new Date(date);
  next.setMonth(next.getMonth() + offset);
  return next;
}

function getBillingMonthsText(data) {
  const months = Number(data.contractMonths || 0);
  const moveInDate = data.moveInDate ? new Date(`${data.moveInDate}T00:00:00`) : null;

  if (!months) {
    return "Based on selected contract";
  }

  if (!moveInDate || Number.isNaN(moveInDate.getTime())) {
    return `${months} monthly billing cycle${months === 1 ? "" : "s"}`;
  }

  const firstBillingMonth = addMonths(moveInDate, 1);
  const lastBillingMonth = addMonths(moveInDate, months);
  const formatMonth = (date) => date.toLocaleDateString("en-PH", {
    month: "long",
    year: "numeric"
  });

  return `${formatMonth(firstBillingMonth)} to ${formatMonth(lastBillingMonth)}`;
}

function formatAddonCurrency(amount) {
  return "P" + Number(amount || 0).toFixed(2);
}

function renderRequestedAddons(data) {
  const summary = document.getElementById("selectedAddonsSummary");
  const monthlyTotal = document.getElementById("addonsMonthlyTotal");
  const addonsMonthlyRow = document.getElementById("addonsMonthlyRow");
  const requestedAddons = normalizeRequestedAddons(data.requestedAddons || []);

  if (!summary || !monthlyTotal || !addonsMonthlyRow) {
    return;
  }

  if (data.isTransient) {
    addonsMonthlyRow.style.display = "none";
    summary.textContent = "Not applicable for transient stay";
    return;
  }

  addonsMonthlyRow.style.display = "";

  if (!requestedAddons.length) {
    summary.textContent = "No add-ons selected";
    monthlyTotal.textContent = formatAddonCurrency(0);
    return;
  }

  const total = requestedAddons.reduce((sum, addon) => sum + Number(addon.price || 0), 0);
  summary.textContent = requestedAddons
    .map((addon) => `${addon.addonName} (${formatAddonCurrency(addon.price)})`)
    .join(" • ");
  monthlyTotal.textContent = `${formatAddonCurrency(total)} / month`;
}

function applyReadOnlyMode(isTransient = false) {
  const navStepLabel = document.querySelector(".nav-step-label");
  const heroTitle = document.querySelector(".hero-title");
  const heroSub = document.querySelector(".hero-sub");
  const progressWrap = document.querySelector(".progress-wrap");
  const submitCard = document.querySelector(".submit-card");

  if (navStepLabel) navStepLabel.textContent = isTransient ? "Transient Bed Request Summary" : "Booking Request Summary";
  if (heroTitle) heroTitle.textContent = isTransient ? "Your Submitted Transient Bed Request" : "Your Submitted Booking Request";
  if (heroSub) heroSub.textContent = "Below are the details of the request you submitted. This page is view-only.";
  if (progressWrap) progressWrap.style.display = "none";
  if (submitCard) submitCard.style.display = "none";

  document.querySelectorAll(".edit-link").forEach(link => {
    link.style.display = "none";
  });
}

function setDraftMode(isTransient = false) {
  const navStepLabel = document.querySelector(".nav-step-label");
  const heroTitle = document.querySelector(".hero-title");
  const heroSub = document.querySelector(".hero-sub");

  if (navStepLabel) navStepLabel.textContent = "Step 4 of 4 - Review & Submit";
  if (heroTitle) heroTitle.textContent = isTransient ? "Review Your Transient Bed Request" : "Almost There - Review Your Application";
  if (heroSub) heroSub.textContent = isTransient
    ? "Please review your stay details and personal information. Payment will be available only after admin approval."
    : "Please carefully review all details below before submitting. Once submitted, our team will process your application within 1-2 business days.";
}

function applyTransientSummaryLabels() {
  const sectionTitle = document.querySelector(".section-card .section-title");
  const editBookingLink = document.querySelector('a[href="../pages/booking.html"].edit-link');
  const labels = document.querySelectorAll(".summary-label");
  const costTitle = document.querySelector(".cost-title");
  const costRows = document.querySelectorAll(".cost-row span:first-child");
  const timelineItems = document.querySelectorAll(".timeline-item");

  if (sectionTitle) sectionTitle.lastChild.textContent = " Transient Bed";
  if (editBookingLink) {
    editBookingLink.textContent = "Edit Stay";
    editBookingLink.href = "../pages/transient-bed.html";
  }
  if (labels[2]) labels[2].textContent = "Daily Rate";
  if (labels[7]) labels[7].textContent = "Check-in Date";
  if (labels[8]) labels[8].textContent = "Check-out Date";
  if (costTitle) costTitle.textContent = "Transient Bed Bill";
  if (costRows[0]) costRows[0].textContent = "Daily Rate";
  if (costRows[1]) costRows[1].textContent = "Total Stay";
  if (costRows[3]) costRows[3].textContent = "Total Amount After Approval";

  const thirdTimeline = timelineItems[2];
  const thirdTitle = thirdTimeline?.querySelector(".tl-title");
  const thirdDesc = thirdTimeline?.querySelector(".tl-desc");
  if (thirdTitle) thirdTitle.textContent = "Payment & Check-in";
  if (thirdDesc) {
    thirdDesc.textContent = "Once approved, choose a payment method on the payment page and settle your Transient Bed bill before check-in.";
  }
}

function renderDocuments(documents) {
  const checklist = document.querySelector(".doc-checklist");
  if (!checklist) return;

  checklist.innerHTML = "";

  if (!documents.length) {
    const emptyState = document.createElement("div");
    emptyState.className = "doc-check-item";

    const icon = document.createElement("div");
    icon.className = "doc-check-icon";
    icon.textContent = "!";

    const info = document.createElement("div");
    info.className = "doc-check-info";

    const name = document.createElement("div");
    name.className = "doc-check-name";
    name.textContent = "No document details available";

    const files = document.createElement("div");
    files.className = "doc-check-files";
    files.textContent = "Upload details will appear here after the fill-up step.";

    info.appendChild(name);
    info.appendChild(files);
    emptyState.appendChild(icon);
    emptyState.appendChild(info);
    checklist.appendChild(emptyState);
    return;
  }

  documents.forEach(doc => {
    const item = document.createElement("div");
    item.className = "doc-check-item uploaded";

    const icon = document.createElement("div");
    icon.className = "doc-check-icon";
    icon.textContent = "OK";

    const info = document.createElement("div");
    info.className = "doc-check-info";

    const name = document.createElement("div");
    name.className = "doc-check-name";
    name.textContent = doc.label || "Document";

    const files = document.createElement("div");
    files.className = "doc-check-files";

    const fileList = document.createElement("div");
    fileList.className = "doc-file-list";

    (doc.files || []).forEach((file) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "doc-file-chip";
      button.textContent = `${file.name} (${normalizeFileType(file.type)}, ${formatFileSize(file.size || 0)})`;
      button.addEventListener("click", () => {
        openDocumentPreview(file);
      });
      fileList.appendChild(button);
    });

    const count = document.createElement("div");
    count.className = "doc-check-count";
    count.textContent = `${(doc.files || []).length} file${(doc.files || []).length === 1 ? "" : "s"}`;

    info.appendChild(name);
    info.appendChild(files);
    files.appendChild(fileList);
    item.appendChild(icon);
    item.appendChild(info);
    item.appendChild(count);
    checklist.appendChild(item);
  });
}

function formatFileSize(size) {
  if (size >= 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  if (size >= 1024) {
    return `${Math.round(size / 1024)} KB`;
  }

  return `${size} B`;
}

function normalizeFileType(type) {
  if (!type) return "File";
  if (type.includes("pdf")) return "PDF";
  if (type.includes("image/")) return "Image";
  return type;
}

async function uploadDraftDocumentsToStorage(userId, referenceId, documents) {
  if (!documents.length) {
    return [];
  }

  if (!storage) {
    throw new Error("Firebase Storage is not available on this page.");
  }

  const uploadedDocuments = [];

  for (const doc of documents) {
    const uploadedFiles = [];

    for (const file of doc.files || []) {
      if (file.url && !file.dataUrl) {
        uploadedFiles.push({
          name: file.name || "Uploaded document",
          size: file.size || 0,
          type: file.type || "application/octet-stream",
          url: file.url,
          storagePath: file.storagePath || ""
        });
        continue;
      }

      const storagePath = buildDocumentStoragePath(userId, referenceId, doc.id, file.name);
      const storageRef = storage.ref().child(storagePath);
      const payload = await dataUrlToBlob(file.dataUrl);

      await storageRef.put(payload, {
        contentType: file.type || "application/octet-stream",
        customMetadata: {
          userId,
          referenceId,
          documentId: doc.id || "",
          documentLabel: doc.label || "Document"
        }
      });

      const url = await storageRef.getDownloadURL();

      uploadedFiles.push({
        name: file.name,
        size: file.size || payload.size || 0,
        type: file.type || "application/octet-stream",
        url,
        storagePath
      });
    }

    uploadedDocuments.push({
      id: doc.id,
      label: doc.label,
      files: uploadedFiles
    });
  }

  return uploadedDocuments;
}

function buildDocumentStoragePath(userId, referenceId, documentId, fileName) {
  const safeName = String(fileName || "file")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/_+/g, "_");

  return `booking-documents/${userId}/${referenceId}/${documentId}/${Date.now()}_${safeName}`;
}

async function dataUrlToBlob(dataUrl) {
  if (!dataUrl) {
    throw new Error("Missing document content.");
  }

  const response = await fetch(dataUrl);
  return response.blob();
}

function capitalizeFirstLetter(text) {
  if (!text) return "";
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

function parseCurrency(value) {
  const amount = parseFloat(String(value || "").replace(/[,P]/g, ""));
  return Number.isFinite(amount) ? amount : 0;
}

function formatDisplayDate(value) {
  if (!value) {
    return new Date().toLocaleDateString("en-PH", {
      year: "numeric", month: "long", day: "numeric"
    });
  }

  if (typeof value.toDate === "function") {
    return value.toDate().toLocaleDateString("en-PH", {
      year: "numeric", month: "long", day: "numeric"
    });
  }

  const date = value instanceof Date ? value : new Date(value);
  return date.toLocaleDateString("en-PH", {
    year: "numeric", month: "long", day: "numeric"
  });
}

function formatStatusText(status) {
  if (status === "approved") return "Approved Request";
  if (status === "rejected") return "Rejected Request";
  return "Pending Request";
}

function formatMoveInDateValue(value) {
  if (!value) return "Not specified";
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("en-PH", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });
}

function formatMoveInTimeValue(value) {
  if (!value) return "Not specified";
  const [hours, minutes] = String(value).split(":");
  if (hours == null || minutes == null) return value;
  const parsed = new Date();
  parsed.setHours(Number(hours), Number(minutes), 0, 0);
  return parsed.toLocaleTimeString("en-PH", {
    hour: "numeric",
    minute: "2-digit"
  });
}

function generateRefID() {
  const random = Math.floor(10000 + Math.random() * 90000);
  const year = new Date().getFullYear();
  return `CHD-${year}-${random}`;
}

function generateTransientRefID() {
  const random = Math.floor(10000 + Math.random() * 90000);
  const year = new Date().getFullYear();
  return `TB-${year}-${random}`;
}

function openDocumentPreview(file) {
  const modal = document.getElementById("documentPreviewModal");
  const title = document.getElementById("documentPreviewTitle");
  const body = document.getElementById("documentPreviewBody");

  if (!modal || !title || !body) {
    return;
  }

  title.textContent = file.name || "Document Preview";
  body.innerHTML = "";

  const previewSource = file.url || file.dataUrl || "";

  if (!previewSource) {
    body.innerHTML = `<div class="document-preview-empty">Preview is unavailable for this file.</div>`;
  } else if (String(file.type || "").includes("image/")) {
    const image = document.createElement("img");
    image.src = previewSource;
    image.alt = file.name || "Uploaded document";
    image.className = "document-preview-image";
    body.appendChild(image);
  } else if (String(file.type || "").includes("pdf")) {
    const frame = document.createElement("iframe");
    frame.src = previewSource;
    frame.className = "document-preview-frame";
    frame.title = file.name || "Document Preview";
    body.appendChild(frame);
  } else {
    const link = document.createElement("a");
    link.href = previewSource;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.className = "doc-file-chip";
    link.textContent = "Open file in a new tab";
    body.appendChild(link);
  }

  modal.style.display = "flex";
}

function closeDocumentPreview() {
  const modal = document.getElementById("documentPreviewModal");
  const body = document.getElementById("documentPreviewBody");

  if (modal) {
    modal.style.display = "none";
  }

  if (body) {
    body.innerHTML = "";
  }
}

function openTermsModal(event) {
  event?.preventDefault();
  const modal = document.getElementById("termsModal");
  if (modal) {
    modal.style.display = "flex";
  }
}

function closeTermsModal() {
  const modal = document.getElementById("termsModal");
  if (modal) {
    modal.style.display = "none";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  document.querySelector('a[href="../pages/booking.html"].edit-link')?.addEventListener("click", (event) => {
    event.preventDefault();
    goToBookingEdit();
  });

  document.querySelector('a[href="../pages/fillup.html"].edit-link')?.addEventListener("click", (event) => {
    event.preventDefault();
    goToFillupEdit();
  });

  document.getElementById("documentPreviewClose")?.addEventListener("click", closeDocumentPreview);
  document.getElementById("documentPreviewModal")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeDocumentPreview();
    }
  });
  document.querySelectorAll(".terms-popup-link").forEach((link) => {
    link.addEventListener("click", openTermsModal);
  });
  document.getElementById("termsModalClose")?.addEventListener("click", closeTermsModal);
  document.getElementById("termsModalConsent")?.addEventListener("click", closeTermsModal);
  document.getElementById("termsModal")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeTermsModal();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeTermsModal();
    }
  });
});

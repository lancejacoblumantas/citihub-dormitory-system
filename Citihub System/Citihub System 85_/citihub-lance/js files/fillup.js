// Globals
let currentUser = null;
let userGender = null;
let requestAllowed = null;
let isSubmitting = false;
let selectedApplicantType = null;
let bookingRestrictionReason = "";

const MAX_UPLOAD_SIZE = 5 * 1024 * 1024;
const ALLOWED_UPLOAD_TYPES = ["image/jpeg", "image/png"];
const ALLOWED_UPLOAD_EXTENSIONS = ["jpg", "jpeg", "png"];
const MINIMUM_AGE = 16;
const COMMON_DOCUMENTS = [
  { id: "selfie-id", label: "Selfie Holding ID" }
];
const DOCUMENT_GROUPS = {
  student: [
    { id: "school-id", label: "School ID" }
  ],
  employed: [
    { id: "company-id", label: "Company ID or COE" }
  ],
  unemployed: [
    { id: "nbi", label: "NBI Clearance" },
    { id: "med-cert", label: "Medical Certificate" },
    { id: "gov-id-unemp", label: "Valid Government ID" }
  ]
};
const ADDON_OPTIONS = [
  {
    id: "locker_medium",
    name: "Medium Locker",
    price: 200,
    description: "Secure a personal medium locker for monthly use."
  },
  {
    id: "motorcycle_parking",
    name: "Motorcycle Parking",
    price: 600,
    description: "Reserve a motorcycle parking slot inside CitiHub."
  },
  {
    id: "car_parking",
    name: "Car Parking",
    price: 4000,
    description: "Reserve a monthly parking slot for your car."
  },
  {
    id: "wifi",
    name: "WiFi",
    price: 200,
    description: "Add shared monthly WiFi access to your billing."
  }
];

function getRequiredDocuments(applicantType) {
  const normalizedType = normalizeApplicantType(applicantType);
  return [...(DOCUMENT_GROUPS[normalizedType] || []), ...COMMON_DOCUMENTS];
}

function normalizeApplicantType(value) {
  return String(value || "").replace(/^type-/, "").toLowerCase();
}

function getGenderSelectValue(value) {
  const normalized = String(value || "").trim().toLowerCase();

  if (normalized === "male") return "Male";
  if (normalized === "female") return "Female";
  if (normalized === "bisexual") return "Bisexual";
  if (normalized === "prefer not to say") return "Prefer not to say";
  return "";
}

function formatAddonPrice(price) {
  return `PHP ${Number(price || 0).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function getSelectedAddons() {
  if (isTransientApplicationMode()) {
    return [];
  }

  return ADDON_OPTIONS
    .filter((addon) => document.getElementById(`addon-${addon.id}`)?.checked)
    .map((addon) => ({
      addonId: addon.id,
      addonName: addon.name,
      price: addon.price,
      billingType: "monthly",
      description: addon.description
    }));
}

function persistSelectedAddons() {
  const savedTenantData = JSON.parse(sessionStorage.getItem("tenantData") || "{}");
  sessionStorage.setItem("tenantData", JSON.stringify({
    ...savedTenantData,
    requestedAddons: getSelectedAddons()
  }));
}

function restoreSelectedAddons(savedAddons = []) {
  if (isTransientApplicationMode()) {
    updateAddonsSummary();
    return;
  }

  const selectedIds = new Set(
    Array.isArray(savedAddons)
      ? savedAddons.map((addon) => String(addon?.addonId || addon?.id || "").trim().toLowerCase())
      : []
  );

  ADDON_OPTIONS.forEach((addon) => {
    const checkbox = document.getElementById(`addon-${addon.id}`);
    if (checkbox) {
      checkbox.checked = selectedIds.has(addon.id);
    }
  });

  updateAddonsSummary();
}

function updateAddonsSummary() {
  const summary = document.getElementById("addonsSummary");
  const count = document.getElementById("addonsCount");
  const total = document.getElementById("addonsTotal");
  if (!summary || !count || !total) {
    return;
  }

  if (isTransientApplicationMode()) {
    count.textContent = "Not applicable for transient stays";
    total.textContent = "Optional";
    summary.innerHTML = `<div class="addons-summary-empty">Add-ons are available only for regular monthly bedspace bookings.</div>`;
    return;
  }

  const selected = getSelectedAddons();
  const monthlyTotal = selected.reduce((sum, addon) => sum + Number(addon.price || 0), 0);

  count.textContent = selected.length
    ? `${selected.length} add-on${selected.length === 1 ? "" : "s"} selected`
    : "No add-ons selected yet";
  total.textContent = selected.length
    ? `${formatAddonPrice(monthlyTotal)} / month`
    : "Optional";

  if (!selected.length) {
    summary.innerHTML = `<div class="addons-summary-empty">You can leave this blank for now and add services later after approval.</div>`;
    return;
  }

  summary.innerHTML = selected.map((addon) => `
    <div class="addon-summary-chip">
      <span class="addon-summary-name">${addon.addonName}</span>
      <span class="addon-summary-price">${formatAddonPrice(addon.price)}</span>
    </div>
  `).join("");
}

function bindAddonInputs() {
  ADDON_OPTIONS.forEach((addon) => {
    const checkbox = document.getElementById(`addon-${addon.id}`);
    if (!checkbox) return;

    checkbox.addEventListener("change", () => {
      updateAddonsSummary();
      persistSelectedAddons();
    });
  });
}

function isTransientApplicationMode() {
  const params = new URLSearchParams(window.location.search);
  const hasMonthlyBooking = Boolean(sessionStorage.getItem("bookingData"));

  if (params.get("mode") === "transient") {
    return true;
  }

  return !hasMonthlyBooking && Boolean(sessionStorage.getItem("transientBookingData"));
}

function goToSummaryPage() {
  window.location.href = isTransientApplicationMode()
    ? "submit.html?mode=transient"
    : "submit.html";
}

function applyFillupModeCopy() {
  if (!isTransientApplicationMode()) return;

  const navStep = document.querySelector(".nav-step-label");
  const heroTitle = document.querySelector(".hero-title");
  const heroSub = document.querySelector(".hero-sub");
  const addonsSection = document.getElementById("addonsSection");

  if (navStep) navStep.textContent = "Step 3 of 4 - Transient Bed Info";
  if (heroTitle) heroTitle.textContent = "Complete Your Transient Bed Information";
  if (heroSub) heroSub.textContent = "Add your personal details and documents before submitting your Transient Bed request for admin review.";
  if (addonsSection) addonsSection.style.display = "none";
}

function getLegacyDocumentAlias(id) {
  const aliases = {
    "selfie-id": ["selfie-id-student", "selfie-id-employed", "selfie-id-unemployed"]
  };

  return aliases[id] || [];
}

function findSavedDocument(savedDocuments, id) {
  const directMatch = savedDocuments.find(item => item.id === id);
  if (directMatch) {
    return directMatch;
  }

  const aliases = getLegacyDocumentAlias(id);
  return savedDocuments.find(item => aliases.includes(item.id)) || null;
}

const popup = document.getElementById("appPopup");
const popupTitle = document.getElementById("popupTitle");
const popupMessage = document.getElementById("popupMessage");
const popupIcon = document.getElementById("popupIcon");
const popupCancel = document.getElementById("popupCancel");
const popupConfirm = document.getElementById("popupConfirm");
let popupHideTimer = null;

function showPopup({ title, message, type = "success" }) {
  if (!popup || !popupTitle || !popupMessage || !popupIcon || !popupConfirm || !popupCancel) {
    return;
  }

  popupTitle.textContent = title;
  popupMessage.textContent = message;
  popupCancel.hidden = true;

  if (type === "success") {
    popupIcon.textContent = "OK";
    popupIcon.style.color = "#22c55e";
  } else if (type === "error") {
    popupIcon.textContent = "!";
    popupIcon.style.color = "#f87171";
  } else if (type === "warning") {
    popupIcon.textContent = "!";
    popupIcon.style.color = "#fbbf24";
  } else {
    popupIcon.textContent = "i";
    popupIcon.style.color = "#60a5fa";
  }

  popup.classList.add("show");
  clearTimeout(popupHideTimer);
  popupHideTimer = setTimeout(() => {
    popup.classList.remove("show");
  }, 3500);

  popupConfirm.onclick = () => {
    clearTimeout(popupHideTimer);
    popup.classList.remove("show");
  };

  popupCancel.onclick = () => {
    clearTimeout(popupHideTimer);
    popup.classList.remove("show");
  };
}

function showWarning(message) {
  showPopup({
    title: "Incomplete Form",
    message,
    type: "warning"
  });
}

function getYesterdayDateString() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - 1);
  return date.toISOString().split("T")[0];
}

function applyFieldSecurityRules() {
  const birthDateInput = document.getElementById("birthDateInput");
  if (birthDateInput) {
    birthDateInput.max = getYesterdayDateString();
  }

  [
    "phoneInput",
    "emergencyPhoneInput",
    "emergencyAltInput"
  ].forEach((id) => {
    const input = document.getElementById(id);
    if (!input) return;

    input.addEventListener("input", () => {
      const digitsOnly = input.value.replace(/\D/g, "").slice(0, Number(input.maxLength) || 11);
      if (input.value !== digitsOnly) {
        input.value = digitsOnly;
      }
    });
  });

  [
    "firstNameInput",
    "lastNameInput",
    "emergencyNameInput"
  ].forEach((id) => {
    const input = document.getElementById(id);
    if (!input) return;

    input.addEventListener("input", () => {
      const cleaned = input.value.replace(/[^a-zA-Z\s.'-]/g, "");
      if (input.value !== cleaned) {
        input.value = cleaned;
      }
    });
  });
}

function calculateAge(dateString) {
  if (!dateString) return 0;

  const birthDate = new Date(`${dateString}T00:00:00`);
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDifference = today.getMonth() - birthDate.getMonth();

  if (
    monthDifference < 0 ||
    (monthDifference === 0 && today.getDate() < birthDate.getDate())
  ) {
    age -= 1;
  }

  return age;
}

function isValidPhoneNumber(value, { allowEmpty = false } = {}) {
  const normalized = String(value || "").trim();

  if (!normalized) {
    return allowEmpty;
  }

  return /^09\d{9}$/.test(normalized);
}

function validateBusinessRules(inputs, applicantType) {
  const validationErrors = [];
  const firstName = inputs[0]?.value.trim() || "";
  const lastName = inputs[1]?.value.trim() || "";
  const phone = inputs[3]?.value.trim() || "";
  const birthDate = inputs[4]?.value || "";
  const address = inputs[6]?.value.trim() || "";
  const emergencyName = inputs[7]?.value.trim() || "";
  const emergencyPhone = inputs[9]?.value.trim() || "";
  const emergencyAlt = inputs[10]?.value.trim() || "";
  const emergencyAddress = inputs[11]?.value.trim() || "";
  const letterPattern = /^[a-zA-Z\s.'-]+$/;

  if (firstName && !letterPattern.test(firstName)) {
    validationErrors.push("First name must only contain letters and basic punctuation.");
  }

  if (lastName && !letterPattern.test(lastName)) {
    validationErrors.push("Last name must only contain letters and basic punctuation.");
  }

  if (!isValidPhoneNumber(phone)) {
    validationErrors.push("Phone number must be 11 digits and start with 09.");
  }

  if (!birthDate) {
    validationErrors.push("Date of birth is required.");
  } else {
    const selectedDate = new Date(`${birthDate}T00:00:00`);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (selectedDate >= today) {
      validationErrors.push("Date of birth must be earlier than today.");
    } else if (calculateAge(birthDate) < MINIMUM_AGE) {
      validationErrors.push(`Applicants must be at least ${MINIMUM_AGE} years old.`);
    }
  }

  if (address.length > 180) {
    validationErrors.push("Home address is too long.");
  }

  if (emergencyName && !letterPattern.test(emergencyName)) {
    validationErrors.push("Emergency contact name must only contain letters and basic punctuation.");
  }

  if (!isValidPhoneNumber(emergencyPhone)) {
    validationErrors.push("Emergency contact phone number must be 11 digits and start with 09.");
  }

  if (!isValidPhoneNumber(emergencyAlt, { allowEmpty: true })) {
    validationErrors.push("Alternative number must be blank or use the 09XXXXXXXXX format.");
  }

  if (emergencyAddress.length > 180) {
    validationErrors.push("Emergency contact address is too long.");
  }

  if (!applicantType) {
    validationErrors.push("Please select an applicant type.");
  }

  return validationErrors;
}

// Auth state
document.addEventListener("DOMContentLoaded", () => {
  applyFillupModeCopy();
  applyFieldSecurityRules();
  bindAddonInputs();
  firebase.auth().onAuthStateChanged(async (user) => {
    if (!user) {
      window.location.href = "intro.html";
      return;
    }

    currentUser = user;

    const emailInput = document.getElementById("emailInput");
    if (emailInput) {
      emailInput.value = user.email;
      emailInput.readOnly = true;
    }

    try {
      const doc = await db.collection("users").doc(user.uid).get();
      if (doc.exists) {
        userGender = doc.data().gender || "Not specified";

        const genderSelect = document.getElementById("genderSelect");
        if (genderSelect) {
          genderSelect.value = getGenderSelectValue(userGender);
          genderSelect.disabled = true;
        }
      }
    } catch (err) {
      console.error("Error loading user gender:", err);
    }

    const allowed = await protectPage(user.uid);
    if (!allowed) {
      return;
    }
    restoreSavedTenantData();
    restoreSavedDocuments();
    window.hidePageLoader?.();
  });
});

// Check existing request
async function canUserRequest(userId) {
  const userSnap = await db.collection("users").doc(userId).get();
  if (userSnap.exists && userSnap.data()?.bookingBlocked === true) {
    bookingRestrictionReason = userSnap.data()?.bookingBlockedReason
      ? `Your account is no longer allowed to book a bedspace. Reason: ${userSnap.data().bookingBlockedReason}`
      : "Your account is no longer allowed to book a bedspace. Please contact CitiHub management for assistance.";
    return false;
  }

  if (isTransientApplicationMode()) {
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

  const snapshot = await db.collection("bookingRequest")
    .where("userId", "==", userId)
    .where("status", "in", ["pending", "approved"])
    .limit(1)
    .get();

  if (!snapshot.empty) {
    bookingRestrictionReason = "You already have a pending or approved booking request.";
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

// Protect page
async function protectPage(userId) {
  if (sessionStorage.getItem("bookingData") || sessionStorage.getItem("transientBookingData")) {
    return true;
  }

  requestAllowed = await canUserRequest(userId);

  if (!requestAllowed) {
    if (bookingRestrictionReason) {
      sessionStorage.setItem("bookingRestrictionMessage", bookingRestrictionReason);
    }
    window.location.href = "main.html";
    return false;
  }

  return true;
}

// Select applicant type
function selectType(type) {
  selectedApplicantType = type;

  document.querySelectorAll(".applicant-card").forEach(card => {
    card.classList.remove("selected");
  });

  document.getElementById("type-" + type).classList.add("selected");

  ["student", "employed", "unemployed"].forEach(groupType => {
    const group = document.getElementById("docs-" + groupType);
    if (group) group.style.display = "none";
  });

  document.getElementById("docs-placeholder").style.display = "none";
  document.getElementById("docs-" + type).style.display = "block";

  document.querySelector("#section-docs .section-sub").textContent =
    "Upload your required documents and identity verification below";

  persistDocumentsData();
}

// File upload
function triggerUpload(id) {
  document.getElementById(id).click();
}

function ensureUploadRemoveButton(uploadBox, inputId, displayId) {
  if (!uploadBox || uploadBox.querySelector(".upload-remove-btn")) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "upload-remove-btn";
  button.setAttribute("aria-label", "Remove uploaded document");
  button.textContent = "x";
  button.textContent = "×";
  button.textContent = "x";
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    resetUploadDisplay(inputId, displayId);
    removeSavedDocument(inputId);
    persistDocumentsData();
  });

  uploadBox.appendChild(button);
}

async function handleUpload(input, displayId) {
  const display = document.getElementById(displayId);
  const uploadBox = input.closest(".upload-box");
  const files = Array.from(input.files || []);

  if (!display || !uploadBox) return;
  ensureUploadRemoveButton(uploadBox, input.id, displayId);

  if (!files.length) {
    resetUploadDisplay(input.id, displayId);
    removeSavedDocument(input.id);
    persistDocumentsData();
    return;
  }

  const oversizedFile = files.find(file => file.size > MAX_UPLOAD_SIZE);
  if (oversizedFile) {
    showWarning("Each uploaded file must be smaller than 5MB. Please choose a smaller file and try again.");
    input.value = "";
    delete input.dataset.filesPayload;
    resetUploadDisplay(input.id, displayId);
    persistDocumentsData();
    return;
  }

  try {
    const fileEntries = await Promise.all(files.map(readFileForStorage));
    input.dataset.filesPayload = JSON.stringify(fileEntries);
    delete input.dataset.removedUpload;

    const summary = "Uploaded: " + summarizeFiles(fileEntries);
    renderUploadPreview(uploadBox, fileEntries);
    display.textContent = summary;
    display.title = summary;
    display.style.color = "#1a6b3a";
    uploadBox.classList.add("uploaded");

    persistDocumentsData();
  } catch (error) {
    console.error("Document validation failed:", error);
    showWarning(error?.message || "Only JPG and PNG image files are allowed.");
    input.value = "";
    delete input.dataset.filesPayload;
    resetUploadDisplay(input.id, displayId);
    persistDocumentsData();
  }
}

// Submit form
function handleSubmit() {
  if (isSubmitting) return;
  isSubmitting = true;

  let hasError = false;
  let validationMessage = "";

  document.querySelectorAll(".error-text").forEach(error => error.remove());
  document.querySelectorAll(".field-input").forEach(input => {
    input.classList.remove("error");
  });

  const inputs = document.querySelectorAll(".field-input");

  inputs.forEach(input => {
    if (input.disabled) return;

    if (!input.value || input.value.trim() === "") {
      hasError = true;
      input.classList.add("error");

      const error = document.createElement("div");
      error.className = "error-text";
      error.textContent = "This field is required";
      input.parentElement.appendChild(error);
    }
  });

  const selectedType = document.querySelector(".applicant-card.selected");
  if (!selectedType) {
    hasError = true;
    validationMessage = validationMessage || "Please select your applicant type before continuing.";

    const error = document.createElement("div");
    error.className = "error-text";
    error.textContent = "Please select an applicant type";
    document.querySelector(".applicant-types").appendChild(error);
  }

  const applicantType = selectedType
    ? normalizeApplicantType(selectedType.id)
    : null;
  const businessRuleErrors = validateBusinessRules(inputs, applicantType);
  if (businessRuleErrors.length > 0) {
    hasError = true;
    validationMessage = validationMessage || businessRuleErrors[0];
  }
  const documentsData = applicantType
    ? getDocumentsData(applicantType)
    : [];
  const missingDocuments = documentsData.filter(doc => !doc.files.length);

  if (applicantType && missingDocuments.length > 0) {
    hasError = true;
    validationMessage = validationMessage || `Please upload the required document(s): ${missingDocuments.map(doc => doc.label).join(", ")}.`;

    const error = document.createElement("div");
    error.className = "error-text";
    error.textContent =
      "Please upload: " + missingDocuments.map(doc => doc.label).join(", ");

    const docGroup = document.getElementById("docs-" + applicantType);
    if (docGroup) {
      docGroup.appendChild(error);
    }
  }

  const agree = document.getElementById("agree-terms");
  if (!agree.checked) {
    hasError = true;
    validationMessage = validationMessage || "Please agree to the Terms and Conditions before continuing.";

    const error = document.createElement("div");
    error.className = "error-text";
    error.textContent = "You must agree first";
    agree.parentElement.appendChild(error);
  }

  if (hasError) {
    if (!validationMessage) {
      validationMessage = "Please complete the required fields and uploads before continuing to the next step.";
    }
    showWarning(validationMessage);
    isSubmitting = false;
    return;
  }

  const formData = {
    firstName: inputs[0].value,
    lastName: inputs[1].value,
    email: currentUser.email,
    gender: userGender,
    phone: inputs[3].value,
    birthDate: inputs[4].value,
    address: inputs[6].value,
    emergencyName: inputs[7].value,
    relationship: inputs[8].value,
    emergencyPhone: inputs[9].value,
    emergencyAlt: inputs[10].value,
    emergencyAddress: inputs[11].value,
    applicantType,
    requestedAddons: getSelectedAddons()
  };

  sessionStorage.setItem("tenantData", JSON.stringify(formData));
  sessionStorage.setItem("documentsData", JSON.stringify({
    applicantType,
    documents: documentsData
  }));

  console.log("Saved:", formData);
  document.getElementById("success-modal").style.display = "flex";

  isSubmitting = false;
}

function getDocumentsData(applicantType) {
  const group = getRequiredDocuments(applicantType);
  const previousData = JSON.parse(sessionStorage.getItem("documentsData"));

  return group.map(doc => {
    const input = document.getElementById(doc.id);
    let files = [];

    if (input?.dataset.filesPayload) {
      try {
        files = JSON.parse(input.dataset.filesPayload);
      } catch (error) {
        files = [];
      }
    } else if (input?.files?.length) {
      files = Array.from(input.files).map(file => ({
        name: file.name,
        size: file.size,
        type: file.type || getFileTypeFromName(file.name),
        dataUrl: ""
      }));
    }

    if (!files.length && input?.dataset.removedUpload !== "true") {
      const savedDoc = findSavedDocument(previousData?.documents || [], doc.id);
      files = savedDoc?.files || [];
    }

    return {
      id: doc.id,
      label: doc.label,
      files
    };
  });
}

function persistDocumentsData() {
  if (!selectedApplicantType) return;

  const previousData = JSON.parse(sessionStorage.getItem("documentsData"));
  const mergedDocuments = getDocumentsData(selectedApplicantType).map(doc => {
    if (doc.files.length) return doc;

    const input = document.getElementById(doc.id);
    if (input?.dataset.removedUpload === "true") {
      return doc;
    }

    const savedDoc = findSavedDocument(previousData?.documents || [], doc.id);
    return savedDoc || doc;
  });

  sessionStorage.setItem("documentsData", JSON.stringify({
    applicantType: selectedApplicantType,
    documents: mergedDocuments
  }));
}

function restoreSavedDocuments() {
  const saved = JSON.parse(sessionStorage.getItem("documentsData"));

  const applicantType = normalizeApplicantType(saved?.applicantType);

  if (!saved || !applicantType || !DOCUMENT_GROUPS[applicantType]) {
    return;
  }

  selectType(applicantType);

  (saved.documents || []).forEach(doc => {
    const targetId = document.getElementById(doc.id)
      ? doc.id
      : getLegacyDocumentAlias("selfie-id").includes(doc.id)
        ? "selfie-id"
        : doc.id;
    const input = document.getElementById(targetId);
    const display = document.getElementById(targetId + "-display");
    const uploadBox = input?.closest(".upload-box");

    if (!display || !uploadBox || !doc.files || !doc.files.length) return;
    ensureUploadRemoveButton(uploadBox, targetId, targetId + "-display");

    if (input) {
      input.dataset.filesPayload = JSON.stringify(doc.files);
      delete input.dataset.removedUpload;
    }

    const summary = "Uploaded: " + summarizeFiles(doc.files);
    renderUploadPreview(uploadBox, doc.files);
    display.textContent = summary;
    display.title = summary;
    display.style.color = "#1a6b3a";
    uploadBox.classList.add("uploaded");
  });
}

function resetUploadDisplay(inputId, displayId) {
  const display = document.getElementById(displayId);
  const uploadBox = document.getElementById(inputId)?.closest(".upload-box");

  if (display) {
    display.textContent = "Click to upload";
    display.removeAttribute("title");
    display.style.color = "";
  }

  const input = document.getElementById(inputId);
  if (input) {
    input.value = "";
    delete input.dataset.filesPayload;
    input.dataset.removedUpload = "true";
  }

  if (uploadBox) {
    removeUploadPreview(uploadBox);
    uploadBox.classList.remove("uploaded");
  }
}

function renderUploadPreview(uploadBox, files = []) {
  if (!uploadBox) return;

  removeUploadPreview(uploadBox);

  const file = files.find(item => isPreviewableImage(item)) || files[0];
  if (!file) return;

  const preview = document.createElement("div");
  preview.className = "upload-preview";

  if (isPreviewableImage(file)) {
    const image = document.createElement("img");
    image.src = file.dataUrl || file.url;
    image.alt = file.name || "Uploaded document";
    image.loading = "lazy";
    preview.appendChild(image);
  } else {
    const badge = document.createElement("span");
    badge.className = "upload-preview-file";
    badge.textContent = normalizeFileBadge(file);
    preview.appendChild(badge);
  }

  const status = uploadBox.querySelector(".upload-status");
  uploadBox.insertBefore(preview, status || null);
}

function removeUploadPreview(uploadBox) {
  uploadBox?.querySelector(".upload-preview")?.remove();
}

function isPreviewableImage(file = {}) {
  const type = String(file.type || "").toLowerCase();
  const name = String(file.name || "").toLowerCase();
  return type.startsWith("image/") || /\.(jpg|jpeg|png|gif|webp)$/i.test(name);
}

function normalizeFileBadge(file = {}) {
  const type = String(file.type || "").toLowerCase();
  const name = String(file.name || "").toLowerCase();

  if (type.includes("pdf") || name.endsWith(".pdf")) {
    return "PDF";
  }

  return "FILE";
}

function removeSavedDocument(inputId) {
  const saved = JSON.parse(sessionStorage.getItem("documentsData"));
  if (!saved?.documents?.length) return;

  const aliases = getLegacyDocumentAlias(inputId);
  const documents = saved.documents.map(doc => {
    if (doc.id === inputId || aliases.includes(doc.id)) {
      return {
        ...doc,
        files: []
      };
    }

    return doc;
  });

  sessionStorage.setItem("documentsData", JSON.stringify({
    ...saved,
    documents
  }));
}

function restoreSavedTenantData() {
  const saved = JSON.parse(sessionStorage.getItem("tenantData"));
  if (!saved) {
    return;
  }

  const inputs = document.querySelectorAll(".field-input");
  if (inputs[0]) inputs[0].value = saved.firstName || "";
  if (inputs[1]) inputs[1].value = saved.lastName || "";
  if (inputs[3]) inputs[3].value = saved.phone || "";
  if (inputs[4]) inputs[4].value = saved.birthDate || "";
  if (inputs[6]) inputs[6].value = saved.address || "";
  if (inputs[7]) inputs[7].value = saved.emergencyName || "";
  if (inputs[8]) inputs[8].value = saved.relationship || "";
  if (inputs[9]) inputs[9].value = saved.emergencyPhone || "";
  if (inputs[10]) inputs[10].value = saved.emergencyAlt || "";
  if (inputs[11]) inputs[11].value = saved.emergencyAddress || "";
  restoreSelectedAddons(saved.requestedAddons || []);
}

function summarizeFiles(files) {
  if (!files.length) {
    return "Click to upload";
  }

  const firstFile = files[0];
  const fileName = shortenFileName(firstFile.name);
  return files.length === 1
    ? fileName
    : `${fileName} +${files.length - 1} more`;
}

function shortenFileName(fileName, maxLength = 34) {
  const safeName = String(fileName || "Document");
  if (safeName.length <= maxLength) {
    return safeName;
  }

  const lastDot = safeName.lastIndexOf(".");
  const extension = lastDot > 0 ? safeName.slice(lastDot) : "";
  const baseName = lastDot > 0 ? safeName.slice(0, lastDot) : safeName;
  const available = Math.max(maxLength - extension.length - 3, 12);
  const startLength = Math.ceil(available * 0.58);
  const endLength = Math.floor(available * 0.42);

  return `${baseName.slice(0, startLength)}...${baseName.slice(-endLength)}${extension}`;
}

function readFileForStorage(file) {
  return sanitizeImageBeforeStorage(file);
}

function getFileTypeFromName(fileName) {
  const extension = String(fileName || "").split(".").pop().toLowerCase();
  if (!extension || extension === fileName) return "File";
  return extension.toUpperCase();
}

function getFileExtension(fileName) {
  const safeName = String(fileName || "").trim().toLowerCase();
  const parts = safeName.split(".");
  return parts.length > 1 ? parts.pop() : "";
}

function validateImageFileMeta(file) {
  const mimeType = String(file?.type || "").trim().toLowerCase();
  const extension = getFileExtension(file?.name);

  if (!ALLOWED_UPLOAD_TYPES.includes(mimeType) || !ALLOWED_UPLOAD_EXTENSIONS.includes(extension)) {
    throw new Error("Only JPG and PNG image files are allowed.");
  }
}

async function readFileAsArrayBuffer(file) {
  return file.arrayBuffer();
}

function validateImageSignature(file, buffer) {
  const bytes = new Uint8Array(buffer);
  const extension = getFileExtension(file?.name);
  const mimeType = String(file?.type || "").trim().toLowerCase();
  const isJpegSignature = bytes.length >= 3
    && bytes[0] === 0xFF
    && bytes[1] === 0xD8
    && bytes[2] === 0xFF;
  const isPngSignature = bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4E
    && bytes[3] === 0x47
    && bytes[4] === 0x0D
    && bytes[5] === 0x0A
    && bytes[6] === 0x1A
    && bytes[7] === 0x0A;

  if (mimeType === "image/jpeg" || extension === "jpg" || extension === "jpeg") {
    if (!isJpegSignature) {
      throw new Error("One of the selected JPG files is invalid or corrupted.");
    }
    return "image/jpeg";
  }

  if (mimeType === "image/png" || extension === "png") {
    if (!isPngSignature) {
      throw new Error("One of the selected PNG files is invalid or corrupted.");
    }
    return "image/png";
  }

  throw new Error("Only JPG and PNG image files are allowed.");
}

function loadImageElement(blob) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Unable to read the selected image."));
    };
    image.src = objectUrl;
  });
}

function canvasToBlob(canvas, mimeType) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Unable to prepare the selected image for upload."));
        return;
      }
      resolve(blob);
    }, mimeType, mimeType === "image/jpeg" ? 0.92 : undefined);
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error || new Error("Unable to prepare image preview."));
    reader.readAsDataURL(blob);
  });
}

async function sanitizeImageBeforeStorage(file) {
  validateImageFileMeta(file);
  const buffer = await readFileAsArrayBuffer(file);
  const normalizedMimeType = validateImageSignature(file, buffer);
  const sourceBlob = new Blob([buffer], { type: normalizedMimeType });
  const image = await loadImageElement(sourceBlob);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Unable to prepare the selected image for upload.");
  }

  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const cleanBlob = await canvasToBlob(canvas, normalizedMimeType);
  const dataUrl = await blobToDataUrl(cleanBlob);
  const extension = normalizedMimeType === "image/png" ? "png" : "jpg";
  const baseName = String(file.name || "document")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .slice(0, 40) || "document";

  return {
    name: `${baseName}.${extension}`,
    size: cleanBlob.size,
    type: normalizedMimeType,
    dataUrl
  };
}

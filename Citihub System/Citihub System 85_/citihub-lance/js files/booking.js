auth.onAuthStateChanged(async (user) => {
  if (!user) return;

  window.currentUserId = user.uid;

  const cachedGender = sessionStorage.getItem("userGender");
  const cachedName = sessionStorage.getItem("bookingHeaderName");
  const cachedRoom = sessionStorage.getItem("bookingHeaderRoom");

  if (cachedGender) {
    window.currentUserGender = cachedGender;
  }

  updateBookingHeader({
    name: cachedName || user.displayName || user.email || "Tenant",
    room: cachedRoom || ""
  });

  try {
    const doc = await db.collection("users").doc(user.uid).get();

    if (doc.exists) {
      const userData = doc.data();
      const gender = (userData.gender || "").toLowerCase();

      window.currentUserGender = gender;
      sessionStorage.setItem("userGender", gender);
      sessionStorage.setItem("bookingHeaderName", userData.fullName || userData.username || user.displayName || user.email || "Tenant");
      sessionStorage.setItem("bookingHeaderRoom", userData.room || "");

      updateBookingHeader({
        name: userData.fullName || userData.username || user.displayName || user.email || "Tenant",
        room: userData.room || ""
      });

      if (await userHasActiveTransientBed(user.uid)) {
        sessionStorage.setItem("bookingRestrictionMessage", "You already have an active Transient Bed request, so monthly booking is temporarily disabled.");
        window.location.href = "main.html";
        return;
      }

      if (await userHasBlockedMonthlyRequest(user.uid)) {
        window.location.href = "main.html";
        return;
      }
    }
  } catch (err) {
    console.error("Error loading user:", err);
  } finally {
    window.hidePageLoader?.();
  }
});

function getUserInitials(name) {
  return String(name || "Tenant")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("") || "CT";
}

function updateBookingHeader({ name, room }) {
  const welcomeEl = document.getElementById("bookingWelcomeText");
  const roomEl = document.getElementById("bookingRoomText");
  const avatarEl = document.getElementById("bookingAvatarText");

  if (welcomeEl) {
    const firstName = String(name || "Tenant").trim().split(/\s+/)[0] || "Tenant";
    welcomeEl.textContent = `Welcome, ${firstName}`;
  }

  if (roomEl) {
    roomEl.textContent = room
      ? `${room} tenant access`
      : "Choose your preferred room";
  }

  if (avatarEl) {
    avatarEl.textContent = getUserInitials(name);
  }
}

async function ensureCurrentUserGender() {
  const cachedGender = String(window.currentUserGender || sessionStorage.getItem("userGender") || "").trim().toLowerCase();
  if (cachedGender) {
    window.currentUserGender = cachedGender;
    return cachedGender;
  }

  const userId = window.currentUserId || firebase.auth().currentUser?.uid;
  if (!userId) {
    return "";
  }

  try {
    const doc = await db.collection("users").doc(userId).get();
    const fetchedGender = String(doc.data()?.gender || "").trim().toLowerCase();
    if (fetchedGender) {
      window.currentUserGender = fetchedGender;
      sessionStorage.setItem("userGender", fetchedGender);
      return fetchedGender;
    }
  } catch (error) {
    console.error("Failed to load user gender for booking:", error);
  }

  return "";
}
//  STATE 
let selectedBed   = null;
let currentType   = null;
let selectedLease = null;
let pendingBookingRestore = null;
let transientUnavailableBeds = new Map();
let fillupRedirectTimeout = null;

async function callBookingApi(path, payload) {
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
    throw new Error(result.error || "Unable to check bedspace availability.");
  }

  return result;
}

async function userHasActiveTransientBed(userId) {
  const snapshot = await db.collection("transientBedBookings")
    .where("userId", "==", userId)
    .get();

  return snapshot.docs.some((doc) => {
    return ["pending_payment", "pending", "approved", "checked_in"].includes(doc.data().status);
  });
}

async function userHasBlockedMonthlyRequest(userId) {
  const revisionReferenceId = sessionStorage.getItem("bookingDraftReferenceId");
  const snapshot = await db.collection("bookingRequest")
    .where("userId", "==", userId)
    .where("status", "in", ["pending", "approved", "rejected"])
    .get();

  if (snapshot.empty) {
    return false;
  }

  const activeDoc = snapshot.docs.find((doc) => ["pending", "approved"].includes(doc.data()?.status));
  if (activeDoc) {
    sessionStorage.setItem("bookingRestrictionMessage", "You already have an active monthly booking request.");
    return true;
  }

  const rejectedDoc = snapshot.docs.find((doc) => doc.data()?.status === "rejected");
  if (
    rejectedDoc &&
    revisionReferenceId &&
    (rejectedDoc.id === revisionReferenceId || rejectedDoc.data()?.referenceId === revisionReferenceId)
  ) {
    sessionStorage.removeItem("bookingRestrictionMessage");
    return false;
  }

  sessionStorage.setItem(
    "bookingRestrictionMessage",
    rejectedDoc
      ? "Please edit and resubmit your rejected booking request instead of creating a new one."
      : "You already have an active monthly booking request."
  );
  return true;
}

function getMoveInDateInput() {
  return document.getElementById("preferredMoveInDate");
}

function getMoveInTimeInput() {
  return document.getElementById("preferredMoveInTime");
}

function isAllowedMoveInWeekday(dateValue) {
  const parsed = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }

  const day = parsed.getDay();
  return day >= 2 && day <= 6;
}

function isAllowedMoveInTime(timeValue) {
  if (!/^\d{2}:\d{2}$/.test(String(timeValue || ""))) {
    return false;
  }

  const [hours, minutes] = String(timeValue).split(":").map(Number);
  const totalMinutes = (hours * 60) + minutes;
  return totalMinutes >= (9 * 60) && totalMinutes <= (18 * 60);
}

function updateMoveInHelp(message, tone = "default") {
  const help = document.getElementById("moveInHelpText");
  if (!help) return;
  help.textContent = message;
  help.classList.remove("error", "success");
  if (tone === "error" || tone === "success") {
    help.classList.add(tone);
  }
}

function setMinimumMoveInDate() {
  const dateInput = getMoveInDateInput();
  const timeInput = getMoveInTimeInput();
  if (!dateInput) return;

  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  dateInput.min = `${yyyy}-${mm}-${dd}`;

  if (timeInput) {
    timeInput.min = "09:00";
    timeInput.max = "18:00";
    timeInput.step = 1800;
  }
}

function formatMoveInDateForDisplay(dateValue) {
  if (!dateValue) return "No date selected";
  const parsed = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return dateValue;
  return parsed.toLocaleDateString("en-PH", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });
}

function formatMoveInTimeForDisplay(timeValue) {
  if (!timeValue) return "No time selected";
  const [hours, minutes] = String(timeValue).split(":");
  if (hours == null || minutes == null) return timeValue;
  const parsed = new Date();
  parsed.setHours(Number(hours), Number(minutes), 0, 0);
  return parsed.toLocaleTimeString("en-PH", {
    hour: "numeric",
    minute: "2-digit"
  });
}

function getSelectedMoveInSchedule() {
  const dateValue = getMoveInDateInput()?.value || "";
  const timeValue = getMoveInTimeInput()?.value || "";

  return {
    moveInDate: dateValue,
    moveInTime: timeValue,
    moveInDateDisplay: formatMoveInDateForDisplay(dateValue),
    moveInTimeDisplay: formatMoveInTimeForDisplay(timeValue)
  };
}

function validateMoveInSchedule(showFeedback = true) {
  const { moveInDate, moveInTime } = getSelectedMoveInSchedule();

  if (!moveInDate || !moveInTime) {
    if (showFeedback) {
      updateMoveInHelp("Please choose both your preferred move-in date and time before confirming your booking.", "error");
    }
    return false;
  }

  if (!isAllowedMoveInWeekday(moveInDate)) {
    if (showFeedback) {
      updateMoveInHelp("Move-in is available only from Tuesday to Saturday.", "error");
    }
    return false;
  }

  if (!isAllowedMoveInTime(moveInTime)) {
    if (showFeedback) {
      updateMoveInHelp("Move-in time must be between 9:00 AM and 6:00 PM.", "error");
    }
    return false;
  }

  if (showFeedback) {
    updateMoveInHelp("Your preferred move-in schedule has been saved and will be included in your application.", "success");
  }
  return true;
}

function getMoveInScheduleCard() {
  return document.getElementById("moveInScheduleCard");
}

function showMoveInScheduleCard() {
  const card = getMoveInScheduleCard();
  if (card) {
    card.style.display = "block";
    card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

function hideMoveInScheduleCard() {
  const card = getMoveInScheduleCard();
  if (card) {
    card.style.display = "none";
  }
}

function updateConfirmButtonState() {
  const confirmBtn = document.getElementById('confirmBtn');
  if (!confirmBtn) return;
  const hasValidSchedule = validateMoveInSchedule(false);
  confirmBtn.classList.toggle('ready', Boolean(selectedBed && hasValidSchedule));
}

function proceedToFillupPage() {
  if (fillupRedirectTimeout) {
    clearTimeout(fillupRedirectTimeout);
    fillupRedirectTimeout = null;
  }

  window.location.href = "fillup.html";
}

//  LEASE DATA 
const leaseData = {
  standard: [
    { label: '1 - 5 Months',  termKey: '1_5_months', price: '3,600', monthlyRate: 3600, contractMonths: 5, tag: 'Short Stay', tagClass: 'tag-short', desc: 'Flexible short-term stay. Great for internships or trial periods.' },
    { label: '6 - 11 Months', termKey: '6_11_months', price: '2,893', monthlyRate: 2893, contractMonths: 11, tag: 'Mid Term',   tagClass: 'tag-mid',   desc: 'Best balance of flexibility and savings for semester stays.' },
    { label: '1 Year',        termKey: '1_year', price: '1,900', monthlyRate: 1900, contractMonths: 12, tag: 'Best Value', tagClass: 'tag-best',  desc: 'Lowest monthly rate. Ideal for full academic year residents.' },
  ],
  premium: [
    { label: '1 - 5 Months',  termKey: '1_5_months', price: '5,075', monthlyRate: 5075, contractMonths: 5, tag: 'Short Stay', tagClass: 'tag-short', desc: 'Flexible short-term stay with full aircon comfort.' },
    { label: '6 - 11 Months', termKey: '6_11_months', price: '4,095', monthlyRate: 4095, contractMonths: 11, tag: 'Mid Term',   tagClass: 'tag-mid',   desc: 'Save more with a longer commitment. Includes all amenities.' },
    { label: '1 Year',        termKey: '1_year', price: '2,500', monthlyRate: 2500, contractMonths: 12, tag: 'Best Value', tagClass: 'tag-best',  desc: 'Maximum savings. Full year of aircon comfort included.' },
  ]
};

async function loadTransientUnavailableBeds() {
  const { moveInDate } = getSelectedMoveInSchedule();
  if (!moveInDate || !currentType) {
    transientUnavailableBeds = new Map();
    return;
  }

  const payload = await callBookingApi("/api/transient-beds/unavailable-for-monthly", {
    moveInDate,
    roomType: currentType
  });

  transientUnavailableBeds = new Map(
    (payload.unavailableBeds || []).map((item) => [item.key, item])
  );
}

//  LOAD ROOMS FROM FIRESTORE 
async function loadRooms() {
  const { moveInDate } = getSelectedMoveInSchedule();
  const userGender = await ensureCurrentUserGender();
  const container  = document.getElementById("roomsContainer");

  if (!container) {
    return;
  }

  if (!userGender) {
    container.innerHTML = '<div style="color:#ef4444;font-size:13px;padding:16px 0;">We could not load your profile gender for booking. Please refresh the page or complete your account details first.</div>';
    return;
  }

  if (!moveInDate) {
    container.innerHTML = '<div style="color:#9ca3af;font-size:13px;padding:16px 0;">Choose your move-in date first to view bedspaces that are available for your schedule.</div>';
    return;
  }

  container.innerHTML = '<div style="color:#9ca3af;font-size:13px;padding:16px 0;">Loading bedspaces...</div>';

  let rooms = {};

  try {
    await loadTransientUnavailableBeds();
    const querySnapshot = await db.collection("ROOMS").get();

    querySnapshot.forEach((doc) => {
      const data  = doc.data();
      const parts = doc.id.split("_");
      const roomId = parts[0];
      const bedNo  = parts[1];

      if (!rooms[roomId]) {
        rooms[roomId] = { type: data.type, gender: data.gender, beds: [] };
      }
      rooms[roomId].beds.push({ ...data, bedNo });
    });

    container.innerHTML = "";

    for (let roomId in rooms) {
      const room       = rooms[roomId];
      const roomGender = (room.gender || "").toLowerCase();
      const roomType   = (room.type   || "").toLowerCase();

      if (currentType && roomType !== currentType) continue;
      if (roomGender !== "mixed" && userGender !== "mixed" && roomGender !== userGender) continue;

      let bedsHTML = "";

room.beds
  .sort((a, b) => {
    const numA = parseInt(a.bedNo.toString().replace(/\D/g, "")) || 0;
    const numB = parseInt(b.bedNo.toString().replace(/\D/g, "")) || 0;
    return numA - numB;
  })
  .forEach((bed) => {

    const transientHold = transientUnavailableBeds.get(`${roomId}_${bed.bedNo}`);
    const status = transientHold ? "transient" : (bed.avail || "Available").toLowerCase();
    const statusText = status === "occupied"
      ? " Occupied"
      : status === "transient"
        ? `Transient until ${formatMoveInDateForDisplay(transientHold.checkOutDate)}`
        : "Available";

    bedsHTML += `
      <div class="bed-box ${status} ${status !== 'available' ? 'disabled' : ''}"
        data-bed="${bed.bedNo}"
        data-room="${roomId}"
        data-type="${bed.type}"
        data-gender="${bed.gender}"
        ${status === 'available' ? 'onclick="selectBed(this)"' : ''}>
        
        <div class="bed-num">${bed.bedNo}</div>

        <div class="bed-status-label">
          ${statusText}
        </div>

      </div>
    `;
  });

      container.insertAdjacentHTML("beforeend", `
        <div class="room-section" data-type="${room.type}" data-gender="${room.gender}">
          <div class="room-section-header">
            <span class="room-section-name">${roomId}</span>
            <span class="gender-tag ${roomGender}">
              ${room.gender === "Female" ? " Female" : room.gender === "Male" ? " Male" : " Mixed"}
            </span>
          </div>
          <div class="beds-grid">${bedsHTML}</div>
        </div>`);
    }

    if (pendingBookingRestore && pendingBookingRestore.type === currentType) {
      const selector = `.bed-box[data-room="${pendingBookingRestore.room}"][data-bed="${pendingBookingRestore.bed}"]`;
      const bedBox = container.querySelector(selector);
      if (bedBox) {
        selectBed(bedBox);
      }
      pendingBookingRestore = null;
    }
  } catch (error) {
    console.error("Failed to load bedspaces:", error);
    container.innerHTML = `<div style="color:#ef4444;font-size:13px;padding:16px 0;">${error.message || "Unable to load bedspaces right now."}</div>`;
  }
}

//  OPEN MODAL -> shows lease step first 
function openModal(type) {
  currentType   = type;
  selectedLease = null;
  selectedBed   = null;

  // Set modal title + room label
  const isPremium = type === 'premium';
  document.getElementById('modalTitle').textContent = isPremium ? 'Aircon Room - Booking' : 'Fan Room - Booking';
  document.getElementById('lsiIcon').textContent    = isPremium ? '' : '';
  document.getElementById('lsiTitle').textContent   = isPremium ? 'Aircon Room' : 'Fan Room';

  // Show correct lease card set, hide the other
  document.getElementById('leaseCardsStandard').style.display = isPremium ? 'none' : 'flex';
  document.getElementById('leaseCardsPremium').style.display  = isPremium ? 'flex' : 'none';

  // Reset all card selections
  document.querySelectorAll('.lease-option-card').forEach(c => {
    c.classList.remove('selected');
    const ind = c.querySelector('.loc-select-indicator');
    if (ind) ind.textContent = ' Select';
  });

  showLeaseStep();
  document.getElementById('bookingModal').style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

//  SHOW STEP 1: LEASE TERM 
function showLeaseStep() {
  document.getElementById('stepLease').style.display = 'block';
  document.getElementById('stepBed').style.display   = 'none';

  document.getElementById('nextToBedsBtn').style.display = 'none';
  document.getElementById('confirmBtn').style.display    = 'none';
  document.getElementById('footerBackBtn').style.display = 'none';
  document.getElementById('footerSelected').textContent  = 'Select a lease term to continue';

  document.getElementById('ms-lease').classList.add('active');
  document.getElementById('ms-bed').classList.remove('active');
}

//  SELECT A LEASE CARD 
function selectLease(index, card, type) {
  const containerId = type === 'premium' ? 'leaseCardsPremium' : 'leaseCardsStandard';
  document.getElementById(containerId).querySelectorAll('.lease-option-card').forEach(c => {
    c.classList.remove('selected');
    const ind = c.querySelector('.loc-select-indicator');
    if (ind) ind.textContent = ' Select';
  });

  card.classList.add('selected');
  const ind = card.querySelector('.loc-select-indicator');
  if (ind) ind.textContent = ' Selected';

  selectedLease = leaseData[currentType][index];
  document.getElementById('footerSelected').textContent = `${selectedLease.label}  ${selectedLease.price}/mo`;
  document.getElementById('nextToBedsBtn').style.display = 'inline-flex';
}

//  GO TO STEP 2: BEDSPACE 
function goToBeds() {
  if (!selectedLease) return;

  document.getElementById('stepLease').style.display = 'none';
  document.getElementById('stepBed').style.display   = 'block';

  document.getElementById('nextToBedsBtn').style.display = 'none';
  document.getElementById('confirmBtn').style.display    = 'block';
  document.getElementById('footerBackBtn').style.display = 'inline-flex';
  document.getElementById('footerSelected').textContent  = 'No bedspace selected';

  document.getElementById('ms-lease').classList.remove('active');
  document.getElementById('ms-bed').classList.add('active');

  showMoveInScheduleCard();
  updateMoveInHelp("Choose your move-in date first. Available bedspaces will appear for that date, then add your move-in time before confirming.");
  loadRooms();
  clearSelection();
}

//  GO BACK TO STEP 1 
function goBackToLease() {
  selectedBed = null;
  hideMoveInScheduleCard();
  showLeaseStep();

  // Re-highlight previously chosen lease card
  if (selectedLease) {
    const data        = leaseData[currentType];
    const idx         = data.findIndex(d => d.label === selectedLease.label);
    const containerId = currentType === 'premium' ? 'leaseCardsPremium' : 'leaseCardsStandard';
    const cards       = document.getElementById(containerId).querySelectorAll('.lease-option-card');
    if (cards[idx]) selectLease(idx, cards[idx], currentType);
  }
}

//  CLOSE MODAL 
function closeModal() {
  document.getElementById('bookingModal').style.display = 'none';
  document.body.style.overflow = '';
  selectedLease = null;
  selectedBed   = null;
  hideMoveInScheduleCard();
  clearSelection();
}

//  SELECT A BED 
function selectBed(box) {
  if (box.classList.contains('occupied') || box.classList.contains('transient')) return;

  if (selectedBed) selectedBed.classList.remove('selected');

  if (selectedBed === box) {
    selectedBed = null;
    document.getElementById('footerSelected').textContent = 'No bedspace selected';
    hideMoveInScheduleCard();
    updateConfirmButtonState();
    return;
  }

  selectedBed = box;
  box.classList.add('selected');

  const room  = box.dataset.room;
  const bed   = box.dataset.bed;
  const lease = selectedLease ? `  ${selectedLease.label}  ${selectedLease.price}/mo` : '';
  document.getElementById('footerSelected').textContent = `${room}  Bedspace ${bed}${lease}`;
  showMoveInScheduleCard();
  updateMoveInHelp("Choose your preferred move-in date and time for this selected bedspace.");
  updateConfirmButtonState();
}

function clearSelection() {
  if (selectedBed) {
    selectedBed.classList.remove('selected');
    selectedBed = null;
  }
  document.getElementById('footerSelected').textContent = 'No bedspace selected';
  updateConfirmButtonState();
}

async function selectedBedHasTransientConflict() {
  if (!selectedBed) return false;
  await loadTransientUnavailableBeds();
  const key = `${selectedBed.dataset.room}_${selectedBed.dataset.bed}`;
  return transientUnavailableBeds.has(key);
}

//  CONFIRM BOOKING 
async function confirmBooking() {
  if (!selectedBed) return;
  if (!validateMoveInSchedule(true)) return;
  try {
    if (await selectedBedHasTransientConflict()) {
      updateMoveInHelp("This bedspace has a Transient Bed reservation that conflicts with your move-in date. Please choose another bedspace or date.", "error");
      clearSelection();
      await loadRooms();
      return;
    }
  } catch (error) {
    console.error("Failed to verify transient bed conflict before continuing:", error);
  }

  const room  = selectedBed.dataset.room;
  const bed   = selectedBed.dataset.bed;
  const moveInSchedule = getSelectedMoveInSchedule();

  const bookingData = {
    room: room,
    bed: bed,
    type: currentType,
    contractType: currentType,
    contractTerm: selectedLease?.termKey || "",
    contractLabel: selectedLease?.label || "",
    contractMonths: Number(selectedLease?.contractMonths || 0),
    monthlyRate: Number(selectedLease?.monthlyRate || 0),
    leaseLabel: selectedLease?.label || "",
    leasePrice: selectedLease?.price || "",
    moveInDate: moveInSchedule.moveInDate,
    moveInTime: moveInSchedule.moveInTime,
    moveInDateDisplay: moveInSchedule.moveInDateDisplay,
    moveInTimeDisplay: moveInSchedule.moveInTimeDisplay
  };

  sessionStorage.removeItem("transientBookingData");
  sessionStorage.removeItem("transientDraftReferenceId");
  sessionStorage.setItem("bookingData", JSON.stringify(bookingData));

  closeModal();

  document.getElementById('successText').textContent =
    `Your request for ${room}  Bedspace ${bed}  ${bookingData.leaseLabel} (${bookingData.leasePrice}/mo) with move-in on ${bookingData.moveInDateDisplay} at ${bookingData.moveInTimeDisplay} has been submitted. Fill out the form on the next page to complete your booking.`;

  document.getElementById('successModal').style.display = 'flex';
  proceedToFillupPage();

  console.log('Booking saved:', bookingData);
}

function restoreSavedBookingSelection() {
  const saved = JSON.parse(sessionStorage.getItem("bookingData") || "null");
  if (!saved || !saved.type || !saved.room || !saved.bed) {
    return;
  }

  if (saved.moveInDate && getMoveInDateInput()) {
    getMoveInDateInput().value = saved.moveInDate;
  }

  if (saved.moveInTime && getMoveInTimeInput()) {
    getMoveInTimeInput().value = saved.moveInTime;
  }

  if (saved.moveInDate && saved.moveInTime) {
    updateMoveInHelp("Your previously selected move-in schedule has been restored.", "success");
  }

  pendingBookingRestore = saved;
  openModal(String(saved.type).toLowerCase());

  const typeKey = String(saved.type).toLowerCase();
  const leaseOptions = leaseData[typeKey] || [];
  const leaseIndex = leaseOptions.findIndex((option) => {
    return option.label === saved.leaseLabel && option.price === saved.leasePrice;
  });

  if (leaseIndex >= 0) {
    const containerId = typeKey === "premium" ? "leaseCardsPremium" : "leaseCardsStandard";
    const cards = document.getElementById(containerId)?.querySelectorAll(".lease-option-card") || [];
    const card = cards[leaseIndex];

    if (card) {
      selectLease(leaseIndex, card, typeKey);
      goToBeds();
    }
  }
}

//  AUTO-OPEN FROM URL PARAM 
const params  = new URLSearchParams(location.search);
const preType = params.get('type');
if (preType) {
  window.addEventListener('DOMContentLoaded', () => {
    setMinimumMoveInDate();
    openModal(preType.toLowerCase());
  });
} else {
  window.addEventListener('DOMContentLoaded', () => {
    setMinimumMoveInDate();
    restoreSavedBookingSelection();
  });
}

//  CLOSE ON OVERLAY CLICK 
document.getElementById('bookingModal').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});
document.getElementById('successModal').addEventListener('click', function(e) {
  if (e.target === this) this.style.display = 'none';
});

document.getElementById("preferredMoveInDate")?.addEventListener("change", () => {
  const dateInput = getMoveInDateInput();
  if (dateInput?.value && !isAllowedMoveInWeekday(dateInput.value)) {
    dateInput.value = "";
    updateMoveInHelp("Move-in is available only from Tuesday to Saturday.", "error");
  }
  validateMoveInSchedule(false);
  updateConfirmButtonState();
  if (selectedBed) {
    selectedBedHasTransientConflict().then(async (hasConflict) => {
      if (hasConflict) {
        updateMoveInHelp("This selected bedspace is reserved for a Transient Bed stay on that move-in date. Please choose another date or bedspace.", "error");
        clearSelection();
        await loadRooms();
      }
    }).catch((error) => {
      console.error("Failed to check selected bedspace availability:", error);
      updateMoveInHelp(error.message || "Unable to check selected bedspace availability.", "error");
    });
  } else if (document.getElementById('stepBed')?.style.display === 'block') {
    clearSelection();
    loadRooms();
  }
});

document.getElementById("preferredMoveInTime")?.addEventListener("change", () => {
  const timeInput = getMoveInTimeInput();
  if (timeInput?.value && !isAllowedMoveInTime(timeInput.value)) {
    timeInput.value = "";
    updateMoveInHelp("Move-in time must be between 9:00 AM and 6:00 PM.", "error");
  }
  validateMoveInSchedule(false);
  updateConfirmButtonState();
  if (document.getElementById('stepBed')?.style.display === 'block') {
    if (selectedBed) {
      selectedBedHasTransientConflict().then(async (hasConflict) => {
        if (hasConflict) {
          updateMoveInHelp("This selected bedspace is reserved for a Transient Bed stay on that move-in date. Please choose another date or bedspace.", "error");
          clearSelection();
          await loadRooms();
        }
      }).catch((error) => {
        console.error("Failed to check selected bedspace availability:", error);
        updateMoveInHelp(error.message || "Unable to check selected bedspace availability.", "error");
      });
    } else {
      loadRooms();
    }
  }
});

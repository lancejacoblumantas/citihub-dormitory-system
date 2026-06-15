const TRANSIENT_RATES = {
    standard: 250,
    premium: 500
};

let transientUserData = null;
let transientUserGender = "";
let selectedRoom = "";
let selectedBed = "";
let submittingTransient = false;
let toastTimer = null;

function showToast(message) {
    const toast = document.getElementById("toast");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function getInitials(name) {
    return String(name || "CT")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part.charAt(0).toUpperCase())
        .join("") || "CT";
}

function formatCurrency(amount) {
    return new Intl.NumberFormat("en-PH", {
        style: "currency",
        currency: "PHP"
    }).format(Number(amount || 0));
}

function formatDate(value) {
    const date = value?.toDate?.() || new Date(`${value}T00:00:00`);
    if (Number.isNaN(date.getTime())) return "Unavailable";
    return new Intl.DateTimeFormat("en-PH", {
        month: "short",
        day: "numeric",
        year: "numeric"
    }).format(date);
}

function getTodayValue(offset = 0) {
    const date = new Date();
    date.setDate(date.getDate() + offset);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function getStayDetails() {
    const roomType = document.getElementById("roomType")?.value || "standard";
    const checkInDate = document.getElementById("checkInDate")?.value || "";
    const checkOutDate = document.getElementById("checkOutDate")?.value || "";
    const start = new Date(`${checkInDate}T00:00:00`);
    const end = new Date(`${checkOutDate}T00:00:00`);
    const nights = Math.max(0, Math.round((end - start) / (1000 * 60 * 60 * 24)));
    const ratePerDay = TRANSIENT_RATES[roomType] || TRANSIENT_RATES.standard;
    return {
        roomType,
        checkInDate,
        checkOutDate,
        nights,
        ratePerDay,
        totalAmount: ratePerDay * nights
    };
}

function updateSummary() {
    const details = getStayDetails();
    const nightsText = document.getElementById("nightsText");
    const amountText = document.getElementById("amountText");
    const selectedStayText = document.getElementById("selectedStayText");

    if (nightsText) {
        nightsText.textContent = `${details.nights || 0} ${details.nights === 1 ? "day" : "days"}`;
    }

    if (amountText) {
        amountText.textContent = formatCurrency(details.totalAmount);
    }

    if (selectedStayText) {
        selectedStayText.textContent = details.nights > 0
            ? `${formatDate(details.checkInDate)} to ${formatDate(details.checkOutDate)} at ${formatCurrency(details.ratePerDay)} per day.`
            : "Choose valid check-in and check-out dates.";
    }
}

function setDefaultDates() {
    const checkIn = document.getElementById("checkInDate");
    const checkOut = document.getElementById("checkOutDate");
    if (!checkIn || !checkOut) return;

    checkIn.min = getTodayValue();
    checkOut.min = getTodayValue(1);
    checkIn.value = checkIn.value || getTodayValue();
    checkOut.value = checkOut.value || getTodayValue(1);
}

function updateSelectedBed(room, bed) {
    selectedRoom = room;
    selectedBed = bed;
    document.querySelectorAll(".bed-btn").forEach((button) => {
        button.classList.toggle("selected", button.dataset.room === room && button.dataset.bed === bed);
    });

    const selectedBedText = document.getElementById("selectedBedText");
    if (selectedBedText) {
        selectedBedText.textContent = selectedRoom && selectedBed
            ? `Room ${selectedRoom}, Bed ${selectedBed}`
            : "None selected";
    }
}

async function loadBedspaces() {
    const roomType = document.getElementById("roomType")?.value || "standard";
    const userGender = String(transientUserGender || "").toLowerCase();
    const list = document.getElementById("bedsList");
    if (!list) return;

    if (!userGender) {
        list.innerHTML = `<div class="empty-state">Your profile gender is needed before bedspace choices can be shown.</div>`;
        return;
    }

    list.innerHTML = `<div class="empty-state">Loading bedspaces...</div>`;

    try {
        const snapshot = await db.collection("ROOMS").get();
        const rooms = {};
        snapshot.forEach((doc) => {
            const data = doc.data();
            const [roomId, bedNo] = doc.id.split("_");
            const roomGender = String(data.gender || "").toLowerCase();
            if (String(data.type || "").toLowerCase() !== roomType) return;
            if (String(data.avail || "Available").toLowerCase() !== "available") return;
            if (roomGender !== "mixed" && userGender !== "mixed" && roomGender !== userGender) return;
            if (!rooms[roomId]) {
                rooms[roomId] = {
                    gender: data.gender || "Mixed",
                    beds: []
                };
            }
            rooms[roomId].beds.push({ bedNo, ...data });
        });

        const roomIds = Object.keys(rooms).sort();
        if (!roomIds.length) {
            list.innerHTML = `<div class="empty-state">No vacant ${roomType} bedspaces are available right now.</div>`;
            updateSelectedBed("", "");
            return;
        }

        list.innerHTML = roomIds.map((roomId) => {
            const beds = rooms[roomId].beds
                .sort((left, right) => Number(String(left.bedNo).replace(/\D/g, "")) - Number(String(right.bedNo).replace(/\D/g, "")))
                .map((bed) => `<button type="button" class="bed-btn" data-room="${roomId}" data-bed="${bed.bedNo}">Bed ${bed.bedNo}</button>`)
                .join("");

            return `
                <div class="room-block">
                    <div class="room-head">
                        <span>Room ${roomId}</span>
                        <span>${rooms[roomId].gender}</span>
                    </div>
                    <div class="bed-grid">${beds}</div>
                </div>
            `;
        }).join("");

        list.querySelectorAll(".bed-btn").forEach((button) => {
            button.addEventListener("click", () => updateSelectedBed(button.dataset.room, button.dataset.bed));
        });
    } catch (error) {
        console.error("Failed to load transient bedspaces:", error);
        list.innerHTML = `<div class="empty-state">Unable to load bedspaces right now.</div>`;
    }
}

async function callTransientApi(path, payload) {
    const user = firebase.auth().currentUser;
    if (!user) throw new Error("You must be signed in to continue.");

    const token = await user.getIdToken();
    const response = await fetch(`${window.CITIHUB_API_BASE_URL}${path}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify(payload || {})
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(result.error || "Request failed.");
    }

    return result;
}

async function submitTransientBooking() {
    if (submittingTransient) return;
    const details = getStayDetails();
    const button = document.getElementById("checkoutBtn");

    if (!selectedRoom || !selectedBed) {
        showToast("Please choose a bedspace first.");
        return;
    }

    if (!details.checkInDate || !details.checkOutDate || details.nights < 1) {
        showToast("Please choose a valid stay of at least one day.");
        return;
    }

    submittingTransient = true;
    if (button) {
        button.disabled = true;
        button.textContent = "Saving selection...";
    }

    try {
        sessionStorage.removeItem("bookingData");
        sessionStorage.removeItem("bookingDraftReferenceId");
        sessionStorage.setItem("transientBookingData", JSON.stringify({
            roomType: details.roomType,
            room: selectedRoom,
            bed: selectedBed,
            checkInDate: details.checkInDate,
            checkOutDate: details.checkOutDate,
            nights: details.nights,
            ratePerDay: details.ratePerDay,
            totalAmount: details.totalAmount
        }));
        window.location.href = "fillup.html?mode=transient";
    } catch (error) {
        console.error("Failed to save Transient Bed selection:", error);
        showToast(error.message || "Unable to continue right now.");
        submittingTransient = false;
        if (button) {
            button.disabled = false;
            button.textContent = "Continue to Personal Information";
        }
    }
}

function openTransientPayment(bookingId) {
    if (!bookingId) return;
    sessionStorage.setItem("activeTransientPaymentId", bookingId);
    window.location.href = `payment.html?type=transient&transientBookingId=${encodeURIComponent(bookingId)}`;
}

function renderHistory(bookings) {
    const list = document.getElementById("transientHistory");
    if (!list) return;

    if (!bookings.length) {
        list.innerHTML = `<div class="empty-state">No transient bed requests yet.</div>`;
        return;
    }

    list.innerHTML = bookings.map((booking) => `
        <div class="history-item">
            <div>
                <div class="history-title">Room ${booking.room}, Bed ${booking.bed} - ${formatCurrency(booking.totalAmount)}</div>
                <div class="history-sub">${formatDate(booking.checkInDate)} to ${formatDate(booking.checkOutDate)} - ${booking.nights} ${booking.nights === 1 ? "day" : "days"} - ${booking.referenceId || ""}</div>
                <div class="history-sub">Payment: ${booking.paymentStatus || "unpaid"}</div>
            </div>
            <div>
                <div class="status-pill ${booking.status || ""}">${String(booking.status || "pending").replace(/_/g, " ")}</div>
                ${booking.status === "approved" && booking.paymentStatus !== "paid" ? `<button type="button" class="history-pay-btn" data-pay-id="${booking.id}">Pay Approved Bill</button>` : ""}
            </div>
        </div>
    `).join("");

    list.querySelectorAll(".history-pay-btn").forEach((button) => {
        button.addEventListener("click", () => openTransientPayment(button.dataset.payId));
    });
}

function subscribeHistory(userId) {
    db.collection("transientBedBookings")
        .where("userId", "==", userId)
        .onSnapshot((snapshot) => {
            const bookings = snapshot.docs
                .map((doc) => ({ id: doc.id, ...doc.data() }))
                .sort((left, right) => {
                    const leftDate = left.createdAt?.toDate?.() || new Date(0);
                    const rightDate = right.createdAt?.toDate?.() || new Date(0);
                    return rightDate - leftDate;
                });
            renderHistory(bookings);
        }, (error) => {
            console.error("Failed to load Transient Bed history:", error);
        });
}

async function handlePaymentReturn() {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("result");
    const paymentId = params.get("paymentId");
    if (!result || !paymentId) return;

    try {
        if (result === "success") {
            const payload = await callTransientApi("/api/payments/verify", { paymentId });
            showToast(payload.status === "paid"
                ? "Payment confirmed. Your Transient Bed bill is now paid."
                : "Payment is still being confirmed. Please refresh in a moment.");
        } else {
            showToast("Payment checkout was cancelled.");
        }
    } catch (error) {
        console.error("Transient payment verification failed:", error);
        showToast("Unable to verify payment right now.");
    } finally {
        const cleanUrl = new URL(window.location.href);
        cleanUrl.searchParams.delete("result");
        cleanUrl.searchParams.delete("paymentId");
        window.history.replaceState({}, "", cleanUrl.toString());
    }
}

auth.onAuthStateChanged(async (user) => {
    if (!user) {
        window.location.href = "intro.html";
        return;
    }

    try {
        const profileSnap = await db.collection("users").doc(user.uid).get();
        transientUserData = profileSnap.exists ? profileSnap.data() : {};
        transientUserGender = String(transientUserData.gender || "").toLowerCase();
        document.getElementById("transientAvatar").textContent = getInitials(transientUserData.fullName || transientUserData.username || user.email);
        subscribeHistory(user.uid);
        await handlePaymentReturn();
        await loadBedspaces();
    } catch (error) {
        console.error("Failed to load Transient Bed page:", error);
        showToast("Unable to load Transient Bed right now.");
    } finally {
        window.hidePageLoader?.();
    }
});

document.addEventListener("DOMContentLoaded", () => {
    setDefaultDates();
    updateSummary();
    document.getElementById("roomType")?.addEventListener("change", () => {
        updateSelectedBed("", "");
        updateSummary();
        loadBedspaces();
    });
    document.getElementById("checkInDate")?.addEventListener("change", () => {
        const checkIn = document.getElementById("checkInDate");
        const checkOut = document.getElementById("checkOutDate");
        if (checkIn && checkOut) {
            checkOut.min = getTodayValue(1);
            if (checkOut.value <= checkIn.value) {
                const next = new Date(`${checkIn.value}T00:00:00`);
                next.setDate(next.getDate() + 1);
                checkOut.value = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
            }
        }
        updateSummary();
    });
    document.getElementById("checkOutDate")?.addEventListener("change", updateSummary);
    document.getElementById("checkoutBtn")?.addEventListener("click", submitTransientBooking);
});

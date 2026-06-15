auth.onAuthStateChanged(async (user) => {
    if (!user) {
        window.location.href = "intro.html";
        return;
    }

    window.currentUserId = user.uid;

    try {
        const doc = await db.collection("users").doc(user.uid).get();

        if (!doc.exists) {
            alert("User data not found.");
            return;
        }

        const userData = doc.data();
        const displayName = userData.fullName || userData.username || user.displayName || user.email || "Tenant";

        document.getElementById("welcome-logger").textContent = `Welcome, ${displayName.split(/\s+/)[0] || "Tenant"}`;
        document.getElementById("profile-name").textContent = displayName;
        document.getElementById("profile-email").textContent = user.email || "N/A";
        window.currentUsername = displayName;

        const avatarBtn = document.getElementById("avatarBtn");
        const profileAvatar = document.getElementById("profileAvatarText");
        const initials = getInitials(displayName);

        if (avatarBtn) {
            avatarBtn.textContent = initials;
        }

        if (profileAvatar) {
            profileAvatar.textContent = initials;
        }

        await loadUserProfile(user.uid);
    } catch (error) {
        console.error("Error loading user profile:", error);
        hideProfileLoader();
    }
});

async function loadUserProfile(userId) {
    const restricted = document.getElementById("restrictedSection");
    const message = document.querySelector(".locked-message");
    const lockedOverlay = document.querySelector(".locked-overlay-text");
    const profileRole = document.querySelector(".profile-role");
    const profileStatusBadge = document.querySelector(".profile-status-badge");
    const greetingRoom = document.getElementById("navGreetingRoom");

    try {
        const snapshot = await db.collection("bookingRequest")
            .where("userId", "==", userId)
            .limit(1)
            .get();

        if (snapshot.empty) {
            updateHeroStatus({
                approved: false,
                profileRole,
                profileStatusBadge,
                greetingRoom
            });
            if (restricted) restricted.style.visibility = "visible";
            if (restricted) restricted.classList.add("blurred");
            if (message) message.style.display = "flex";
            if (lockedOverlay) lockedOverlay.style.display = "block";
            hideProfileLoader();
            console.warn("No profile data found for user:", userId);
            return;
        }

        const bookingDoc = snapshot.docs[0];
        const data = bookingDoc.data();

        if (restricted) restricted.style.visibility = "visible";
        if (restricted) restricted.classList.remove("blurred");
        if (message) message.style.display = "none";
        if (lockedOverlay) lockedOverlay.style.display = "none";

        if (data.status !== "approved") {
            updateHeroStatus({
                approved: false,
                profileRole,
                profileStatusBadge,
                greetingRoom,
                room: data.room
            });
            if (restricted) restricted.classList.add("blurred");
            if (message) message.style.display = "flex";
            if (lockedOverlay) lockedOverlay.style.display = "block";
            hideProfileLoader();
            return;
        }

        updateHeroStatus({
            approved: true,
            profileRole,
            profileStatusBadge,
            greetingRoom,
            room: data.room
        });

        document.getElementById("profile-movein").textContent =
            data.moveInDate
                ? `Move-in: ${formatProfileDate(data.moveInDate)}${data.moveInTime ? ` at ${formatProfileTime(data.moveInTime)}` : ""}`
                : data.createdAt
                    ? `Member since: ${data.createdAt.toDate().toLocaleDateString()}`
                    : "Move-in schedule not yet available";
        document.getElementById("profile-name").textContent =
            `${data.firstName || ""} ${data.lastName || ""}`.trim() || "N/A";
        document.getElementById("profile-email").textContent = data.email || "N/A";
        document.getElementById("profile-phone").textContent = data.phone || "N/A";

        document.getElementById("first-name").textContent = data.firstName || "N/A";
        document.getElementById("last-name").textContent = data.lastName || "N/A";
        document.getElementById("email").textContent = data.email || "N/A";
        document.getElementById("phone").textContent = data.phone || "N/A";
        document.getElementById("address").textContent = data.address || "N/A";

        document.getElementById("room-number").textContent = data.room || "-";
        document.getElementById("room-type").textContent = capitalizeText(data.type || "-");
        document.getElementById("move-in-date").textContent = data.moveInDate ? formatProfileDate(data.moveInDate) : "-";
        document.getElementById("monthly-rate").textContent =
            data.leasePrice ? `${data.leasePrice} / month` : (data.monthlyRate ? `${data.monthlyRate}` : "-");

        document.getElementById("emergency-name").textContent = data.emergencyName || "N/A";
        document.getElementById("emergency-relationship").textContent = data.relationship || "N/A";
        document.getElementById("emergency-phone").textContent = data.emergencyPhone || "N/A";
        document.getElementById("emergency-alt-phone").textContent = data.emergencyAlt || "N/A";
        document.getElementById("emergency-address").textContent = data.emergencyAddress || "N/A";

        await populateBillingSummary(userId, bookingDoc.id, data);

        document.getElementById("extraSection").style.display = "grid";
        document.getElementById("billingSection").style.display = "flex";
        hideProfileLoader();
    } catch (error) {
        console.error("Error loading profile:", error);
        hideProfileLoader();
    }
}
const avatarBtn = document.getElementById("avatarBtn");
const avatarDropdown = document.getElementById("avatarDropdown");

// Toggle dropdown
avatarBtn.addEventListener("click", (e) => {
    e.stopPropagation(); // prevent closing immediately
    avatarDropdown.classList.toggle("show");
});

// Close when clicking outside
document.addEventListener("click", (e) => {
    if (!avatarDropdown.contains(e.target) && !avatarBtn.contains(e.target)) {
        avatarDropdown.classList.remove("show");
    }
});
document.querySelectorAll("#btnLogout, .logout-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        firebase.auth().signOut()
            .then(() => {
                localStorage.clear();
                window.location.href = "intro.html";
            })
            .catch(console.error);
    });
});

function hideProfileLoader() {
    window.hidePageLoader?.();
}

function getInitials(name) {
    const words = String(name || "").trim().split(/\s+/).filter(Boolean);

    if (!words.length) {
        return "U";
    }

    return words
        .slice(0, 2)
        .map(word => word.charAt(0).toUpperCase())
        .join("");
}

initializeLockedStateUI();

function initializeLockedStateUI() {
    const overlayLabel = document.querySelector(".locked-overlay-text");
    const lockedBox = document.querySelector(".locked-box");

    if (overlayLabel) {
        overlayLabel.textContent = "Approval Required";
    }

    if (lockedBox) {
        lockedBox.innerHTML = `
            <div class="locked-box-badge">Restricted Access</div>
            <div class="locked-box-title">Your profile details are locked for now</div>
            <div class="locked-box-sub">Once your request is approved, your room details and personal information will appear here automatically.</div>
            <button onclick="window.location.href='main.html'" class="apply-btn">Go to Dashboard</button>
        `;
    }
}

function updateHeroStatus({ approved, profileRole, profileStatusBadge, greetingRoom, room = "" }) {
    if (profileRole) {
        profileRole.textContent = approved ? "Approved Tenant" : "Pending Approval";
        profileRole.classList.toggle("pending", !approved);
    }

    if (profileStatusBadge) {
        profileStatusBadge.classList.toggle("pending", !approved);
        profileStatusBadge.innerHTML = approved
            ? `<span class="status-dot"></span> Active Tenant`
            : `<span class="status-dot"></span> Pending Approval`;
    }

    if (greetingRoom) {
        greetingRoom.textContent = approved && room ? `Room ${room}` : "Awaiting room approval";
    }
}

async function populateBillingSummary(userId, bookingRequestId, bookingData) {
    const primaryLabel = document.getElementById("billingPrimaryLabel");
    const primaryValue = document.getElementById("billingPrimaryValue");
    const secondaryLabel = document.getElementById("billingSecondaryLabel");
    const secondaryValue = document.getElementById("billingSecondaryValue");
    const nextDueValue = document.getElementById("billingNextDueValue");
    const depositPaid = document.getElementById("deposit-paid");

    if (!primaryLabel || !primaryValue || !secondaryLabel || !secondaryValue || !nextDueValue || !depositPaid) {
        return;
    }

    const snapshot = await db.collection("payments")
        .where("userId", "==", userId)
        .where("bookingRequestId", "==", bookingRequestId)
        .get();

    const records = snapshot.docs
        .map((doc) => ({ id: doc.id, ...doc.data() }))
        .sort((left, right) => {
            const leftDate = left.createdAt?.toDate?.() || new Date(0);
            const rightDate = right.createdAt?.toDate?.() || new Date(0);
            return rightDate - leftDate;
        });

    const downPayment = records.find((record) => record.type === "down_payment") || null;
    const latestPaid = records.find((record) => record.status === "paid") || null;
    const nextPending = records.find((record) => record.status === "pending_gateway" || record.status === "pending") || null;

    primaryLabel.textContent = nextPending?.type === "monthly_rent"
        ? `${formatBillingMonth(nextPending.billingMonth)} Rent`
        : "Current Billing";
    primaryValue.textContent = nextPending
        ? `${formatPaymentAmount(nextPending.amount)} - ${formatPaymentStatus(nextPending.status)}`
        : "No pending billing right now";
    primaryValue.className = `billing-val ${nextPending ? "pending" : "paid"}`;

    secondaryLabel.textContent = latestPaid?.type === "monthly_rent"
        ? "Latest Rent Payment"
        : "Latest Payment";
    secondaryValue.textContent = latestPaid
        ? `${formatPaymentAmount(latestPaid.amount)} - Paid`
        : "No settled payment yet";
    secondaryValue.className = `billing-val ${latestPaid ? "paid" : "pending"}`;

    nextDueValue.textContent = nextPending
        ? getPaymentDueText(nextPending, bookingData)
        : "No upcoming due date";

    depositPaid.textContent = downPayment?.status === "paid" ? "Paid" : "Pending";
}

function formatProfileDate(dateValue) {
    const parsed = new Date(`${dateValue}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) {
        return dateValue || "N/A";
    }

    return parsed.toLocaleDateString("en-PH", {
        year: "numeric",
        month: "long",
        day: "numeric"
    });
}

function formatProfileTime(timeValue) {
    const [hours, minutes] = String(timeValue || "").split(":");
    if (hours == null || minutes == null) {
        return timeValue || "N/A";
    }

    const parsed = new Date();
    parsed.setHours(Number(hours), Number(minutes), 0, 0);
    return parsed.toLocaleTimeString("en-PH", {
        hour: "numeric",
        minute: "2-digit"
    });
}

function formatPaymentAmount(amount) {
    return new Intl.NumberFormat("en-PH", {
        style: "currency",
        currency: "PHP",
        minimumFractionDigits: 2
    }).format(Number(amount || 0));
}

function formatPaymentStatus(status) {
    if (status === "pending_gateway") return "Pending Gateway";
    if (status === "pending") return "Pending";
    if (status === "paid") return "Paid";
    if (status === "cancelled") return "Cancelled";
    return "Unpaid";
}

function formatBillingMonth(billingMonth) {
    if (!billingMonth || !/^\d{4}-\d{2}$/.test(String(billingMonth))) {
        return "Monthly";
    }

    const [year, month] = String(billingMonth).split("-").map(Number);
    return new Intl.DateTimeFormat("en-PH", {
        month: "long",
        year: "numeric"
    }).format(new Date(year, month - 1, 1));
}

function getPaymentDueText(record, bookingData) {
    if (record.type === "down_payment") {
        const createdAt = record.createdAt?.toDate?.() || new Date();
        const dueDate = new Date(createdAt);
        dueDate.setDate(dueDate.getDate() + 5);
        return dueDate.toLocaleDateString("en-PH", {
            year: "numeric",
            month: "long",
            day: "numeric"
        });
    }

    if (record.type === "monthly_rent" && record.billingMonth && bookingData?.moveInDate) {
        const moveInDate = new Date(`${bookingData.moveInDate}T00:00:00`);
        const [year, month] = String(record.billingMonth).split("-").map(Number);
        const lastDay = new Date(year, month, 0).getDate();
        const safeDay = Math.min(moveInDate.getDate(), lastDay);
        const dueDate = new Date(year, month - 1, safeDay);

        return dueDate.toLocaleDateString("en-PH", {
            year: "numeric",
            month: "long",
            day: "numeric"
        });
    }

    return "Waiting for billing schedule";
}

function capitalizeText(value) {
    const text = String(value || "").trim();
    if (!text) {
        return "-";
    }

    return text.charAt(0).toUpperCase() + text.slice(1);
}

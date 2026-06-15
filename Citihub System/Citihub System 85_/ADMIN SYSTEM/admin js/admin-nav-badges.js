const adminNavBadgeState = {
    started: false,
    bookingUnsubscribe: null,
    messagesUnsubscribe: null,
    billingUnsubscribe: null,
    transientUnsubscribe: null,
    complaintsUnsubscribe: null
};

function setAdminSidebarBadge(href, count) {
    document.querySelectorAll(`.sidebar-nav a[href="${href}"] .nav-badge`).forEach((badge) => {
        const numericCount = Number(count || 0);
        if (numericCount > 0) {
            badge.textContent = String(numericCount);
            badge.style.display = "inline-flex";
        } else {
            badge.textContent = "";
            badge.style.display = "none";
        }
    });
}

function stopAdminNavBadges() {
    if (adminNavBadgeState.bookingUnsubscribe) {
        adminNavBadgeState.bookingUnsubscribe();
        adminNavBadgeState.bookingUnsubscribe = null;
    }

    if (adminNavBadgeState.messagesUnsubscribe) {
        adminNavBadgeState.messagesUnsubscribe();
        adminNavBadgeState.messagesUnsubscribe = null;
    }

    if (adminNavBadgeState.billingUnsubscribe) {
        adminNavBadgeState.billingUnsubscribe();
        adminNavBadgeState.billingUnsubscribe = null;
    }

    if (adminNavBadgeState.transientUnsubscribe) {
        adminNavBadgeState.transientUnsubscribe();
        adminNavBadgeState.transientUnsubscribe = null;
    }

    if (adminNavBadgeState.complaintsUnsubscribe) {
        adminNavBadgeState.complaintsUnsubscribe();
        adminNavBadgeState.complaintsUnsubscribe = null;
    }

    adminNavBadgeState.started = false;
}

async function userIsAdmin(user) {
    if (!user) {
        return false;
    }

    try {
        const snapshot = await db.collection("users").doc(user.uid).get();
        return snapshot.exists && snapshot.data()?.role === "admin";
    } catch (error) {
        console.error("Failed to verify admin badge access:", error);
        return false;
    }
}

function subscribeAdminNavBadges() {
    if (adminNavBadgeState.started) {
        return;
    }

    adminNavBadgeState.started = true;

    adminNavBadgeState.bookingUnsubscribe = db.collection("bookingRequest")
        .where("status", "==", "pending")
        .onSnapshot((snapshot) => {
            setAdminSidebarBadge("bookings.html", snapshot.size);
        }, (error) => {
            console.error("Failed to load pending booking badge:", error);
        });

    adminNavBadgeState.messagesUnsubscribe = db.collection("users")
        .onSnapshot((snapshot) => {
            let unreadTotal = 0;

            snapshot.forEach((doc) => {
                const data = doc.data() || {};
                unreadTotal += Number(data.chatUnreadForAdmin || 0);
            });

            setAdminSidebarBadge("messages.html", unreadTotal);
        }, (error) => {
            console.error("Failed to load unread message badge:", error);
        });

    adminNavBadgeState.billingUnsubscribe = db.collection("payments")
        .where("status", "==", "pending_gateway")
        .onSnapshot((snapshot) => {
            setAdminSidebarBadge("billing.html", snapshot.size);
        }, (error) => {
            console.error("Failed to load pending billing badge:", error);
        });

    adminNavBadgeState.transientUnsubscribe = db.collection("transientBedBookings")
        .where("status", "==", "pending")
        .onSnapshot((snapshot) => {
            setAdminSidebarBadge("transient-beds.html", snapshot.size);
        }, (error) => {
            console.error("Failed to load pending transient bed badge:", error);
        });

    adminNavBadgeState.complaintsUnsubscribe = db.collection("tenantComplaints")
        .where("status", "in", ["open", "in_review"])
        .onSnapshot((snapshot) => {
            setAdminSidebarBadge("complaints.html", snapshot.size);
        }, (error) => {
            console.error("Failed to load active complaint badge:", error);
        });
}

firebase.auth().onAuthStateChanged(async (user) => {
    if (!user) {
        stopAdminNavBadges();
        setAdminSidebarBadge("bookings.html", 0);
        setAdminSidebarBadge("messages.html", 0);
        setAdminSidebarBadge("billing.html", 0);
        setAdminSidebarBadge("transient-beds.html", 0);
        setAdminSidebarBadge("complaints.html", 0);
        return;
    }

    if (await userIsAdmin(user)) {
        subscribeAdminNavBadges();
    } else {
        stopAdminNavBadges();
        setAdminSidebarBadge("bookings.html", 0);
        setAdminSidebarBadge("messages.html", 0);
        setAdminSidebarBadge("billing.html", 0);
        setAdminSidebarBadge("transient-beds.html", 0);
        setAdminSidebarBadge("complaints.html", 0);
    }
});

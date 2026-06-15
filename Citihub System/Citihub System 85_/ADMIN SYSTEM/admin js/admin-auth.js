function requireAdminAccess() {
    return new Promise((resolve) => {
        firebase.auth().onAuthStateChanged(async (user) => {
            if (!user) {
                window.location.href = "adminlogin.html";
                resolve(null);
                return;
            }

            try {
                const doc = await db.collection("users").doc(user.uid).get();

                if (!doc.exists || doc.data().role !== "admin") {
                    showFormalAlert("Access denied. You do not have permission to access the administrative panel.");
                    await firebase.auth().signOut();
                    window.location.href = "adminlogin.html";
                    resolve(null);
                    return;
                }

                window.currentUser = doc.data();
                window.currentUserId = user.uid;

                if (document.body.classList.contains("hidden-page")) {
                    document.body.classList.remove("hidden-page");
                }

                if (typeof window.hidePageLoader === "function") {
                    window.hidePageLoader();
                }

                if (typeof window.applyStoredAdminSidebarState === "function") {
                    window.applyStoredAdminSidebarState();
                }

                console.log("Admin logged in:", doc.data().username);
                resolve(doc.data());
            } catch (error) {
                console.error("Admin auth check failed:", error);
                await firebase.auth().signOut();
                window.location.href = "adminlogin.html";
                resolve(null);
            }
        });
    });
}

function applyStoredAdminSidebarState() {
    const sidebar = document.getElementById("sidebar");
    if (!sidebar) {
        return;
    }

    const collapsed = localStorage.getItem("citihub_admin_sidebar") === "collapsed";
    sidebar.classList.toggle("collapsed", collapsed);
    document.body.classList.toggle("admin-sidebar-collapsed", collapsed);
}

function toggleAdminSidebar() {
    const sidebar = document.getElementById("sidebar");
    if (!sidebar) {
        return;
    }

    const collapsed = !sidebar.classList.contains("collapsed");
    sidebar.classList.toggle("collapsed", collapsed);
    document.body.classList.toggle("admin-sidebar-collapsed", collapsed);
    localStorage.setItem("citihub_admin_sidebar", collapsed ? "collapsed" : "expanded");
}

async function logoutAdmin(event) {
    if (event) {
        event.preventDefault();
    }

    try {
        if (typeof logAdminActivity === "function") {
            await logAdminActivity({
                action: "logged_out",
                module: "auth",
                details: "Signed out from the admin panel."
            });
        }

        await firebase.auth().signOut();
        window.currentUser = null;
        window.currentUserId = null;
        sessionStorage.clear();
        localStorage.clear();
        window.location.href = "adminlogin.html";
    } catch (error) {
        console.error("Logout failed:", error);
        showFormalAlert("The system was unable to sign you out at this time. Please try again.");
    }
}

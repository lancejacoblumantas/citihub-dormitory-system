// admin-auth.js
firebase.auth().onAuthStateChanged(async (user) => {
    if (!user) {
        // Not logged in -> redirect immediately
        window.location.href = "adminlogin.html";
        return;
    }

    try {
        const doc = await firebase.firestore().collection("users").doc(user.uid).get();
        const data = doc.data();
        if (!doc.exists || data.role !== "admin") {
            showFormalAlert("Access denied. You do not have permission to access the administrative panel.");
            await firebase.auth().signOut();
            window.location.href = "adminlogin.html";
            return;
        }

        // Store global admin info
        window.currentUser = data;
        window.currentUserId = user.uid;

        console.log("Admin logged in:", data.username);
    } catch (err) {
        console.error("Auth check failed:", err);
        await firebase.auth().signOut();
        window.location.href = "adminlogin.html";
    }
});

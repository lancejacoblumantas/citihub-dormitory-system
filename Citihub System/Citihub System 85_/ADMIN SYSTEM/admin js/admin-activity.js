async function logAdminActivity({
    action,
    module,
    targetId = "",
    targetName = "",
    details = ""
}) {
    try {
        const user = firebase.auth().currentUser;
        if (!user) {
            return;
        }

        await callAdminApi("/api/admin/history/log", {
            action,
            module,
            targetId,
            targetName,
            details
        });
    } catch (error) {
        console.error("Failed to log admin activity:", error);
    }
}

const adminMessageState = {
    users: [],
    filteredUsers: [],
    selectedUserId: null,
    selectedUserData: null,
    unsubscribeMessages: null,
    messages: [],
    requestedUserId: new URLSearchParams(window.location.search).get("tenantId") || ""
};

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function getInitials(name) {
    return String(name || "User")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part.charAt(0).toUpperCase())
        .join("") || "U";
}

function getTenantColor(type) {
    return String(type || "").toLowerCase() === "premium" ? "teal" : "green";
}

function getTenantMessagesRef(userId) {
    return db.collection("users").doc(userId).collection("messages");
}

async function hydrateUserChatSummary(userData) {
    if (userData.chatLastMessage || userData.chatLastAt) {
        return userData;
    }

    const latestSnapshot = await getTenantMessagesRef(userData.id)
        .orderBy("createdAt", "desc")
        .limit(1)
        .get();

    if (latestSnapshot.empty) {
        return userData;
    }

    const latestMessage = latestSnapshot.docs[0].data();
    return {
        ...userData,
        chatLastMessage: latestMessage.text || "",
        chatLastSender: latestMessage.senderType || "",
        chatLastAt: latestMessage.createdAt || null
    };
}

function getMessageDate(timestamp) {
    if (!timestamp) {
        return null;
    }

    if (typeof timestamp.toDate === "function") {
        return timestamp.toDate();
    }

    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? null : date;
}

function formatConversationTime(timestamp) {
    const date = getMessageDate(timestamp);
    if (!date) {
        return "No messages";
    }

    return new Intl.DateTimeFormat("en-PH", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
    }).format(date);
}

function formatRoomLabel(userData) {
    if (userData.room) {
        return userData.room;
    }

    return "No room assigned";
}

function getTenantName(userData) {
    return userData.fullName || userData.username || userData.email || "Unnamed Tenant";
}

function buildConversationList(users) {
    const container = document.getElementById("approvedTenantList");
    if (!container) {
        return;
    }

    container.innerHTML = "";

    if (!users.length) {
        container.innerHTML = `
            <div class="convo-item active">
                <div class="convo-info">
                    <div class="convo-name">No tenant conversations</div>
                    <div class="convo-preview">Tenant messages will appear here once they start chatting.</div>
                </div>
            </div>
        `;
        return;
    }

    users.forEach((userData) => {
        const item = document.createElement("div");
        const fullName = getTenantName(userData);
        const initials = getInitials(fullName);
        const color = getTenantColor(userData.type);
        const preview = userData.chatLastMessage || "No messages yet";
        const roomLabel = formatRoomLabel(userData);
        const unread = Number(userData.chatUnreadForAdmin || 0);

        item.className = `convo-item${adminMessageState.selectedUserId === userData.id ? " active" : ""}`;
        item.dataset.userId = userData.id;
        const avatar = document.createElement("div");
        avatar.className = `convo-avatar ${color}`;
        avatar.textContent = initials;

        const info = document.createElement("div");
        info.className = "convo-info";

        const nameEl = document.createElement("div");
        nameEl.className = "convo-name";
        nameEl.textContent = fullName;

        const previewEl = document.createElement("div");
        previewEl.className = "convo-preview";
        previewEl.textContent = preview;

        info.appendChild(nameEl);
        info.appendChild(previewEl);

        const meta = document.createElement("div");
        meta.className = "convo-meta";

        const timeEl = document.createElement("div");
        timeEl.className = "convo-time";
        timeEl.textContent = userData.chatLastAt ? formatConversationTime(userData.chatLastAt) : roomLabel;
        meta.appendChild(timeEl);

        if (unread > 0) {
            const unreadEl = document.createElement("div");
            unreadEl.className = "convo-unread";
            unreadEl.textContent = String(unread);
            meta.appendChild(unreadEl);
        }

        item.appendChild(avatar);
        item.appendChild(info);
        item.appendChild(meta);

        item.addEventListener("click", () => {
            openTenantConversation(userData.id);
        });

        container.appendChild(item);
    });
}

function updateSelectedConversationHeader(userData) {
    const fullName = getTenantName(userData);
    const initials = getInitials(fullName);
    const color = getTenantColor(userData.type);
    const roomLabel = formatRoomLabel(userData);
    const chatAvatar = document.getElementById("chatAvatar");
    const chatName = document.getElementById("chatName");
    const chatSub = document.getElementById("chatSub");
    const profileBtn = document.getElementById("viewTenantProfileBtn");

    if (chatAvatar) {
        chatAvatar.textContent = initials;
        chatAvatar.className = `convo-avatar ${color}`;
    }

    if (chatName) {
        chatName.textContent = fullName;
    }

    if (chatSub) {
        chatSub.textContent = `${roomLabel} - ${userData.status || "tenant"}`;
    }

    if (profileBtn) {
        profileBtn.href = "#";
    }
}

async function openTenantProfileModal() {
    const userData = adminMessageState.selectedUserData;
    const modal = document.getElementById("tenantProfileModal");
    const body = document.getElementById("tenantProfileBody");

    if (!modal || !body || !userData) {
        return;
    }

    const fullName = getTenantName(userData);
    const initials = getInitials(fullName);
    const color = getTenantColor(userData.type);
    const latestBooking = await loadLatestTenantBooking(userData.id);
    const bookingRoom = latestBooking ? `Room ${latestBooking.room || "N/A"} - Bedspace ${latestBooking.bed || "N/A"}` : "No booking record";
    const applicantType = latestBooking?.applicantType ? String(latestBooking.applicantType).replace("type-", "") : "Not specified";

    body.innerHTML = `
        <div class="tenant-profile-hero">
            <div class="tenant-profile-avatar ${color}" style="background: var(--${color === "teal" ? "teal" : "green"});">${escapeHtml(initials)}</div>
            <div>
                <div class="tm-name">${escapeHtml(fullName)}</div>
                <div class="td-email">${escapeHtml(userData.email || "No email available")}</div>
            </div>
        </div>

        <div class="modal-section-label">Tenant Information</div>
        <div class="tenant-profile-grid">
            <div class="modal-field"><div class="modal-label">Status</div><div class="summary-value">${escapeHtml(userData.status || "Tenant")}</div></div>
            <div class="modal-field"><div class="modal-label">Assigned Room</div><div class="summary-value">${escapeHtml(formatRoomLabel(userData))}</div></div>
            <div class="modal-field"><div class="modal-label">Phone</div><div class="summary-value">${escapeHtml(userData.phone || "Not provided")}</div></div>
            <div class="modal-field"><div class="modal-label">Gender</div><div class="summary-value">${escapeHtml(userData.gender || "Not specified")}</div></div>
            <div class="modal-field"><div class="modal-label">Applicant Type</div><div class="summary-value">${escapeHtml(applicantType)}</div></div>
            <div class="modal-field"><div class="modal-label">Latest Booking</div><div class="summary-value">${escapeHtml(bookingRoom)}</div></div>
        </div>

        <div class="modal-section-label">Address</div>
        <div class="tenant-profile-note">${escapeHtml(userData.address || "No address provided.")}</div>

        <div class="modal-section-label">Conversation Summary</div>
        <div class="tenant-profile-note">${escapeHtml(userData.chatLastMessage || "No conversation summary available yet.")}</div>
    `;

    modal.style.display = "flex";
}

function closeTenantProfileModal() {
    const modal = document.getElementById("tenantProfileModal");
    if (modal) {
        modal.style.display = "none";
    }
}

async function loadLatestTenantBooking(userId) {
    const snapshot = await db.collection("bookingRequest")
        .where("userId", "==", userId)
        .get();

    if (snapshot.empty) {
        return null;
    }

    const docs = snapshot.docs
        .map((doc) => doc.data())
        .sort((left, right) => {
            const leftDate = getMessageDate(left.createdAt);
            const rightDate = getMessageDate(right.createdAt);

            if (leftDate && rightDate) {
                return rightDate - leftDate;
            }

            if (rightDate) {
                return 1;
            }

            if (leftDate) {
                return -1;
            }

            return 0;
        });

    return docs[0] || null;
}

function createMessageRow(message, tenantData) {
    const row = document.createElement("div");
    const isAdmin = message.senderType === "admin";
    const tenantInitials = getInitials(getTenantName(tenantData));
    const color = getTenantColor(tenantData?.type);

    row.className = `msg-row ${isAdmin ? "admin" : "tenant"}`;
    row.dataset.messageId = message.id || "";

    if (isAdmin) {
        const bubble = document.createElement("div");
        bubble.className = "msg-bubble admin";
        bubble.textContent = message.text || "";

        const avatar = document.createElement("div");
        avatar.className = "msg-avatar";
        avatar.style.background = "var(--green)";
        avatar.textContent = "AD";

        row.appendChild(bubble);
        row.appendChild(avatar);

        const actions = document.createElement("div");
        actions.className = "msg-actions admin";

        const menu = document.createElement("div");
        menu.className = "msg-menu";

        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "msg-menu-toggle";
        toggle.setAttribute("aria-label", "Message options");
        toggle.textContent = "...";
        toggle.addEventListener("click", (event) => {
            event.stopPropagation();
            const willOpen = !menu.classList.contains("open");
            closeAdminMessageMenus();
            if (willOpen) {
                menu.classList.add("open");
            }
        });

        const panel = document.createElement("div");
        panel.className = "msg-menu-panel";

        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "msg-menu-item danger";
        remove.textContent = "Remove";
        remove.addEventListener("click", async (event) => {
            closeAdminMessageMenus();
            await deleteAdminMessage(message.id, event.currentTarget);
        });

        panel.appendChild(remove);
        menu.appendChild(toggle);
        menu.appendChild(panel);
        actions.appendChild(menu);
        row.appendChild(actions);
    } else {
        const avatar = document.createElement("div");
        avatar.className = `msg-avatar ${color}`;
        avatar.textContent = tenantInitials;

        const bubble = document.createElement("div");
        bubble.className = "msg-bubble tenant";
        bubble.textContent = message.text || "";

        row.appendChild(avatar);
        row.appendChild(bubble);
    }

    return row;
}

function closeAdminMessageMenus() {
    document.querySelectorAll(".msg-menu.open").forEach((menu) => {
        menu.classList.remove("open");
    });
}

async function deleteAdminMessage(messageId, button = null) {
    const userId = adminMessageState.selectedUserId;
    if (!userId || !messageId) {
        return;
    }

    try {
        setAdminButtonLoading?.(button, "Removing...");
        await callAdminApi("/api/admin/messages/delete", { userId, messageId });
    } catch (error) {
        console.error("Failed to remove admin message:", error);
        showToast?.("Unable to remove the selected reply right now.");
    } finally {
        restoreAdminButton?.(button);
    }
}

function renderConversationMessages(messages) {
    const container = document.getElementById("chatMessages");
    if (!container) {
        return;
    }

    container.innerHTML = "";

    if (!messages.length) {
        container.innerHTML = `
            <div class="chat-date-label">Ready</div>
            <div class="msg-row tenant">
                <div class="msg-avatar green">U</div>
                <div class="msg-bubble tenant">No messages yet. You can send the first reply from here.</div>
            </div>
        `;
        return;
    }

    const dateLabel = document.createElement("div");
    dateLabel.className = "chat-date-label";
    dateLabel.textContent = "Conversation";
    container.appendChild(dateLabel);

    messages.forEach((message) => {
        container.appendChild(createMessageRow(message, adminMessageState.selectedUserData || {}));
    });

    container.scrollTop = container.scrollHeight;
}

async function markMessagesReadByAdmin(userId) {
    if (!userId) {
        return;
    }

    try {
        await callAdminApi("/api/admin/messages/mark-read", { userId });
    } catch (error) {
        console.error("Failed to mark admin messages as read:", error);
    }
}

function subscribeToConversation(userId) {
    if (adminMessageState.unsubscribeMessages) {
        adminMessageState.unsubscribeMessages();
        adminMessageState.unsubscribeMessages = null;
    }

    adminMessageState.unsubscribeMessages = getTenantMessagesRef(userId)
        .orderBy("createdAt", "asc")
        .onSnapshot((snapshot) => {
            const messages = [];

            snapshot.forEach((doc) => {
                messages.push({
                    id: doc.id,
                    ...doc.data()
                });
            });

            adminMessageState.messages = messages;
            renderConversationMessages(messages);
            markMessagesReadByAdmin(userId);
        }, (error) => {
            console.error("Failed to load tenant conversation:", error);
            showToast?.("Unable to load the selected conversation.");
        });
}

function openTenantConversation(userId) {
    const userData = adminMessageState.users.find((user) => user.id === userId);
    if (!userData) {
        return;
    }

    adminMessageState.selectedUserId = userId;
    adminMessageState.selectedUserData = userData;
    updateSelectedConversationHeader(userData);
    buildConversationList(adminMessageState.filteredUsers);
    subscribeToConversation(userId);
}

function sortTenantUsers(users) {
    return [...users].sort((left, right) => {
        const leftDate = getMessageDate(left.chatLastAt);
        const rightDate = getMessageDate(right.chatLastAt);

        if (leftDate && rightDate) {
            return rightDate - leftDate;
        }

        if (rightDate) {
            return 1;
        }

        if (leftDate) {
            return -1;
        }

        return getTenantName(left).localeCompare(getTenantName(right));
    });
}

function applyTenantSearch() {
    const input = document.getElementById("tenantSearchInput");
    const query = String(input?.value || "").trim().toLowerCase();

    adminMessageState.filteredUsers = sortTenantUsers(
        adminMessageState.users.filter((user) => {
            if (!query) {
                return true;
            }

            const haystack = [
                getTenantName(user),
                user.email || "",
                formatRoomLabel(user),
                user.chatLastMessage || ""
            ].join(" ").toLowerCase();

            return haystack.includes(query);
        })
    );

    buildConversationList(adminMessageState.filteredUsers);

    if (adminMessageState.requestedUserId) {
        const requestedUser = adminMessageState.filteredUsers.find((user) => user.id === adminMessageState.requestedUserId);
        if (requestedUser) {
            openTenantConversation(requestedUser.id);
            adminMessageState.requestedUserId = "";
            return;
        }
    }

    if (!adminMessageState.selectedUserId && adminMessageState.filteredUsers.length) {
        openTenantConversation(adminMessageState.filteredUsers[0].id);
        return;
    }

    const stillVisible = adminMessageState.filteredUsers.some((user) => user.id === adminMessageState.selectedUserId);
    if (!stillVisible) {
        adminMessageState.selectedUserId = null;
        adminMessageState.selectedUserData = null;

        if (adminMessageState.filteredUsers.length) {
            openTenantConversation(adminMessageState.filteredUsers[0].id);
        } else {
            renderConversationMessages([]);
        }
    }
}

function bindTenantSearch() {
    const input = document.getElementById("tenantSearchInput");
    if (!input) {
        return;
    }

    input.addEventListener("input", applyTenantSearch);
}

function bindAvatarDropdown() {
    const avatarContainer = document.querySelector(".avatar-container");
    const avatar = avatarContainer?.querySelector(".avatar");

    if (!avatarContainer || !avatar) {
        return;
    }

    avatar.addEventListener("click", function (event) {
        avatarContainer.classList.toggle("open");
        event.stopPropagation();
    });

    document.addEventListener("click", () => {
        avatarContainer.classList.remove("open");
    });
}

async function sendAdminMessage() {
    const userId = adminMessageState.selectedUserId;
    const userData = adminMessageState.selectedUserData;
    const input = document.getElementById("chatInput");
    const sendBtn = document.getElementById("chatSendBtn");

    if (!userId || !userData || !input || !sendBtn) {
        return;
    }

    const text = input.value.trim();
    if (!text) {
        return;
    }

    setAdminButtonLoading?.(sendBtn, "Sending...");

    try {
        await callAdminApi("/api/admin/messages/send", { userId, text });
        input.value = "";
    } catch (error) {
        console.error("Failed to send admin message:", error);
        showToast?.("Unable to send the message right now.");
    } finally {
        restoreAdminButton?.(sendBtn);
        input.focus();
    }
}

function bindChatComposer() {
    const input = document.getElementById("chatInput");
    const sendBtn = document.getElementById("chatSendBtn");

    if (!input || !sendBtn) {
        return;
    }

    sendBtn.addEventListener("click", sendAdminMessage);
    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            sendAdminMessage();
        }
    });
}

function applyChatSidebarState(collapsed) {
    const layout = document.querySelector(".chat-layout");
    const toggle = document.getElementById("chatSidebarToggle");

    if (!layout || !toggle) {
        return;
    }

    layout.classList.toggle("sidebar-collapsed", collapsed);
    toggle.setAttribute("aria-label", collapsed ? "Show tenant list" : "Hide tenant list");
    toggle.setAttribute("title", collapsed ? "Show tenant list" : "Hide tenant list");
    toggle.textContent = collapsed ? ">" : "\u2630";
    localStorage.setItem("citihubMessagesSidebarCollapsed", collapsed ? "true" : "false");
}

function bindChatSidebarToggle() {
    const toggle = document.getElementById("chatSidebarToggle");
    const layout = document.querySelector(".chat-layout");

    if (!toggle || !layout) {
        return;
    }

    applyChatSidebarState(localStorage.getItem("citihubMessagesSidebarCollapsed") === "true");

    toggle.addEventListener("click", () => {
        applyChatSidebarState(!layout.classList.contains("sidebar-collapsed"));
    });
}

function updateMessageBadge() {
    const totalUnread = adminMessageState.users.reduce((sum, user) => {
        return sum + Number(user.chatUnreadForAdmin || 0);
    }, 0);

    document.querySelectorAll('a[href="messages.html"] .nav-badge').forEach((badge) => {
        if (!badge) {
            return;
        }

        if (totalUnread > 0) {
            badge.textContent = String(totalUnread);
            badge.style.display = "inline-flex";
        } else {
            badge.style.display = "none";
        }
    });
}

function subscribeToTenantList() {
    db.collection("users")
        .onSnapshot(async (snapshot) => {
            const baseUsers = [];

            snapshot.forEach((doc) => {
                const data = doc.data();

                if (doc.id === window.currentUserId || data.role === "admin") {
                    return;
                }

                baseUsers.push({
                    id: doc.id,
                    ...data
                });
            });

            const hydratedUsers = await Promise.all(
                baseUsers.map((userData) => hydrateUserChatSummary(userData))
            );

            adminMessageState.users = sortTenantUsers(
                hydratedUsers.filter((userData) => {
                    return Boolean(userData.chatLastMessage) ||
                        Boolean(userData.chatLastAt) ||
                        Number(userData.chatUnreadForAdmin || 0) > 0 ||
                        userData.status === "approved";
                })
            );

            updateMessageBadge();
            applyTenantSearch();
        }, (error) => {
            console.error("Failed to load tenant list:", error);
            const container = document.getElementById("approvedTenantList");
            if (container) {
                container.innerHTML = `
                    <div class="convo-item active">
                        <div class="convo-info">
                            <div class="convo-name">Failed to load tenants</div>
                            <div class="convo-preview">Please refresh the page.</div>
                        </div>
                    </div>
                `;
            }
        });
}

document.addEventListener("DOMContentLoaded", async () => {
    bindAvatarDropdown();
    bindTenantSearch();
    bindChatComposer();
    bindChatSidebarToggle();
    document.addEventListener("click", closeAdminMessageMenus);
    document.getElementById("viewTenantProfileBtn")?.addEventListener("click", async (event) => {
        event.preventDefault();
        await openTenantProfileModal();
    });
    document.getElementById("tenantProfileClose")?.addEventListener("click", closeTenantProfileModal);
    document.getElementById("tenantProfileDone")?.addEventListener("click", closeTenantProfileModal);
    document.getElementById("tenantProfileModal")?.addEventListener("click", (event) => {
        if (event.target === event.currentTarget) {
            closeTenantProfileModal();
        }
    });
    const adminData = await requireAdminAccess();
    if (!adminData) {
        return;
    }

    subscribeToTenantList();

    document.querySelectorAll("#btnLogout").forEach((button) => {
        button.addEventListener("click", logoutAdmin);
    });
});

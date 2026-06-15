requireAdminAccess();

document.querySelector(".avatar-container").addEventListener("click", function (e) {
    this.classList.toggle("open");
    e.stopPropagation();
});

document.addEventListener("click", () => {
    document.querySelector(".avatar-container").classList.remove("open");
});

function openBulletinModal() {
    document.getElementById("bulletinModal").style.display = "flex";
}

function closeBulletinModal() {
    document.getElementById("bulletinModal").style.display = "none";
}

db.collection("announcements")
    .orderBy("date", "desc")
    .onSnapshot((snapshot) => {
        const container = document.getElementById("adminBulletinList");
        container.innerHTML = "";

        snapshot.forEach((doc) => {
            const data = doc.data();

            const dc = data.type === "urgent" ? "dot-urgent" : data.type === "notice" ? "dot-notice" : "dot-info";
            const bc = data.type === "urgent" ? "badge-urgent" : data.type === "notice" ? "badge-notice" : "badge-general";
            const bt = data.type === "urgent" ? "Urgent" : data.type === "notice" ? "Reminder" : "General";
            const em = data.type === "urgent" ? "Urgent" : data.type === "notice" ? "Reminder" : "Info";

            const div = document.createElement("div");
            div.className = "bulletin-admin-item";
            div.dataset.type = data.type;

            div.innerHTML = `
          <div class="bulletin-dot ${dc}"></div>
          <div class="bulletin-content">
              <div class="bulletin-item-title">${em}: ${data.title}</div>
              <div class="bulletin-item-body">${data.body}</div>
              <div class="bulletin-meta">
                  <span class="bulletin-badge ${bc}">${bt}</span>
                  <span class="bulletin-date">Posted: ${data.displayDate} | ${data.author}</span>
              </div>
          </div>
          <div class="bulletin-actions">
              <button class="tbl-btn danger" data-id="${doc.id}">Delete</button>
          </div>
          `;

            div.querySelector(".tbl-btn.danger").addEventListener("click", async (event) => {
                await deleteAnnouncement(doc.id, event.currentTarget);
            });

            container.appendChild(div);
        });
    });

async function postBulletin() {
    const submitButton = document.querySelector("#bulletinModal .modal-submit-btn");
    const title = document.getElementById("bulletinTitle").value.trim();
    const body = document.getElementById("bulletinBody").value.trim();
    const type = document.getElementById("bulletinType").value;

    if (!title || !body) {
        showFormalAlert("Please complete both the announcement title and message before submitting.");
        return;
    }

    try {
        setAdminButtonLoading?.(submitButton, "Posting...");
        await callAdminApi("/api/admin/announcements/create", { title, body, type });

        document.getElementById("bulletinTitle").value = "";
        document.getElementById("bulletinBody").value = "";

        closeBulletinModal();
        showToast("Announcement posted!");
    } catch (error) {
        console.error(error);
        showFormalAlert("The announcement could not be saved at this time. " + error.message);
    } finally {
        restoreAdminButton?.(submitButton);
    }
}

async function deleteAnnouncement(id, button) {
    if (!confirm("Delete this announcement?")) {
        return;
    }

    try {
        setAdminButtonLoading?.(button, "Deleting...");
        await callAdminApi("/api/admin/announcements/delete", { announcementId: id });

        showToast("Announcement deleted.");
    } catch (error) {
        console.error("Delete failed:", error);
        showToast(`Delete failed: ${error.message}`);
    } finally {
        restoreAdminButton?.(button);
    }
}

function filterBulletin() {
    const val = document.getElementById("bulletinFilter").value;
    document.querySelectorAll(".bulletin-admin-item").forEach((item) => {
        item.style.display = val === "all" || item.dataset.type === val ? "flex" : "none";
    });
}

function showToast(msg) {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), 3000);
}

document.querySelectorAll("#btnLogout").forEach((button) => {
    button.addEventListener("click", logoutAdmin);
});

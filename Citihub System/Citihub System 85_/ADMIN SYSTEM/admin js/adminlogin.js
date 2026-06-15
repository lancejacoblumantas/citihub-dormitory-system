function hasNoCapitalLetters(input) {
    return /^[^A-Z]*$/.test(input);
}

function hasNoNumbers(input) {
    return /^[^0-9]*$/.test(input);
}

function hasNoLetters(input) {
    return /^[^a-zA-Z]*$/.test(input);
}

function hasNoSpecialCharacters(input) {
    return /^[\w\s]*$/.test(input);
}

function togglePasswordVisibility() {
    var imgLock = document.getElementById("logoPassword");
    var passwordInput = document.getElementById("loginPassword");
    passwordInput.type = passwordInput.type === "password" ? "text" : "password";
    imgLock.setAttribute("title", passwordInput.type === "password" ? "Show Password" : "Hide Password");
    imgLock.setAttribute("name", passwordInput.type === "password" ? "lock-alt" : "lock-open-alt");
    var newImgLock = imgLock.cloneNode(true);
    imgLock.parentNode.replaceChild(newImgLock, imgLock);
}

function generateRandomNumber() {
    var result = "";
    var characters = "1234567890";
    var charactersLength = characters.length;
    for (var i = 0; i < 6; i++) {
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
}

const ADMIN_MAX_FAILED_LOGIN_ATTEMPTS = 5;
const ADMIN_LOGIN_COOLDOWN_MS = 60 * 1000;
const ADMIN_FAILED_ATTEMPTS_KEY = "citihub_admin_failed_login_attempts";
const ADMIN_COOLDOWN_UNTIL_KEY = "citihub_admin_login_cooldown_until";

function getAdminLoginButtons() {
    return {
        loginBtn: document.getElementById("btnLogin"),
        googleBtn: document.getElementById("googleLoginBtn")
    };
}

function setAdminLoginButtonsLocked(locked) {
    const { loginBtn, googleBtn } = getAdminLoginButtons();
    if (loginBtn) loginBtn.disabled = locked;
    if (googleBtn) googleBtn.disabled = locked;
}

function getAdminFailedAttempts() {
    return Number(sessionStorage.getItem(ADMIN_FAILED_ATTEMPTS_KEY) || 0);
}

function setAdminFailedAttempts(value) {
    sessionStorage.setItem(ADMIN_FAILED_ATTEMPTS_KEY, String(Math.max(0, Number(value) || 0)));
}

function getAdminCooldownRemainingMs() {
    const until = Number(sessionStorage.getItem(ADMIN_COOLDOWN_UNTIL_KEY) || 0);
    return Math.max(0, until - Date.now());
}

function isAdminCooldownActive() {
    return getAdminCooldownRemainingMs() > 0;
}

function updateAdminCooldownUi() {
    const remainingMs = getAdminCooldownRemainingMs();
    if (!remainingMs) {
        sessionStorage.removeItem(ADMIN_COOLDOWN_UNTIL_KEY);
        setAdminLoginButtonsLocked(false);
        return;
    }

    const seconds = Math.ceil(remainingMs / 1000);
    setAdminLoginButtonsLocked(true);
    showFormalAlert(`For security, admin login is temporarily locked. Please try again in ${seconds} second${seconds === 1 ? "" : "s"}.`);
    setTimeout(updateAdminCooldownUi, 1000);
}

function startAdminCooldown() {
    sessionStorage.setItem(ADMIN_COOLDOWN_UNTIL_KEY, String(Date.now() + ADMIN_LOGIN_COOLDOWN_MS));
    updateAdminCooldownUi();
}

function registerAdminFailedLoginAttempt() {
    const attempts = getAdminFailedAttempts() + 1;
    setAdminFailedAttempts(attempts);

    if (attempts >= ADMIN_MAX_FAILED_LOGIN_ATTEMPTS) {
        setAdminFailedAttempts(0);
        startAdminCooldown();
        showFormalAlert("Too many unsuccessful admin login attempts. Please wait before trying again.");
        return;
    }

    const remaining = ADMIN_MAX_FAILED_LOGIN_ATTEMPTS - attempts;
    showFormalAlert(`Invalid admin credentials or unauthorized account. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining before temporary lockout.`);
}

function resetAdminLoginAttempts() {
    setAdminFailedAttempts(0);
    sessionStorage.removeItem(ADMIN_COOLDOWN_UNTIL_KEY);
    setAdminLoginButtonsLocked(false);
}

async function verifyAdminRole(user) {
    const doc = await db.collection("users").doc(user.uid).get();

    if (!doc.exists || doc.data()?.role !== "admin") {
        await auth.signOut();
        throw new Error("not-admin");
    }

    return doc.data();
}

document.getElementById("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();

    if (isAdminCooldownActive()) {
        updateAdminCooldownUi();
        return;
    }

    const email = document.getElementById("loginUsername").value;
    const password = document.getElementById("loginPassword").value;
    const rememberMe = document.getElementById("rememberMe").checked;
    const { loginBtn, googleBtn } = getAdminLoginButtons();

    try {
        setAdminButtonLoading(loginBtn, "Checking access...");
        if (googleBtn) googleBtn.disabled = true;

        await auth.setPersistence(
            rememberMe
                ? firebase.auth.Auth.Persistence.LOCAL
                : firebase.auth.Auth.Persistence.SESSION
        );

        const userCredential = await auth.signInWithEmailAndPassword(email, password);
        const user = userCredential.user;
        await verifyAdminRole(user);

        resetAdminLoginAttempts();
        window.location.href = "dashboard.html";
    } catch (error) {
        console.error(error);
        registerAdminFailedLoginAttempt();
        showFormalAlert("Invalid admin credentials or unauthorized account.");
    } finally {
        restoreAdminButton(loginBtn);
        if (googleBtn && !isAdminCooldownActive()) googleBtn.disabled = false;
    }
});

const provider = new firebase.auth.GoogleAuthProvider();

document.getElementById("googleLoginBtn").addEventListener("click", async (e) => {
    e.preventDefault();

    if (isAdminCooldownActive()) {
        updateAdminCooldownUi();
        return;
    }

    const rememberMe = document.getElementById("rememberMe").checked;
    const { loginBtn, googleBtn } = getAdminLoginButtons();

    try {
        setAdminButtonLoading(googleBtn, "Checking access...");
        if (loginBtn) loginBtn.disabled = true;

        await auth.setPersistence(
            rememberMe
                ? firebase.auth.Auth.Persistence.LOCAL
                : firebase.auth.Auth.Persistence.SESSION
        );

        const result = await auth.signInWithPopup(provider);
        const user = result.user;
        await verifyAdminRole(user);

        resetAdminLoginAttempts();
        if (typeof showSuccess === "function") {
            showSuccess("Welcome Admin!");
        }
        window.location.replace("dashboard.html");
    } catch (error) {
        console.error(error);
        registerAdminFailedLoginAttempt();
        showFormalAlert("Invalid admin credentials or unauthorized account.");
    } finally {
        restoreAdminButton(googleBtn);
        if (loginBtn && !isAdminCooldownActive()) loginBtn.disabled = false;
    }
});

document.addEventListener("DOMContentLoaded", updateAdminCooldownUi);

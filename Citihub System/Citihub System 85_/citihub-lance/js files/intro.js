
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
    return /^[\w\s]*$/.test(input); // true if NO special characters
}

function togglePasswordVisibility() {
    var imgLock = document.getElementById("logoPassword");
    var passwordInput = document.getElementById("loginPassword");
    passwordInput.type = (passwordInput.type === "password") ? "text" : "password";
    imgLock.setAttribute('title', (passwordInput.type === "password") ? 'Show Password' : 'Hide Password');
    imgLock.setAttribute('name', (passwordInput.type === "password") ? 'lock-alt' : 'lock-open-alt');
    var newImgLock = imgLock.cloneNode(true);
    imgLock.parentNode.replaceChild(newImgLock, imgLock);
}

function generateRandomNumber() {
    var result = '';
    var characters = '1234567890';
    var charactersLength = characters.length;
    for (var i = 0; i < 6; i++) {
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
}

const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOGIN_COOLDOWN_MS = 30000;

let failedLoginAttempts = 0;
let loginCooldownTimer = null;
let loginCooldownUntil = 0;

function startNewTenantSession() {
    const randomPart = crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const sessionId = `sess_${String(randomPart).replace(/[^a-zA-Z0-9_-]/g, "")}`;
    localStorage.setItem("citihub_tenant_session_id", sessionId);
    sessionStorage.removeItem("citihub_tenant_session_recorded");
}

function getAuthButtons() {
    return {
        loginBtn: document.getElementById("btnLogin"),
        googleBtn: document.getElementById("googleLoginBtn")
    };
}

function setButtonLoading(button, loadingLabel) {
    if (!button) {
        return;
    }

    setButtonOriginalMarkup(button);
    button.disabled = true;
    button.classList.add("btn-loading");
    button.innerHTML = `<span class="btn-loading-spinner" aria-hidden="true"></span><span>${loadingLabel}</span>`;
}

function restoreButton(button) {
    if (!button) {
        return;
    }

    button.classList.remove("btn-loading");
    button.disabled = false;
    if (button.dataset.originalHtml) {
        button.innerHTML = button.dataset.originalHtml;
    }
}

function setButtonOriginalMarkup(button) {
    if (button && !button.dataset.originalHtml) {
        button.dataset.originalHtml = button.innerHTML;
    }
}

function setAuthButtonsLocked(locked, secondsRemaining = 0) {
    const { loginBtn, googleBtn } = getAuthButtons();

    if (loginBtn) {
        setButtonOriginalMarkup(loginBtn);
        loginBtn.disabled = locked;
        loginBtn.textContent = locked ? `Try again in ${secondsRemaining}s` : "Log In";
    }

    if (googleBtn) {
        setButtonOriginalMarkup(googleBtn);
        googleBtn.disabled = locked;

        if (locked) {
            googleBtn.textContent = `Try again in ${secondsRemaining}s`;
        } else {
            googleBtn.innerHTML = googleBtn.dataset.originalHtml;
        }
    }
}

function isLoginCooldownActive() {
    return Date.now() < loginCooldownUntil;
}

function startLoginCooldown() {
    loginCooldownUntil = Date.now() + LOGIN_COOLDOWN_MS;
    setAuthButtonsLocked(true, Math.ceil(LOGIN_COOLDOWN_MS / 1000));

    clearInterval(loginCooldownTimer);
    loginCooldownTimer = setInterval(() => {
        const secondsRemaining = Math.max(0, Math.ceil((loginCooldownUntil - Date.now()) / 1000));

        if (secondsRemaining <= 0) {
            clearInterval(loginCooldownTimer);
            loginCooldownTimer = null;
            failedLoginAttempts = 0;
            loginCooldownUntil = 0;
            setAuthButtonsLocked(false);
            return;
        }

        setAuthButtonsLocked(true, secondsRemaining);
    }, 1000);
}

function registerFailedLoginAttempt() {
    if (isLoginCooldownActive()) {
        return;
    }

    failedLoginAttempts += 1;

    if (failedLoginAttempts >= MAX_FAILED_LOGIN_ATTEMPTS) {
        startLoginCooldown();
        showWarning("Too many failed sign-in attempts. Please wait 30 seconds before trying again.");
    }
}

function resetFailedLoginAttempts() {
    failedLoginAttempts = 0;

    if (!isLoginCooldownActive()) {
        setAuthButtonsLocked(false);
    }
}
auth.onAuthStateChanged(async (user) => {
    if (user) {
        if (!user.emailVerified && user.providerData.some(provider => provider.providerId === "password")) {
            await auth.signOut();
            return;
        }

        const doc = await db.collection("users").doc(user.uid).get();

        if (doc.exists) {
            const userData = doc.data();
                window.location.href = "main.html";
            }
        
    }
});


document.getElementById("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();

    if (isLoginCooldownActive()) {
        showWarning("Too many failed sign-in attempts. Please wait a moment before trying again.");
        return;
    }

    const email = document.getElementById("loginUsername").value;
    const password = document.getElementById("loginPassword").value;
    const rememberMe = document.getElementById("rememberMe").checked;
    const { loginBtn, googleBtn } = getAuthButtons();

    try {
        setButtonLoading(loginBtn, "Signing in...");
        if (googleBtn) {
            googleBtn.disabled = true;
        }

        //  Set persistence based on checkbox
        await auth.setPersistence(
            rememberMe 
                ? firebase.auth.Auth.Persistence.LOCAL 
                : firebase.auth.Auth.Persistence.SESSION
        );

        //  Sign in after setting persistence
        const userCredential = await auth.signInWithEmailAndPassword(email, password);
        const user = userCredential.user;

        await user.reload();

        if (!user.emailVerified) {
            await auth.signOut();
            showWarning("Please verify your email address before signing in.");
            return;
        }

        const doc = await db.collection("users").doc(user.uid).get();

        if (!doc.exists) {
            registerFailedLoginAttempt();
            showError("User account information could not be found. Please contact support.");
            return;
        }

        //  Redirect
        resetFailedLoginAttempts();
        startNewTenantSession();
        window.location.href = "main.html";

    } catch (error) {
        console.error(error);
        registerFailedLoginAttempt();
        showError("The email address or password you entered is incorrect. Please try again.");
    } finally {
        if (!isLoginCooldownActive()) {
            restoreButton(loginBtn);
            if (googleBtn) {
                googleBtn.disabled = false;
            }
        }
    }
});
const provider = new firebase.auth.GoogleAuthProvider();

document.getElementById("googleLoginBtn").addEventListener("click", async (e) => {
    e.preventDefault();

    if (isLoginCooldownActive()) {
        showWarning("Too many failed sign-in attempts. Please wait a moment before trying again.");
        return;
    }

    const rememberMe = document.getElementById("rememberMe").checked;
    const { loginBtn, googleBtn } = getAuthButtons();

    try {
        setButtonLoading(googleBtn, "Opening Google...");
        if (loginBtn) {
            loginBtn.disabled = true;
        }

        await auth.setPersistence(
            rememberMe 
                ? firebase.auth.Auth.Persistence.LOCAL 
                : firebase.auth.Auth.Persistence.SESSION
        );

        const result = await auth.signInWithPopup(provider);
        const user = result.user;

        const doc = await db.collection("users").doc(user.uid).get();

        if (!doc.exists) {
            registerFailedLoginAttempt();
            showError("This account is not properly registered in the system. Please contact support.");
            await auth.signOut(); //  important security cleanup
            return;
        }

        resetFailedLoginAttempts();
        startNewTenantSession();
        window.location.href = "main.html";

    } catch (error) {
        console.error(error);
        registerFailedLoginAttempt();
        showError("Google sign-in could not be completed at this time. Please try again.");
    } finally {
        if (!isLoginCooldownActive()) {
            restoreButton(googleBtn);
            if (loginBtn) {
                loginBtn.disabled = false;
            }
        }
    }
});
const popup = document.getElementById("appPopup");
const popupTitle = document.getElementById("popupTitle");
const popupMessage = document.getElementById("popupMessage");
const popupIcon = document.getElementById("popupIcon");
const popupCancel = document.getElementById("popupCancel");
const popupConfirm = document.getElementById("popupConfirm");
let popupHideTimer = null;

//  MAIN FUNCTION
function showPopup({ title, message, type = "success", onConfirm = null, showCancel = false }) {
    if (!popup || !popupTitle || !popupMessage || !popupIcon || !popupCancel || !popupConfirm) {
        console.warn("Popup UI is not available:", title, message);
        return;
    }

    popupTitle.textContent = title;
    popupMessage.textContent = message;

    // ICON + COLOR
    if (type === "success") {
        popupIcon.textContent = "";
        popupIcon.style.color = "#16a34a";
    } else if (type === "error") {
        popupIcon.textContent = "";
        popupIcon.style.color = "#dc2626";
    } else if (type === "warning") {
        popupIcon.textContent = "";
        popupIcon.style.color = "#f59e0b";
    }

    if (type === "success") {
        popupIcon.textContent = "OK";
        popupIcon.style.color = "#22c55e";
    } else if (type === "error") {
        popupIcon.textContent = "!";
        popupIcon.style.color = "#f87171";
    } else if (type === "warning") {
        popupIcon.textContent = "!";
        popupIcon.style.color = "#fbbf24";
    } else {
        popupIcon.textContent = "i";
        popupIcon.style.color = "#60a5fa";
    }

    // BUTTON CONTROL
    popupCancel.hidden = !showCancel;

    popup.classList.add("show");

    clearTimeout(popupHideTimer);
    popupHideTimer = setTimeout(() => {
        popup.classList.remove("show");
    }, 3500);

    // CONFIRM CLICK
    popupConfirm.onclick = () => {
        clearTimeout(popupHideTimer);
        popup.classList.remove("show");
        if (onConfirm) onConfirm();
    };

    // CANCEL CLICK
    popupCancel.onclick = () => {
        clearTimeout(popupHideTimer);
        popup.classList.remove("show");
    };
}

//  QUICK HELPERS
function showSuccess(msg) {
    showPopup({ title: "Success", message: msg, type: "success" });
}

function showError(msg) {
    showPopup({ title: "Error", message: msg, type: "error" });
}

function showWarning(msg) {
    showPopup({ title: "Warning", message: msg, type: "warning" });
}

function showConfirm(msg, callback) {
    showPopup({
        title: "Are you sure?",
        message: msg,
        type: "warning",
        showCancel: true,
        onConfirm: callback
    });
}

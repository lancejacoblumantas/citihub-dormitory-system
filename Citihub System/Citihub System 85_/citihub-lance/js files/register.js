const validationMessage = document.getElementById("emailPara");
const confirmPassPara = document.getElementById("confirm-pass-para");
const userPara = document.getElementById("new-user");
const notRobotPara = document.getElementById("not-robot-para");
const termsPara = document.getElementById("terms-para");
const newEmail = document.getElementById("newEmail");
const newPassword = document.getElementById("loginPassword");
const confirmPassword = document.getElementById("confirmPassword");
const newUser = document.getElementById("username");
const registerForm = document.getElementById("registerForm");
const provider = new firebase.auth.GoogleAuthProvider();

let currentGoogleUser = null;
let registerToastTimer = null;
let pendingRedirectAfterVerification = false;
const termsModal = document.getElementById("terms-modal");

function startNewTenantSession() {
    const randomPart = crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const sessionId = `sess_${String(randomPart).replace(/[^a-zA-Z0-9_-]/g, "")}`;
    localStorage.setItem("citihub_tenant_session_id", sessionId);
    sessionStorage.removeItem("citihub_tenant_session_recorded");
}

function rememberButtonMarkup(button) {
    if (button && !button.dataset.originalHtml) {
        button.dataset.originalHtml = button.innerHTML;
    }
}

function setButtonLoading(button, loadingLabel) {
    if (!button) {
        return;
    }

    rememberButtonMarkup(button);
    button.disabled = true;
    button.classList.add("btn-loading");
    button.innerHTML = `<span class="btn-loading-spinner" aria-hidden="true"></span><span>${loadingLabel}</span>`;
}

function restoreButton(button) {
    if (!button) {
        return;
    }

    button.disabled = false;
    button.classList.remove("btn-loading");
    if (button.dataset.originalHtml) {
        button.innerHTML = button.dataset.originalHtml;
    }
}

validationMessage.style.display = "none";
confirmPassPara.style.display = "none";
userPara.style.display = "none";
notRobotPara.style.display = "none";
termsPara.style.display = "none";

function showToast(message) {
    const toast = document.getElementById("toast");
    if (!toast) {
        return;
    }

    toast.textContent = message;
    toast.classList.add("show");

    if (registerToastTimer) {
        clearTimeout(registerToastTimer);
    }

    registerToastTimer = setTimeout(() => {
        toast.classList.remove("show");
        registerToastTimer = null;
    }, 3200);
}

function openVerifyEmailModal() {
    const modal = document.getElementById("verifyEmailModal");
    if (modal) {
        modal.style.display = "flex";
    }
}

function openTermsModal() {
    if (termsModal) {
        termsModal.style.display = "flex";
    }
}

function closeTermsModal() {
    if (termsModal) {
        termsModal.style.display = "none";
    }
}

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
    return /[^\w\s]/.test(input);
}

function normalizeGender(value) {
    const gender = String(value || "").trim().toLowerCase();
    return gender === "female" ? "female" : "male";
}

function resetValidationUI() {
    newUser.style.color = "black";
    newEmail.style.color = "black";
    newPassword.style.color = "black";
    userPara.style.display = "none";
    validationMessage.style.display = "none";
    confirmPassPara.style.display = "none";
    notRobotPara.style.display = "none";
}

document.querySelector("#newEmail").addEventListener("keypress", (event) => {
    if (event.keyCode === 32) {
        event.preventDefault();
    }
});

document.addEventListener("input", () => {
    resetValidationUI();

    if (newEmail.value.length > 0 && !newEmail.value.endsWith("@gmail.com")) {
        validationMessage.textContent = "Email must end with @gmail.com.";
        validationMessage.style.display = "block";
    }

    if ((newPassword.value.length > 0 || confirmPassword.value.length > 0) &&
        newPassword.value !== confirmPassword.value) {
        confirmPassPara.textContent = "Password doesn't match.";
        confirmPassPara.style.display = "block";
    }
});

async function validateAccount() {
    let isValid = true;
    const email = newEmail.value.trim();
    const password = newPassword.value;
    const username = newUser.value.trim();
    const genderInput = document.querySelector('input[name="gender"]:checked');
    const captchaResponse = grecaptcha.getResponse();
    const termsChecked = document.getElementById("termsCheckbox").checked;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    resetValidationUI();
    termsPara.style.display = "none";

    if (!captchaResponse) {
        notRobotPara.style.display = "block";
        isValid = false;
    }

    if (!termsChecked) {
        termsPara.style.display = "block";
        isValid = false;
    }

    if (!genderInput) {
        showToast("Please select a gender option before continuing.");
        return;
    }

    if (!emailRegex.test(email) || !email.endsWith("@gmail.com")) {
        validationMessage.textContent = "Please enter a valid Gmail address.";
        validationMessage.style.display = "block";
        newEmail.style.color = "red";
        isValid = false;
    }

    if (!username) {
        userPara.textContent = "Please enter a Username.";
        userPara.style.display = "block";
        newUser.style.color = "red";
        isValid = false;
    }

    const errors = [];
    if (password.length < 8) errors.push("Min 8 chars");
    if (hasNoCapitalLetters(password)) errors.push("1 Capital");
    if (hasNoNumbers(password)) errors.push("1 Number");
    if (hasNoLetters(password)) errors.push("1 Letter");
    if (!hasNoSpecialCharacters(password)) errors.push("1 Special");
    if (password !== confirmPassword.value) errors.push("Passwords must match");
    if (password === username) errors.push("Pass  User");
    if (password === email) errors.push("Pass  Email");

    if (errors.length > 0) {
        confirmPassPara.textContent = errors.join(", ");
        confirmPassPara.style.display = "block";
        newPassword.style.color = "red";
        isValid = false;
    }

    if (!isValid) return;

    const createAccountButton = document.getElementById("btnCreateAccount");
    const googleSignInButton = document.getElementById("googleSignInBtn");

    try {
        setButtonLoading(createAccountButton, "Creating account...");
        if (googleSignInButton) {
            googleSignInButton.disabled = true;
        }

        const userCredential = await auth.createUserWithEmailAndPassword(email, password);
        const user = userCredential.user;

        await user.sendEmailVerification();

        await db.collection("users").doc(user.uid).set({
            id: user.uid,
            username: username,
            email: email,
            gender: normalizeGender(genderInput.value),
            termsAccepted: true,
            status: "pending",
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        showToast("Account created successfully.");

        registerForm.reset();
        grecaptcha.reset();
        await auth.signOut();
        pendingRedirectAfterVerification = true;
        openVerifyEmailModal();
    } catch (error) {
        console.error(error);
        showToast(error.message || "Registration failed. Please try again.");
    } finally {
        restoreButton(createAccountButton);
        if (googleSignInButton) {
            googleSignInButton.disabled = false;
        }
    }
}

function togglePasswordVisibility() {
    const imgLock = document.getElementById("logoPassword");
    const passwordInput = document.getElementById("loginPassword");
    passwordInput.type = passwordInput.type === "password" ? "text" : "password";
    imgLock.setAttribute("title", passwordInput.type === "password" ? "Show Password" : "Hide Password");
    imgLock.setAttribute("name", passwordInput.type === "password" ? "lock-alt" : "lock-open-alt");
}

function toggleConfirmPasswordVisibility() {
    const imgLock = document.getElementById("logoConPassword");
    const passwordInput = document.getElementById("confirmPassword");
    passwordInput.type = passwordInput.type === "password" ? "text" : "password";
    imgLock.setAttribute("title", passwordInput.type === "password" ? "Show Password" : "Hide Password");
    imgLock.setAttribute("name", passwordInput.type === "password" ? "lock-alt" : "lock-open-alt");
}

registerForm.addEventListener("submit", (event) => {
    event.preventDefault();
    validateAccount();
});

document.getElementById("openTermsLink")?.addEventListener("click", (event) => {
    event.preventDefault();
    openTermsModal();
});

document.getElementById("openModalTermsLink")?.addEventListener("click", (event) => {
    event.preventDefault();
    openTermsModal();
});

document.getElementById("termsModalCloseBtn")?.addEventListener("click", () => {
    closeTermsModal();
});

auth.onAuthStateChanged(async (user) => {
    if (!user) return;

    if (!user.emailVerified && !currentGoogleUser) {
        return;
    }

    const doc = await db.collection("users").doc(user.uid).get();
    if (!doc.exists) return;

    const data = doc.data();

    if (data.gender && data.termsAccepted) {
        window.location.href = "main.html";
    } else {
        currentGoogleUser = user;
        document.getElementById("completeProfileModal").style.display = "flex";
    }
});

document.getElementById("googleSignInBtn").addEventListener("click", async (event) => {
    event.preventDefault();
    const googleSignInButton = document.getElementById("googleSignInBtn");
    const createAccountButton = document.getElementById("btnCreateAccount");

    try {
        setButtonLoading(googleSignInButton, "Opening Google...");
        if (createAccountButton) {
            createAccountButton.disabled = true;
        }

        const result = await auth.signInWithPopup(provider);
        const user = result.user;
        const docRef = db.collection("users").doc(user.uid);
        const doc = await docRef.get();

        if (!doc.exists) {
            currentGoogleUser = user;
            document.getElementById("completeProfileModal").style.display = "flex";
            return;
        }

        const data = doc.data();

        if (!data.gender || !data.termsAccepted) {
            currentGoogleUser = user;
            document.getElementById("completeProfileModal").style.display = "flex";
            return;
        }

        startNewTenantSession();
        window.location.href = "main.html";
    } catch (error) {
        console.error(error);
        showToast("Google sign up could not be completed right now. Please try again.");
    } finally {
        restoreButton(googleSignInButton);
        if (createAccountButton) {
            createAccountButton.disabled = false;
        }
    }
});

document.getElementById("saveProfileBtn").addEventListener("click", async () => {
    const gender = document.querySelector('input[name="modalGender"]:checked');
    const terms = document.getElementById("modalTerms").checked;

    if (!gender) {
        showToast("Please select a gender before continuing.");
        return;
    }

    if (!terms) {
        showToast("You must accept the terms and conditions to continue.");
        return;
    }

    if (!currentGoogleUser) {
        showToast("We could not find your Google account session. Please try again.");
        return;
    }

    try {
        await db.collection("users").doc(currentGoogleUser.uid).set({
            uid: currentGoogleUser.uid,
            username: currentGoogleUser.displayName,
            email: currentGoogleUser.email,
            profilePic: currentGoogleUser.photoURL,
            gender: normalizeGender(gender.value),
            termsAccepted: true,
            status: "pending",
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        document.getElementById("completeProfileModal").style.display = "none";
        showToast("Profile completed successfully.");
        setTimeout(() => {
            startNewTenantSession();
            window.location.href = "intro.html";
        }, 1200);
    } catch (error) {
        console.error(error);
        showToast("Unable to save your profile right now. Please try again.");
    }
});

window.onclick = function(event) {
    const modal = document.getElementById("completeProfileModal");
    if (event.target == modal) {
        // do nothing (force user to complete)
    }
    if (event.target === termsModal) {
        closeTermsModal();
    }
};

document.getElementById("continueToLoginBtn")?.addEventListener("click", () => {
    if (!pendingRedirectAfterVerification) {
        return;
    }

    pendingRedirectAfterVerification = false;
    const modal = document.getElementById("verifyEmailModal");
    if (modal) {
        modal.style.display = "none";
    }
    window.location.href = "intro.html";
});

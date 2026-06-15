let forgotPassToastTimer = null;

function setResetButtonLoading(button, isLoading) {
    if (!button) {
        return;
    }

    if (!button.dataset.originalText) {
        button.dataset.originalText = button.textContent;
    }

    button.disabled = isLoading;
    button.classList.toggle("is-loading", isLoading);
    button.innerHTML = isLoading
        ? '<span class="btn-loading-spinner" aria-hidden="true"></span><span>Sending email...</span>'
        : button.dataset.originalText;
}

function showToast(message) {
    const toast = document.getElementById("toast");
    if (!toast) {
        return;
    }

    toast.textContent = message;
    toast.classList.add("show");

    if (forgotPassToastTimer) {
        clearTimeout(forgotPassToastTimer);
    }

    forgotPassToastTimer = setTimeout(() => {
        toast.classList.remove("show");
        forgotPassToastTimer = null;
    }, 3200);
}

document.getElementById("resetForm").addEventListener("submit", async (e) => {
    e.preventDefault();

    const email = document.getElementById("resetEmail").value;
    const submitButton = e.currentTarget.querySelector(".btnLogin");
    setResetButtonLoading(submitButton, true);

    try {
        await auth.sendPasswordResetEmail(email);

        if (submitButton) {
            submitButton.dataset.originalText = "Email Sent!";
        }
        showToast("A password reset email has been sent. Please check your inbox.");

    } catch (error) {
        console.error(error);

        if (error.code === "auth/user-not-found") {
            showToast("No account was found for that email address.");
        } else if (error.code === "auth/invalid-email") {
            showToast("Please enter a valid email address.");
        } else {
            showToast("Unable to send a reset email right now. Please try again.");
        }
    } finally {
        setResetButtonLoading(submitButton, false);
    }
});

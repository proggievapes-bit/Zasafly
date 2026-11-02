const registerForm = document.getElementById("register-form");
const loginForm = document.getElementById("login-form");
const registerTab = document.getElementById("register-tab");
const loginTab = document.getElementById("login-tab");
const messageBox = document.getElementById("auth-message");
const authCard = document.getElementById("auth-card");
const dashboard = document.getElementById("dashboard");
const navLogout = document.getElementById("nav-logout");

document.getElementById("year").textContent = new Date().getFullYear();

function showMessage(message, type = "error") {
  messageBox.textContent = message;
  messageBox.className = `notice ${type}`;
}
function clearMessage() {
  messageBox.textContent = "";
  messageBox.className = "notice hidden";
}
function switchMode(mode) {
  const registering = mode === "register";
  registerForm.classList.toggle("hidden", !registering);
  loginForm.classList.toggle("hidden", registering);
  registerTab.classList.toggle("active", registering);
  loginTab.classList.toggle("active", !registering);
  document.getElementById("form-heading").innerHTML = registering
    ? 'Welcome to <span>ZasaFly.</span>' : 'Welcome back to <span>ZasaFly.</span>';
  document.getElementById("form-subheading").textContent = registering
    ? "Create an account or sign in to continue." : "Sign in with the details you used to register.";
  clearMessage();
}
function normaliseEmail(value) { return value.trim().toLowerCase(); }

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.message || "Something went wrong. Please try again.");
  return data;
}

registerForm.addEventListener("submit", async event => {
  event.preventDefault();
  clearMessage();
  const fullName = document.getElementById("full-name").value.trim();
  const studentNumber = document.getElementById("student-number").value.trim();
  const email = normaliseEmail(document.getElementById("register-email").value);
  const institution = document.getElementById("institution").value.trim();
  const password = document.getElementById("register-password").value;
  const confirmPassword = document.getElementById("confirm-password").value;

  if (fullName.length < 2) return showMessage("Please enter your full name.");
  if (password.length < 8) return showMessage("Your password must be at least 8 characters.");
  if (password !== confirmPassword) return showMessage("The passwords do not match.");
  if (!document.getElementById("agree-terms").checked) return showMessage("Please accept the prototype privacy note.");

  const button = registerForm.querySelector('[type="submit"]');
  button.disabled = true;
  button.textContent = "Creating account…";
  try {
    const data = await api("/api/register", {
      method: "POST",
      body: JSON.stringify({ fullName, studentNumber, email, institution, password })
    });
    registerForm.reset();
    showDashboard(data.user);
    showMessage("Your account has been created successfully.", "success");
  } catch (error) {
    showMessage(error.message);
  } finally {
    button.disabled = false;
    button.innerHTML = 'Create my account <span>→</span>';
  }
});

loginForm.addEventListener("submit", async event => {
  event.preventDefault();
  clearMessage();
  const email = normaliseEmail(document.getElementById("login-email").value);
  const password = document.getElementById("login-password").value;
  const button = loginForm.querySelector('[type="submit"]');
  button.disabled = true;
  button.textContent = "Logging in…";
  try {
    const data = await api("/api/login", { method: "POST", body: JSON.stringify({ email, password }) });
    loginForm.reset();
    if (data.user && data.user.role === "admin") {
      window.location.href = "/admin.html"; // admins go straight to the admin panel
      return;
    }
    showDashboard(data.user);
  } catch (error) {
    showMessage(error.message);
  } finally {
    button.disabled = false;
    button.innerHTML = 'Log in to ZasaFly <span>→</span>';
  }
});

function showDashboard(user) {
  authCard.classList.add("hidden");
  dashboard.classList.remove("hidden");
  navLogout.classList.remove("hidden");
  document.getElementById("nav-account").textContent = "My dashboard";
  document.getElementById("admin-link").classList.toggle("hidden", user.role !== "admin");
  document.getElementById("welcome-name").textContent = (user.fullName || "student").split(/\s+/)[0];
  document.getElementById("avatar").textContent = (user.fullName || "S").trim().charAt(0).toUpperCase();
  document.getElementById("profile-email").textContent = user.email || "—";
  document.getElementById("profile-institution").textContent = user.institution || "Not added";
  document.getElementById("profile-student-number").textContent = user.studentNumber || "Not added";
  document.getElementById("profile-role").textContent = user.role === "admin" ? "Administrator" : "Student";
  document.getElementById("account").scrollIntoView({ behavior: "smooth", block: "start" });
}
async function logout() {
  try { await api("/api/logout", { method: "POST", body: "{}" }); } catch {}
  dashboard.classList.add("hidden");
  authCard.classList.remove("hidden");
  navLogout.classList.add("hidden");
  document.getElementById("admin-link").classList.add("hidden");
  document.getElementById("nav-account").textContent = "Student account";
  switchMode("login");
}
registerTab.addEventListener("click", () => switchMode("register"));
loginTab.addEventListener("click", () => switchMode("login"));
document.getElementById("switch-to-login").addEventListener("click", () => switchMode("login"));
document.getElementById("switch-to-register").addEventListener("click", () => switchMode("register"));
document.getElementById("dashboard-logout").addEventListener("click", logout);
navLogout.addEventListener("click", logout);
document.querySelectorAll(".show-password").forEach(button => button.addEventListener("click", () => {
  const input = document.getElementById(button.dataset.target);
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  button.textContent = show ? "Hide" : "Show";
}));

// Basic page activity is logged by the backend. Avoid recording query strings or sensitive data.
api("/api/activity/page-view", { method: "POST", body: JSON.stringify({ page: location.pathname === "/" ? "home" : location.pathname }) }).catch(() => {});
api("/api/me").then(data => { if (data.user) showDashboard(data.user); }).catch(() => {});

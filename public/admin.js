const message = document.getElementById("admin-message");
const loginPanel = document.getElementById("login-panel");
const overview = document.getElementById("overview");
const userPanel = document.getElementById("users-section");
const activityPanel = document.getElementById("activity-section");
let searchTimer;

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.message || "Request failed.");
    error.status = response.status;
    throw error;
  }
  return data;
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char]));
}
function formatDate(value) {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}
function showMessage(text) {
  message.textContent = text;
  message.classList.remove("hidden");
}
function setDashboardVisible(visible) {
  [overview, userPanel, activityPanel].forEach(element => element.classList.toggle("hidden", !visible));
  loginPanel.classList.toggle("hidden", visible);
}
async function loadSummary() {
  const data = await api("/api/admin/summary");
  document.getElementById("stat-users").textContent = Number(data.users.totalUsers || 0).toLocaleString();
  document.getElementById("stat-students").textContent = Number(data.users.students || 0).toLocaleString();
  document.getElementById("stat-events").textContent = Number(data.activity.eventsLast24h || 0).toLocaleString();
  document.getElementById("stat-registrations").textContent = Number(data.activity.registrationsLast7d || 0).toLocaleString();
}
let knownStudentIds = null; // null until the first load, so existing rows don't flash
async function loadUsers() {
  const query = document.getElementById("user-search").value.trim();
  const data = await api(`/api/admin/students?search=${encodeURIComponent(query)}`);
  const body = document.getElementById("users-body");
  document.getElementById("students-count").textContent = Number(data.total).toLocaleString();
  document.getElementById("stat-students").textContent = Number(data.total).toLocaleString();
  document.getElementById("students-sub").textContent = query
    ? `Showing ${Number(data.matched).toLocaleString()} of ${Number(data.total).toLocaleString()} registered students.`
    : "Live list of every registered student. Disable or reactivate access below.";
  const newIds = new Set(data.students.map(student => student.id));
  if (!data.students.length) {
    body.innerHTML = `<tr><td colspan="7">${query ? "No matching students." : "No students have registered yet."}</td></tr>`;
    knownStudentIds = newIds;
    return;
  }
  body.innerHTML = data.students.map(user => `
    <tr class="${knownStudentIds && !knownStudentIds.has(user.id) ? "new-row" : ""}">
      <td><span class="person-name">${escapeHtml(user.fullName)}</span><span class="person-email">${escapeHtml(user.email)}</span></td>
      <td>${escapeHtml(user.studentNumber || "—")}</td>
      <td>${escapeHtml(user.institution || "—")}</td>
      <td>${escapeHtml(formatDate(user.createdAt))}</td>
      <td>${escapeHtml(formatDate(user.lastLoginAt))}</td>
      <td><span class="pill ${user.status === "active" ? "active" : "disabled"}">${escapeHtml(user.status)}</span></td>
      <td><button class="action-button" data-user-id="${Number(user.id)}" data-next-status="${user.status === "active" ? "disabled" : "active"}">${user.status === "active" ? "Disable" : "Reactivate"}</button></td>
    </tr>`).join("");
  if (!query) knownStudentIds = newIds; // only track the unfiltered list
}
async function loadActivity() {
  const type = document.getElementById("event-filter").value;
  const data = await api(`/api/admin/activity?type=${encodeURIComponent(type)}`);
  const body = document.getElementById("activity-body");
  if (!data.events.length) {
    body.innerHTML = '<tr><td colspan="5">No activity recorded yet.</td></tr>';
    return;
  }
  body.innerHTML = data.events.map(event => `
    <tr>
      <td><span class="event-name">${escapeHtml(event.eventType)}</span></td>
      <td>${escapeHtml(event.description)}</td>
      <td>${escapeHtml(event.email || "Anonymous / deleted account")}</td>
      <td>${escapeHtml(event.ipAddress || "—")}</td>
      <td>${escapeHtml(formatDate(event.createdAt))}</td>
    </tr>`).join("");
}
async function refreshAll() {
  message.classList.add("hidden");
  if (location.protocol === "file:") {
    setDashboardVisible(false);
    showMessage("This page was opened as a file. Start the server (npm run dev) and open http://localhost:3000/admin.html instead.");
    return;
  }
  try {
    await Promise.all([loadSummary(), loadUsers(), loadActivity()]);
    setDashboardVisible(true);
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      setDashboardVisible(false);
      showMessage(error.status === 403 ? "This account does not have admin permission. Log in with the configured administrator account." : "Please log in with the administrator account to view site activity.");
    } else {
      showMessage(`${error.message} Check that the Node server and XAMPP MySQL are running.`);
    }
  }
}
document.getElementById("refresh-button").addEventListener("click", refreshAll);
document.getElementById("user-search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadUsers().catch(error => showMessage(error.message)), 250);
});
document.getElementById("event-filter").addEventListener("change", () => loadActivity().catch(error => showMessage(error.message)));
document.getElementById("users-body").addEventListener("click", async event => {
  const button = event.target.closest("button[data-user-id]");
  if (!button) return;
  const id = button.dataset.userId;
  const status = button.dataset.nextStatus;
  if (!confirm(`Are you sure you want to ${status === "disabled" ? "disable" : "reactivate"} this student account?`)) return;
  button.disabled = true;
  try {
    await api(`/api/admin/users/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
    await Promise.all([loadUsers(), loadActivity(), loadSummary()]);
  } catch (error) {
    showMessage(error.message);
  } finally {
    button.disabled = false;
  }
});

// ---- Real-time updates ---------------------------------------------------
// The server pushes a "students" event whenever a student registers or their
// account changes. If the stream drops, we fall back to polling every 5s.
const liveBadge = document.getElementById("live-badge");
const liveText = document.getElementById("live-text");
let eventSource = null;
let fallbackTimer = null;
let liveRefreshTimer = null;

function setLive(state, text) {
  liveBadge.classList.toggle("offline", state !== "live");
  liveText.textContent = text;
}
function refreshLive() {
  // Coalesce bursts of events into a single refresh.
  clearTimeout(liveRefreshTimer);
  liveRefreshTimer = setTimeout(() => {
    Promise.all([loadSummary(), loadUsers(), loadActivity()]).catch(error => {
      if (error.status === 401 || error.status === 403) stopLive();
    });
  }, 150);
}
function startFallbackPolling() {
  if (fallbackTimer) return;
  fallbackTimer = setInterval(refreshLive, 5000);
}
function stopFallbackPolling() {
  clearInterval(fallbackTimer);
  fallbackTimer = null;
}
function stopLive() {
  if (eventSource) eventSource.close();
  eventSource = null;
  stopFallbackPolling();
  setLive("offline", "Not connected");
}
function startLive() {
  if (!window.EventSource) {
    setLive("offline", "Polling every 5s");
    startFallbackPolling();
    return;
  }
  eventSource = new EventSource("/api/admin/stream");
  eventSource.addEventListener("ready", () => {
    stopFallbackPolling();
    setLive("live", "Live");
    refreshLive(); // catch anything missed while reconnecting
  });
  eventSource.addEventListener("students", refreshLive);
  eventSource.onerror = () => {
    // EventSource retries on its own; poll in the meantime.
    setLive("offline", "Reconnecting…");
    startFallbackPolling();
  };
}

// Only open the live stream once we know an admin is signed in.
refreshAll().then(() => { if (loginPanel.classList.contains("hidden")) startLive(); });

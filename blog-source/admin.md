---
layout: page
title: Admin
permalink: /admin/
mermaid: false
---

<div id="admin-app">
  <div id="login-form">
    <h2>Verification</h2>
    <p>Enter the verification code to manage posts.</p>
    <input type="password" id="password-input" placeholder="Verification code" autocomplete="off" style="width:100%;max-width:320px;padding:10px;margin-bottom:10px;border:1px solid var(--border-color);border-radius:6px;background:var(--card-bg);color:var(--text-color);">
    <button id="login-btn" style="padding:10px 24px;border:none;border-radius:6px;background:#BB86FC;color:#fff;cursor:pointer;font-weight:600;">Verify</button>
    <p id="login-error" style="color:#ff5252;display:none;margin-top:10px;"></p>
  </div>

  <div id="admin-panel" style="display:none;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
      <h2 style="margin:0;">Blog Posts</h2>
      <button id="logout-btn" style="padding:6px 16px;border:1px solid var(--border-color);border-radius:6px;background:transparent;color:var(--text-color);cursor:pointer;">Logout</button>
    </div>
    <p id="post-count" style="color:var(--text-muted-color);margin-bottom:16px;"></p>
    <div id="post-list" style="display:flex;flex-direction:column;gap:8px;"></div>
  </div>
</div>

<script>
const API = "https://ivy-blog-bot.priyamolmpraveen2.workers.dev";

const passwordInput = document.getElementById("password-input");
const loginBtn = document.getElementById("login-btn");
const loginError = document.getElementById("login-error");
const loginForm = document.getElementById("login-form");
const adminPanel = document.getElementById("admin-panel");
const postList = document.getElementById("post-list");
const postCount = document.getElementById("post-count");
const logoutBtn = document.getElementById("logout-btn");

let currentPassword = "";

loginBtn.addEventListener("click", doLogin);
passwordInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });

async function doLogin() {
  const password = passwordInput.value.trim();
  if (!password) return;
  loginBtn.disabled = true;
  loginBtn.textContent = "Verifying...";
  loginError.style.display = "none";
  try {
    const res = await fetch(API + "/admin/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      const err = await res.json();
      loginError.textContent = err.error || "Invalid code";
      loginError.style.display = "block";
      return;
    }
    const data = await res.json();
    currentPassword = password;
    renderPosts(data.posts);
    loginForm.style.display = "none";
    adminPanel.style.display = "block";
    passwordInput.value = "";
  } catch (e) {
    loginError.textContent = "Connection error: " + e.message;
    loginError.style.display = "block";
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = "Verify";
  }
}

function renderPosts(posts) {
  postCount.textContent = posts.length + " post(s)";
  postList.innerHTML = "";
  if (posts.length === 0) {
    postList.innerHTML = '<p style="color:var(--text-muted-color);">No posts found.</p>';
    return;
  }
  for (const post of posts) {
    const slug = post.url;
    const title = slug.replace(/-/g, " ");
    const card = document.createElement("div");
    card.style.cssText = "display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border:1px solid var(--border-color);border-radius:8px;background:var(--card-bg);";
    card.innerHTML = `
      <div>
        <a href="/${slug}/" target="_blank" style="text-transform:capitalize;font-weight:500;color:var(--link-color);text-decoration:none;">${title}</a>
        <div style="font-size:0.85rem;color:var(--text-muted-color);margin-top:2px;">${post.name}</div>
      </div>
      <button class="delete-btn" data-path="${post.path}" data-sha="${post.sha}" style="padding:6px 14px;border:none;border-radius:6px;background:#ff5252;color:#fff;cursor:pointer;font-size:0.85rem;">Delete</button>
    `;
    postList.appendChild(card);
  }
  document.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this post? This cannot be undone.")) return;
      btn.disabled = true;
      btn.textContent = "Deleting...";
      try {
        const res = await fetch(API + "/admin/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: currentPassword, path: btn.dataset.path, sha: btn.dataset.sha }),
        });
        if (!res.ok) {
          const err = await res.json();
          alert("Delete failed: " + (err.error || "Unknown error"));
          btn.disabled = false;
          btn.textContent = "Delete";
          return;
        }
        btn.closest("div[style]").remove();
        const remaining = document.querySelectorAll(".delete-btn").length;
        postCount.textContent = remaining + " post(s)";
      } catch (e) {
        alert("Error: " + e.message);
        btn.disabled = false;
        btn.textContent = "Delete";
      }
    });
  });
}

logoutBtn.addEventListener("click", () => {
  currentPassword = "";
  adminPanel.style.display = "none";
  loginForm.style.display = "block";
  passwordInput.value = "";
  passwordInput.focus();
});
</script>

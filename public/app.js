const app = document.getElementById("app");
const statusBox = document.getElementById("status");
const accountDialog = document.getElementById("account-dialog");
const uploadDialog = document.getElementById("upload-dialog");
const uploadDialogMessage = document.getElementById("upload-dialog-message");
const finishUploadForm = document.getElementById("finish-upload-form");
const finishTitle = document.getElementById("finish-title");
const finishDescription = document.getElementById("finish-description");
const finishThumbnail = document.getElementById("finish-thumbnail");
const studioLink = document.getElementById("studio-link");
const accountButton = document.getElementById("account-button");
const accountSignedIn = document.getElementById("account-signed-in");
const accountSignedOut = document.getElementById("account-signed-out");
const accountName = document.getElementById("account-name");
const accountMeta = document.getElementById("account-meta");
const searchInput = document.getElementById("search-input");
const notificationsButton = document.getElementById("notifications-button");
const notificationCount = document.getElementById("notification-count");
const notificationsDialog = document.getElementById("notifications-dialog");
const notificationsList = document.getElementById("notifications-list");

let currentProfile = null;
let currentVideos = [];
let pendingUpload = null;
let currentLiveCapture = null;
let liveConnections = [];

document.getElementById("home-link").addEventListener("click", () => navigate("/"));
document.getElementById("search-form").addEventListener("submit", handleSearch);
document.getElementById("account-button").addEventListener("click", openAccountDialog);
document.getElementById("close-account-dialog").addEventListener("click", () => accountDialog.close());
document.getElementById("notifications-button").addEventListener("click", openNotifications);
document.getElementById("close-notifications-dialog").addEventListener("click", () => notificationsDialog.close());
document.getElementById("studio-link").addEventListener("click", () => navigate("/studio"));
document.getElementById("login-form").addEventListener("submit", handleLogin);
document.getElementById("signup-form").addEventListener("submit", handleSignup);
document.getElementById("logout-button").addEventListener("click", handleLogout);
document.getElementById("password-form").addEventListener("submit", handlePassword);
document.getElementById("cancel-upload").addEventListener("click", closeUploadDialog);
finishUploadForm.addEventListener("submit", finishUpload);
window.addEventListener("popstate", renderRoute);

init();

async function init() {
  await loadSession();
  await renderRoute();
}

async function loadSession() {
  const response = await fetch("/api/session");
  const payload = await response.json();
  if (!response.ok && payload.ban) {
    renderBanNotice(payload.ban);
    return;
  }
  currentProfile = payload.authenticated ? payload.profile : null;
  renderNav();
  await refreshNotifications();
}

function renderNav() {
  studioLink.classList.toggle("hidden", !currentProfile);
  notificationsButton.classList.toggle("hidden", !currentProfile);
  accountButton.textContent = currentProfile ? currentProfile.name : "Account";
}

function navigate(path) {
  history.pushState({}, "", path);
  renderRoute();
}

async function renderRoute() {
  closeLiveConnections();
  const path = window.location.pathname;
  if (path.startsWith("/view/")) {
    await renderWatchPage(path.split("/").pop());
    return;
  }
  if (path.startsWith("/live/")) {
    await renderLivePage(path.split("/").pop());
    return;
  }
  if (path.startsWith("/users/")) {
    await renderUserPage(path.split("/").pop());
    return;
  }
  if (path === "/studio") {
    await renderStudioPage();
    return;
  }
  if (path.startsWith("/communities/")) {
    await renderCommunityPage(path.split("/").pop());
    return;
  }
  await renderHomePage();
}

async function renderHomePage(query = "") {
  app.className = "app-shell";
  document.title = "Vido";
  const tabParam = new URLSearchParams(window.location.search).get("tab");
  const activeTab = tabParam === "communities" || tabParam === "minis" ? tabParam : "videos";
  const tabs = renderHomeTabs(activeTab);
  if (activeTab === "communities") {
    app.replaceChildren(tabs, await renderCommunitiesHome());
    return;
  }
  if (activeTab === "minis") {
    const endpoint = query ? `/api/minis?q=${encodeURIComponent(query)}` : "/api/minis";
    const payload = await fetchJson(endpoint);
    app.replaceChildren(tabs, renderMiniGrid(payload.minis || []));
    return;
  }
  const endpoint = query ? `/api/videos?q=${encodeURIComponent(query)}` : "/api/videos";
  const payload = await fetchJson(endpoint);
  currentVideos = payload.videos || [];
  app.replaceChildren(tabs, renderVideoGrid(currentVideos));
}

function renderHomeTabs(activeTab) {
  const tabs = el("div", "home-tabs");
  const videos = el("button", activeTab === "videos" ? "tab-button active" : "tab-button", "Videos");
  const minis = el("button", activeTab === "minis" ? "tab-button active" : "tab-button", "Minis");
  const communities = el("button", activeTab === "communities" ? "tab-button active" : "tab-button", "Communities");
  videos.type = "button";
  minis.type = "button";
  communities.type = "button";
  videos.addEventListener("click", () => navigate("/"));
  minis.addEventListener("click", () => navigate("/?tab=minis"));
  communities.addEventListener("click", () => navigate("/?tab=communities"));
  tabs.append(videos, minis, communities);
  return tabs;
}

async function renderWatchPage(videoId, options = {}) {
  const payload = await fetchJson(`/api/videos/${encodeURIComponent(videoId)}`);
  let video = payload.video;
  if (options.recordView !== false) {
    const viewPayload = await fetchJson(`/api/videos/${encodeURIComponent(videoId)}/view`, { method: "POST" });
    video = viewPayload.video || video;
  }

  document.title = `${video.title} - Vido`;
  app.className = "watch-page";
  app.replaceChildren();

  const playerWrap = el("section", "watch-player");
  const player = document.createElement("video");
  player.controls = true;
  player.preload = "metadata";
  player.src = toAssetUrl(video.url);
  playerWrap.appendChild(player);

  const details = el("section", "watch-details");
  details.appendChild(el("h1", "watch-title", video.title));

  const info = el("p", "meta-line");
  const creator = el("button", "creator-link", video.uploaderName);
  creator.type = "button";
  creator.addEventListener("click", () => navigate(`/users/${video.uploaderId}`));
  info.append(creator, document.createTextNode(` - ${formatViews(video.views)} - ${new Date(video.uploadedAt).toLocaleString()}`));
  details.appendChild(info);

  if (video.description) {
    details.appendChild(el("p", "description", video.description));
  }

  app.append(playerWrap, details, await renderComments(video));
  await renderHomePageInBackground();
}

async function renderLivePage(streamId) {
  const payload = await fetchJson(`/api/live/${encodeURIComponent(streamId)}`);
  const stream = payload.stream;
  document.title = `${stream.title} - Live - Vido`;
  app.className = "live-page";

  const viewer = el("section", "live-viewer");
  const frame = document.createElement("img");
  frame.className = "live-frame";
  frame.alt = `${stream.title} live screen`;
  frame.src = payload.frame || createLivePlaceholder(stream);
  const liveBadge = el("span", stream.active ? "live-badge" : "live-badge ended", stream.active ? "LIVE" : "ENDED");
  const endedOverlay = el("div", stream.active ? "live-ended-overlay hidden" : "live-ended-overlay", "This livestream has ended.");
  viewer.append(frame, liveBadge, endedOverlay);

  const details = el("section", "live-details");
  details.append(
    el("h1", "watch-title", stream.title),
    el("p", "meta-line", `${stream.uploaderName} - ${stream.viewerCount} watching - started ${new Date(stream.startedAt).toLocaleString()}`)
  );
  if (currentLiveCapture?.id === stream.id) {
    details.appendChild(buildStopLiveButton());
  }

  const chat = renderLiveChat(stream, payload.chat || []);
  app.replaceChildren(viewer, details, chat);
  connectLiveEvents(stream.id, frame, liveBadge, endedOverlay);
}

function renderLiveChat(stream, messages) {
  const section = el("section", "live-chat-panel");
  section.appendChild(el("h2", "", "Live chat"));
  const list = el("div", "live-chat-messages");
  list.id = "live-chat-messages";
  for (const message of messages) appendLiveChatMessage(list, message);
  section.appendChild(list);

  if (currentProfile) {
    const form = el("form", "live-chat-form");
    const input = document.createElement("input");
    input.maxLength = 300;
    input.placeholder = "Chat message";
    const button = el("button", "", "Send");
    button.type = "submit";
    form.append(input, button);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      await fetchJson(`/api/live/${encodeURIComponent(stream.id)}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
      });
      input.value = "";
    });
    section.appendChild(form);
    section.appendChild(el("p", "muted", "Only followers of the streamer can send chat messages."));
  } else {
    section.appendChild(el("p", "muted", "Log in and follow the streamer to chat."));
  }
  return section;
}

function connectLiveEvents(streamId, frame, liveBadge, endedOverlay) {
  let latestFrame = frame.src;
  const frameEvents = new EventSource(`/api/live/${encodeURIComponent(streamId)}/events`);
  frameEvents.addEventListener("frame", (event) => {
    const data = JSON.parse(event.data);
    if (data.frame && data.frame !== latestFrame) {
      latestFrame = data.frame;
      frame.src = data.frame;
    }
  });
  frameEvents.addEventListener("ended", (event) => {
    const stream = event.data ? JSON.parse(event.data) : { title: "Livestream" };
    liveBadge.textContent = "ENDED";
    liveBadge.classList.add("ended");
    frame.src = createStreamEndedPlaceholder(stream);
    endedOverlay.classList.remove("hidden");
  });

  const chatEvents = new EventSource(`/api/live/${encodeURIComponent(streamId)}/chat/events`);
  chatEvents.addEventListener("chat_init", (event) => {
    const data = JSON.parse(event.data);
    const list = document.getElementById("live-chat-messages");
    if (!list) return;
    list.replaceChildren();
    for (const message of data.messages || []) appendLiveChatMessage(list, message);
  });
  chatEvents.addEventListener("chat", (event) => {
    const list = document.getElementById("live-chat-messages");
    if (list) appendLiveChatMessage(list, JSON.parse(event.data));
  });
  chatEvents.addEventListener("ended", () => {
    const list = document.getElementById("live-chat-messages");
    if (list) appendLiveChatMessage(list, { authorName: "Vido", text: "This livestream has ended." });
  });
  liveConnections.push(frameEvents, chatEvents);
}

function appendLiveChatMessage(list, message) {
  const item = el("div", "live-chat-message");
  item.append(el("strong", "", message.authorName), document.createTextNode(` ${message.text}`));
  list.appendChild(item);
  while (list.children.length > 200) list.removeChild(list.firstChild);
  list.scrollTop = list.scrollHeight;
}

function closeLiveConnections() {
  for (const connection of liveConnections) connection.close();
  liveConnections = [];
}

async function renderComments(video) {
  const section = el("section", "comments-section");
  const payload = await fetchJson(`/api/videos/${encodeURIComponent(video.id)}/comments`);
  const title = el("h2", "", `Comments (${payload.comments.length})`);
  section.appendChild(title);

  if (currentProfile) {
    const form = el("form", "form-stack");
    const textarea = document.createElement("textarea");
    textarea.rows = 4;
    textarea.maxLength = 500;
    textarea.placeholder = "Add a comment";
    const button = el("button", "", "Post comment");
    button.type = "submit";
    form.append(textarea, button);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const text = textarea.value.trim();
      if (!text) return;
      const response = await fetch(`/api/videos/${encodeURIComponent(video.id)}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
      });
      const data = await response.json();
      if (!response.ok) {
        setStatus(data.error || "Could not post comment.");
        return;
      }
      setStatus("Comment posted.");
      await renderWatchPage(video.id, { recordView: false });
    });
    section.appendChild(form);
  } else {
    section.appendChild(el("p", "muted", "Log in to post a comment."));
  }

  const list = el("div", "comments-list");
  for (const comment of payload.comments) {
    const card = el("article", "comment-card");
    card.append(
      el("p", "comment-meta", `${comment.authorName} - ${new Date(comment.createdAt).toLocaleString()}`),
      el("p", "", comment.text)
    );
    list.appendChild(card);
  }
  section.appendChild(list);
  if (!payload.comments.length) section.appendChild(el("p", "empty-state", "No comments yet."));
  return section;
}

async function renderUserPage(userId) {
  const payload = await fetchJson(`/api/profiles/${encodeURIComponent(userId)}`);
  const profile = payload.profile;
  app.className = "watch-page";
  app.replaceChildren();
  document.title = `${profile.name} - Vido`;

  const hero = el("section", "user-hero");
  const banner = el("div", "user-banner");
  if (profile.bannerPath) banner.style.backgroundImage = `url("${toAssetUrl(profile.bannerPath)}")`;

  const info = el("div", "user-info");
  const avatar = document.createElement("img");
  avatar.className = "avatar";
  avatar.alt = `${profile.name} profile picture`;
  avatar.src = profile.picturePath ? toAssetUrl(profile.picturePath) : createAvatarPlaceholder(profile.name);
  const text = el("div", "");
  text.append(el("h1", "", profile.name), el("p", "muted", formatFollowers(profile.followerCount)));
  const follow = el("button", "follow-button hidden");
  follow.type = "button";
  renderFollowButton(follow, profile, userId);
  info.append(avatar, text, follow);
  hero.append(banner, info);

  const videos = el("section", "user-content");
  videos.append(el("h2", "", "Videos"), renderVideoGrid(payload.videos || []));
  app.append(hero, videos);
}

async function renderStudioPage() {
  app.className = "studio-page";
  if (!currentProfile) {
    app.replaceChildren(el("h1", "", "Studio"), el("p", "muted", "Log in to open Studio."));
    openAccountDialog();
    return;
  }

  document.title = "Studio - Vido";
  const header = el("div", "studio-header");
  header.append(el("h1", "", "Studio"), el("p", "muted", "Manage your channel, videos, profile picture, banner, thumbnails, and uploads."));

  const layout = el("div", "studio-layout");
  const profilePanel = el("section", "panel");
  profilePanel.appendChild(el("h2", "", "Channel"));
  profilePanel.append(
    buildNameForm(),
    buildImageForm("Profile picture", "image/png,image/jpeg,image/webp", "/api/profile-picture", "Profile picture updated."),
    buildImageForm("Banner image", "image/png,image/jpeg,image/webp", "/api/profile/banner", "Banner updated.")
  );

  const uploadPanel = el("section", "panel");
  uploadPanel.appendChild(el("h2", "", "Upload video"));
  const uploadForm = el("form", "form-stack");
  const file = document.createElement("input");
  file.type = "file";
  file.accept = "video/mp4";
  file.required = true;
  const button = el("button", "", "Upload video");
  button.type = "submit";
  uploadForm.append(file, button);
  uploadForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await startUploadFlow(file.files[0]);
    uploadForm.reset();
  });
  uploadPanel.appendChild(uploadForm);

  const miniPanel = el("section", "panel");
  miniPanel.appendChild(el("h2", "", "Upload Mini"));
  const miniForm = el("form", "form-stack");
  const miniFile = document.createElement("input");
  miniFile.type = "file";
  miniFile.accept = "video/mp4";
  miniFile.required = true;
  const miniButton = el("button", "", "Upload Mini");
  miniButton.type = "submit";
  miniForm.append(el("p", "muted", "Minis are vertical videos with a maximum length of 60 seconds."), miniFile, miniButton);
  miniForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await startUploadFlow(miniFile.files[0], "mini");
    miniForm.reset();
  });
  miniPanel.appendChild(miniForm);

  layout.append(profilePanel, uploadPanel, miniPanel);
  const livePanel = renderStudioLivePanel();
  const videosPanel = await renderStudioVideos();
  const panels = [header, layout, livePanel, videosPanel];
  if (currentProfile.isAdmin) {
    panels.push(await renderAdminPanel());
  }
  app.replaceChildren(...panels);
}

function renderStudioLivePanel() {
  const panel = el("section", "panel studio-live-panel");
  panel.appendChild(el("h2", "", "Livestream"));
  if ((currentProfile.followerCount || 0) < 10) {
    panel.appendChild(el("p", "muted", `You need at least 10 followers to start a livestream. You have ${currentProfile.followerCount || 0}.`));
    return panel;
  }

  if (currentLiveCapture) {
    panel.append(
      el("p", "live-status-text", `You are live: ${currentLiveCapture.title}`),
      buildStopLiveButton()
    );
    return panel;
  }

  const form = el("form", "form-stack");
  const title = document.createElement("input");
  title.placeholder = `${currentProfile.name} is live`;
  title.maxLength = 100;
  const button = el("button", "", "Start livestream");
  button.type = "submit";
  form.append(el("p", "muted", "Share your computer screen as a live stream. Viewers will see live screen updates and can chat if they follow you."), title, button);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await startLiveStream(title.value.trim());
  });
  panel.appendChild(form);
  return panel;
}

function buildStopLiveButton() {
  const button = el("button", "danger-button delete-video-button", "Stop livestream");
  button.type = "button";
  button.addEventListener("click", stopLiveStream);
  return button;
}

async function renderStudioVideos() {
  const payload = await fetchJson(`/api/profiles/${encodeURIComponent(currentProfile.id)}`);
  const videos = payload.videos || [];
  const panel = el("section", "panel studio-videos");
  panel.appendChild(el("h2", "", "My videos"));

  if (!videos.length) {
    panel.appendChild(el("p", "empty-state", "You have not uploaded any videos yet."));
    return panel;
  }

  const grid = el("div", "studio-video-grid");
  for (const video of videos) {
    grid.appendChild(renderStudioVideoCard(video));
  }
  panel.appendChild(grid);
  return panel;
}

function renderStudioVideoCard(video) {
  const card = el("article", "studio-video-card");
  const preview = document.createElement("button");
  preview.type = "button";
  preview.className = "studio-video-preview";
  preview.addEventListener("click", () => navigate(`/view/${video.id}`));

  if (video.thumbnailPath) {
    const image = document.createElement("img");
    image.className = "thumbnail";
    image.src = toAssetUrl(video.thumbnailPath);
    image.alt = `${video.title} thumbnail`;
    preview.appendChild(image);
  } else {
    const thumb = el("div", "thumbnail");
    thumb.appendChild(el("span", "", video.title));
    preview.appendChild(thumb);
  }

  const details = el("div", "studio-video-details");
  details.append(
    el("h3", "", video.title),
    el("p", "muted", `${formatViews(video.views)} - ${new Date(video.uploadedAt).toLocaleString()}`)
  );

  const deleteButton = el("button", "danger-button delete-video-button", "Delete video");
  deleteButton.type = "button";
  deleteButton.addEventListener("click", async () => {
    if (!window.confirm(`Delete "${video.title}" forever?`)) return;
    await fetchJson(`/api/videos/${encodeURIComponent(video.id)}`, { method: "DELETE" });
    setStatus("Video deleted.");
    await renderStudioPage();
  });

  card.append(preview, details, deleteButton);
  return card;
}

async function startLiveStream(title) {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    setStatus("Your browser does not support screen sharing.");
    return;
  }

  const data = await fetchJson("/api/live/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title })
  });
  const mediaStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  const video = document.createElement("video");
  video.muted = true;
  video.srcObject = mediaStream;
  await video.play();
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  let sendingFrame = false;
  let frameDelay = 500;

  const sendFrame = async () => {
    if (!currentLiveCapture || currentLiveCapture.id !== data.stream.id) return;
    if (!video.videoWidth || !video.videoHeight || sendingFrame) {
      currentLiveCapture.timer = window.setTimeout(sendFrame, frameDelay);
      return;
    }

    sendingFrame = true;
    const startedAt = performance.now();
    canvas.width = Math.min(video.videoWidth, 640);
    canvas.height = Math.round(video.videoHeight * (canvas.width / video.videoWidth));
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.34);
    const [, mimeType, frameData] = dataUrl.match(/^data:(.+);base64,(.+)$/) || [];
    try {
      await fetchJson(`/api/live/${encodeURIComponent(data.stream.id)}/frame-fast`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mimeType, data: frameData, streamKey: data.streamKey })
      });
      const elapsed = performance.now() - startedAt;
      frameDelay = elapsed > 700 ? 1100 : elapsed > 400 ? 800 : 500;
    } catch {
      frameDelay = 1200;
    } finally {
      sendingFrame = false;
      if (currentLiveCapture?.id === data.stream.id) {
        currentLiveCapture.timer = window.setTimeout(sendFrame, frameDelay);
      }
    }
  };

  currentLiveCapture = {
    id: data.stream.id,
    title: data.stream.title,
    mediaStream,
    timer: 0
  };
  currentLiveCapture.timer = window.setTimeout(sendFrame, 120);

  mediaStream.getVideoTracks()[0].addEventListener("ended", stopLiveStream);
  setStatus("Livestream started.");
  navigate(`/live/${data.stream.id}`);
}

async function stopLiveStream() {
  if (!currentLiveCapture) return;
  const capture = currentLiveCapture;
  currentLiveCapture = null;
  window.clearTimeout(capture.timer);
  for (const track of capture.mediaStream.getTracks()) track.stop();
  try {
    await fetchJson(`/api/live/${encodeURIComponent(capture.id)}/stop`, { method: "POST" });
  } catch {
    // If the server already stopped it, there is nothing else to clean up locally.
  }
  setStatus("Livestream stopped.");
  if (window.location.pathname === `/live/${capture.id}` || window.location.pathname === "/studio") {
    await renderRoute();
  }
}

async function renderAdminPanel() {
  const payload = await fetchJson("/api/admin");
  const panel = el("section", "panel admin-panel");
  panel.append(
    el("h2", "", "Admin panel"),
    el("p", "muted", "Only the official Vido account can see this. You can delete any video and ban users.")
  );

  const videosTitle = el("h3", "", "All videos");
  const videoList = el("div", "admin-list");
  for (const video of payload.videos || []) {
    const row = el("article", "admin-row");
    row.append(
      el("div", "", `${video.title} by ${video.uploaderName} - ${formatViews(video.views)}`),
      buildAdminDeleteVideoButton(video)
    );
    videoList.appendChild(row);
  }
  if (!videoList.children.length) videoList.appendChild(el("p", "empty-state", "No videos to moderate."));

  const usersTitle = el("h3", "", "Users");
  const userList = el("div", "admin-list");
  for (const account of payload.accounts || []) {
    userList.appendChild(buildAdminUserRow(account));
  }

  panel.append(videosTitle, videoList, usersTitle, userList);
  return panel;
}

function buildAdminDeleteVideoButton(video) {
  const button = el("button", "danger-button admin-action-button", "Delete");
  button.type = "button";
  button.addEventListener("click", async () => {
    if (!window.confirm(`Admin delete "${video.title}"?`)) return;
    await fetchJson(`/api/admin/videos/${encodeURIComponent(video.id)}`, { method: "DELETE" });
    setStatus("Video deleted by admin.");
    await renderStudioPage();
  });
  return button;
}

function buildAdminUserRow(account) {
  const row = el("article", "admin-user-row");
  const summary = el("div", "admin-user-summary");
  summary.append(
    el("strong", "", account.name),
    el("span", "muted", ` ${account.id}${account.lastIp ? ` - ${account.lastIp}` : ""}`)
  );
  if (account.ban) {
    summary.appendChild(el("p", "admin-ban-note", `Banned: ${account.ban.type} - ${account.ban.reason}`));
  }

  const form = el("form", "admin-ban-form");
  const type = document.createElement("select");
  for (const option of ["temporary", "permanent", "poison"]) {
    const choice = document.createElement("option");
    choice.value = option;
    choice.textContent = option === "poison" ? "poison IP" : option;
    type.appendChild(choice);
  }
  const minutes = document.createElement("input");
  minutes.type = "number";
  minutes.min = "1";
  minutes.max = "525600";
  minutes.value = "60";
  minutes.title = "Temporary ban length in minutes";
  const reason = document.createElement("input");
  reason.placeholder = "Ban reason";
  reason.maxLength = 500;
  reason.required = true;
  const banButton = el("button", "danger-button admin-action-button", "Ban");
  banButton.type = "submit";
  banButton.disabled = account.isAdmin;
  form.append(type, minutes, reason, banButton);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await fetchJson(`/api/admin/users/${encodeURIComponent(account.id)}/ban`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: type.value,
        minutes: minutes.value,
        reason: reason.value
      })
    });
    setStatus(`${account.name} was banned.`);
    await renderStudioPage();
  });

  row.append(summary, form);
  if (account.ban) {
    const unban = el("button", "secondary-button admin-action-button", "Unban");
    unban.type = "button";
    unban.addEventListener("click", async () => {
      await fetchJson(`/api/admin/users/${encodeURIComponent(account.id)}/unban`, { method: "POST" });
      setStatus(`${account.name} was unbanned.`);
      await renderStudioPage();
    });
    row.appendChild(unban);
  }
  return row;
}

async function renderCommunitiesHome() {
  const shell = el("section", "communities-home");
  if (!currentProfile) {
    shell.append(el("h1", "", "Communities"), el("p", "muted", "Log in to see and join communities."));
    return shell;
  }

  const payload = await fetchJson("/api/communities");
  const header = el("div", "communities-header");
  header.append(el("div", "", ""), buildCreateCommunityButton());
  header.firstChild.append(el("h1", "", "Communities"), el("p", "muted", "Chat with friends, join public groups, and make bulletin-board message walls."));

  const mine = el("section", "community-section");
  mine.appendChild(el("h2", "", "Your communities"));
  const mineGrid = el("div", "community-grid");
  for (const community of payload.mine || []) mineGrid.appendChild(renderCommunityCard(community));
  if (!mineGrid.children.length) mineGrid.appendChild(el("p", "empty-state", "You are not in any communities yet."));
  mine.appendChild(mineGrid);

  const publicSection = el("section", "community-section");
  publicSection.appendChild(el("h2", "", "Public communities"));
  const publicGrid = el("div", "community-grid");
  for (const community of payload.public || []) publicGrid.appendChild(renderCommunityCard(community));
  if (!publicGrid.children.length) publicGrid.appendChild(el("p", "empty-state", "No public communities yet."));
  publicSection.appendChild(publicGrid);

  shell.append(header, mine, publicSection);
  return shell;
}

function buildCreateCommunityButton() {
  const button = el("button", "nav-button", "Create community");
  button.type = "button";
  button.addEventListener("click", () => app.appendChild(renderCreateCommunityForm()));
  return button;
}

function renderCreateCommunityForm() {
  const panel = el("section", "panel create-community-panel");
  const form = el("form", "form-stack");
  const name = document.createElement("input");
  name.placeholder = "Community name";
  name.maxLength = 80;
  name.required = true;
  const description = document.createElement("textarea");
  description.placeholder = "Description";
  description.maxLength = 500;
  const maxMembers = document.createElement("input");
  maxMembers.type = "number";
  maxMembers.min = "2";
  maxMembers.max = "100";
  maxMembers.value = "25";
  const isPublic = document.createElement("input");
  isPublic.type = "checkbox";
  const publicLabel = el("label", "checkbox-line");
  publicLabel.append(isPublic, document.createTextNode(" Public community"));
  const picture = document.createElement("input");
  picture.type = "file";
  picture.accept = "image/png,image/jpeg,image/webp";
  const banner = document.createElement("input");
  banner.type = "file";
  banner.accept = "image/png,image/jpeg,image/webp";
  const submit = el("button", "", "Create");
  submit.type = "submit";
  form.append(
    el("h2", "", "Create community"),
    name,
    description,
    el("label", "", "Max members"),
    maxMembers,
    publicLabel,
    el("label", "", "Profile picture"),
    picture,
    el("label", "", "Banner"),
    banner,
    submit
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = {
      name: name.value,
      description: description.value,
      maxMembers: maxMembers.value,
      isPublic: isPublic.checked
    };
    if (picture.files[0]) payload.picture = await buildFilePayload(picture.files[0]);
    if (banner.files[0]) payload.banner = await buildFilePayload(banner.files[0]);
    const data = await fetchJson("/api/communities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    navigate(`/communities/${data.community.id}`);
  });
  panel.appendChild(form);
  return panel;
}

function renderCommunityCard(community) {
  const card = el("article", "community-card");
  const banner = el("div", "community-card-banner");
  if (community.bannerPath) banner.style.backgroundImage = `url("${toAssetUrl(community.bannerPath)}")`;
  const body = el("div", "community-card-body");
  const avatar = document.createElement("img");
  avatar.className = "community-avatar";
  avatar.alt = `${community.name} picture`;
  avatar.src = community.picturePath ? toAssetUrl(community.picturePath) : createAvatarPlaceholder(community.name);
  const open = el("button", "community-open-button", community.isMember ? "Open" : "Join");
  open.type = "button";
  open.addEventListener("click", async () => {
    if (!community.isMember && community.isPublic) {
      await fetchJson(`/api/communities/${encodeURIComponent(community.id)}/join`, { method: "POST" });
    }
    navigate(`/communities/${community.id}`);
  });
  body.append(
    avatar,
    el("h3", "", community.name),
    el("p", "muted", `${community.memberCount}/${community.maxMembers} members - ${community.boardCount} boards`),
    el("p", "", community.description || "No description yet."),
    open
  );
  card.append(banner, body);
  return card;
}

async function renderCommunityPage(communityId) {
  if (!currentProfile) {
    app.className = "app-shell";
    app.replaceChildren(el("h1", "", "Community"), el("p", "muted", "Log in to open communities."));
    openAccountDialog();
    return;
  }
  const params = new URLSearchParams(window.location.search);
  if (params.get("acceptInvite")) {
    await fetchJson(`/api/communities/${encodeURIComponent(communityId)}/join`, { method: "POST" });
    history.replaceState({}, "", `/communities/${communityId}`);
  }
  const payload = await fetchJson(`/api/communities/${encodeURIComponent(communityId)}`);
  const community = payload.community;
  document.title = `${community.name} - Vido`;
  app.className = "community-page";
  const hero = renderCommunityHero(community);
  const controls = renderCommunityControls(community);
  const boards = el("section", "boards-shell");
  boards.append(el("h2", "", "Message boards"), renderBoardCreator(community));
  for (const board of community.boards || []) {
    boards.appendChild(renderBoard(community, board));
  }
  app.replaceChildren(hero, controls, boards);
}

function renderCommunityHero(community) {
  const hero = el("section", "community-hero");
  const banner = el("div", "community-hero-banner");
  if (community.bannerPath) banner.style.backgroundImage = `url("${toAssetUrl(community.bannerPath)}")`;
  const info = el("div", "community-hero-info");
  const avatar = document.createElement("img");
  avatar.className = "community-avatar large";
  avatar.src = community.picturePath ? toAssetUrl(community.picturePath) : createAvatarPlaceholder(community.name);
  avatar.alt = `${community.name} picture`;
  info.append(
    avatar,
    el("h1", "", community.name),
    el("p", "muted", `${community.memberCount}/${community.maxMembers} members - Owner: ${community.ownerName}`),
    el("p", "", community.description || "No description yet.")
  );
  hero.append(banner, info);
  return hero;
}

function renderCommunityControls(community) {
  const panel = el("section", "panel community-controls");
  if (!community.isMember) {
    const join = el("button", "nav-button", community.isPublic || community.isInvited ? "Join community" : "Invite only");
    join.type = "button";
    join.disabled = !community.isPublic && !community.isInvited;
    join.addEventListener("click", async () => {
      await fetchJson(`/api/communities/${encodeURIComponent(community.id)}/join`, { method: "POST" });
      await renderCommunityPage(community.id);
    });
    panel.appendChild(join);
    return panel;
  }

  const inviteForm = el("form", "inline-form");
  const inviteName = document.createElement("input");
  inviteName.placeholder = "Username to invite";
  const inviteButton = el("button", "", "Invite");
  inviteButton.type = "submit";
  inviteForm.append(inviteName, inviteButton);
  inviteForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await fetchJson(`/api/communities/${encodeURIComponent(community.id)}/invite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: inviteName.value })
    });
    inviteForm.reset();
    setStatus("Invite sent.");
  });
  panel.appendChild(inviteForm);

  if (community.isOwner) {
    const settings = el("form", "inline-form");
    const maxMembers = document.createElement("input");
    maxMembers.type = "number";
    maxMembers.min = "2";
    maxMembers.max = "100";
    maxMembers.value = community.maxMembers;
    const publicBox = document.createElement("input");
    publicBox.type = "checkbox";
    publicBox.checked = community.isPublic;
    const label = el("label", "checkbox-line");
    label.append(publicBox, document.createTextNode(" Public"));
    const save = el("button", "", "Save settings");
    save.type = "submit";
    settings.append(el("span", "muted", "Max members"), maxMembers, label, save);
    settings.addEventListener("submit", async (event) => {
      event.preventDefault();
      await fetchJson(`/api/communities/${encodeURIComponent(community.id)}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxMembers: maxMembers.value, isPublic: publicBox.checked })
      });
      await renderCommunityPage(community.id);
    });
    panel.appendChild(settings);
  }

  const members = el("div", "member-list");
  members.appendChild(el("h3", "", "Members"));
  for (const member of community.members || []) {
    const row = el("div", "member-row");
    row.appendChild(el("span", "", `${member.name}${community.ownerId === member.id ? " (owner)" : community.adminIds.includes(member.id) ? " (admin)" : ""}`));
    if (community.isAdmin && member.id !== community.ownerId && member.id !== currentProfile.id) {
      const remove = el("button", "secondary-button", "Remove");
      remove.type = "button";
      remove.addEventListener("click", async () => {
        await fetchJson(`/api/communities/${encodeURIComponent(community.id)}/members/${encodeURIComponent(member.id)}`, { method: "DELETE" });
        await renderCommunityPage(community.id);
      });
      row.appendChild(remove);
    }
    if (community.isOwner && member.id !== community.ownerId && !community.adminIds.includes(member.id)) {
      const admin = el("button", "secondary-button", "Make admin");
      admin.type = "button";
      admin.addEventListener("click", async () => {
        await fetchJson(`/api/communities/${encodeURIComponent(community.id)}/admins/${encodeURIComponent(member.id)}`, { method: "POST" });
        await renderCommunityPage(community.id);
      });
      row.appendChild(admin);
    }
    members.appendChild(row);
  }
  panel.appendChild(members);
  return panel;
}

function renderBoardCreator(community) {
  if (!community.isMember) return el("p", "muted", "Join to create message boards.");
  const form = el("form", "inline-form board-create-form");
  const title = document.createElement("input");
  title.placeholder = `${currentProfile.name}'s Message Board`;
  const button = el("button", "", "Start message board");
  button.type = "submit";
  form.append(title, button);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await fetchJson(`/api/communities/${encodeURIComponent(community.id)}/boards`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title.value })
    });
    await renderCommunityPage(community.id);
  });
  return form;
}

function renderBoard(community, board) {
  const boardEl = el("article", "bulletin-board");
  const header = el("div", "board-header");
  header.appendChild(el("h3", "", board.title));
  if (community.isAdmin) {
    const remove = el("button", "secondary-button", "Remove board");
    remove.type = "button";
    remove.addEventListener("click", async () => {
      await fetchJson(`/api/communities/${encodeURIComponent(community.id)}/boards/${encodeURIComponent(board.id)}`, { method: "DELETE" });
      await renderCommunityPage(community.id);
    });
    header.appendChild(remove);
  }
  boardEl.appendChild(header);
  const notes = el("div", "board-notes");
  for (const message of board.messages || []) notes.appendChild(renderBoardMessage(message));
  if (!notes.children.length) notes.appendChild(el("p", "empty-state", "No posts yet. Pin the first note."));
  boardEl.append(notes, renderMessageForm(community, board));
  return boardEl;
}

function renderBoardMessage(message) {
  const note = el("article", "board-note");
  note.append(el("strong", "", message.authorName), el("p", "", message.text));
  if (message.attachmentPath) {
    if (message.attachmentType === "video/mp4") {
      const video = document.createElement("video");
      video.controls = true;
      video.src = toAssetUrl(message.attachmentPath);
      note.appendChild(video);
    } else {
      const image = document.createElement("img");
      image.src = toAssetUrl(message.attachmentPath);
      image.alt = "Board attachment";
      note.appendChild(image);
    }
  }
  if (message.linkedAccountId && message.linkedAccountName) {
    const link = el("button", "link-chip", `@${message.linkedAccountName}`);
    link.type = "button";
    link.addEventListener("click", () => navigate(`/users/${message.linkedAccountId}`));
    note.appendChild(link);
  }
  if (message.linkedVideoId && message.linkedVideoTitle) {
    const link = el("button", "link-chip", `Video: ${message.linkedVideoTitle}`);
    link.type = "button";
    link.addEventListener("click", () => navigate(`/view/${message.linkedVideoId}`));
    note.appendChild(link);
  }
  note.appendChild(el("small", "muted", new Date(message.createdAt).toLocaleString()));
  return note;
}

function renderMessageForm(community, board) {
  if (!community.isMember) return el("p", "muted", "Join to post.");
  const form = el("form", "board-message-form");
  const text = document.createElement("textarea");
  text.placeholder = "Write a note for the board";
  text.maxLength = 1000;
  const attachment = document.createElement("input");
  attachment.type = "file";
  attachment.accept = "image/png,image/jpeg,image/webp,video/mp4";
  const linkToggle = el("button", "secondary-button", "Add Vido link");
  linkToggle.type = "button";
  const linkFields = el("div", "link-fields hidden");
  const linkedAccountId = document.createElement("input");
  linkedAccountId.placeholder = "Optional Vido account ID link";
  const linkedVideoId = document.createElement("input");
  linkedVideoId.placeholder = "Optional video ID link";
  linkFields.append(linkedAccountId, linkedVideoId);
  linkToggle.addEventListener("click", () => linkFields.classList.toggle("hidden"));
  const submit = el("button", "", "Pin message");
  submit.type = "submit";
  form.append(text, attachment, linkToggle, linkFields, submit);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = {
      text: text.value,
      linkedAccountId: linkedAccountId.value.trim(),
      linkedVideoId: linkedVideoId.value.trim()
    };
    if (attachment.files[0]) payload.attachment = await buildFilePayload(attachment.files[0]);
    await fetchJson(`/api/communities/${encodeURIComponent(community.id)}/boards/${encodeURIComponent(board.id)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    await renderCommunityPage(community.id);
  });
  return form;
}

function renderVideoGrid(videos) {
  const grid = el("section", "video-grid");
  if (!videos.length) {
    grid.appendChild(el("p", "empty-state", "No videos yet."));
    return grid;
  }
  for (const video of videos) grid.appendChild(renderVideoCard(video));
  return grid;
}

function renderMiniGrid(minis) {
  const grid = el("section", "mini-grid");
  if (!minis.length) {
    grid.appendChild(el("p", "empty-state", "No Minis yet."));
    return grid;
  }
  for (const mini of minis) grid.appendChild(renderMiniCard(mini));
  return grid;
}

function renderMiniCard(mini) {
  const card = el("article", "mini-card");
  const button = document.createElement("button");
  button.type = "button";
  button.addEventListener("click", () => navigate(`/view/${mini.id}`));

  if (mini.thumbnailPath) {
    const image = document.createElement("img");
    image.className = "mini-thumbnail";
    image.src = toAssetUrl(mini.thumbnailPath);
    image.alt = `${mini.title} thumbnail`;
    button.appendChild(image);
  } else {
    const thumb = el("div", "mini-thumbnail mini-fallback");
    thumb.appendChild(el("span", "", mini.title));
    button.appendChild(thumb);
  }

  button.append(
    el("h3", "", mini.title),
    el("p", "", `${mini.uploaderName} - ${formatDuration(mini.durationSeconds)} - ${formatViews(mini.views)}`)
  );
  card.appendChild(button);
  return card;
}

function renderVideoCard(video) {
  const card = el("article", "video-card");
  if (video.type === "live") card.classList.add("live-video-card");
  const button = document.createElement("button");
  button.type = "button";
  button.addEventListener("click", () => navigate(video.type === "live" ? `/live/${video.id}` : `/view/${video.id}`));

  if (video.type === "live") {
    const thumb = el("div", "thumbnail live-thumbnail");
    thumb.append(el("span", "live-card-badge", "LIVE"), el("span", "", video.title));
    button.appendChild(thumb);
  } else if (video.thumbnailPath) {
    const image = document.createElement("img");
    image.className = "thumbnail";
    image.src = toAssetUrl(video.thumbnailPath);
    image.alt = `${video.title} thumbnail`;
    button.appendChild(image);
  } else {
    const thumb = el("div", "thumbnail");
    thumb.appendChild(el("span", "", video.title));
    button.appendChild(thumb);
  }

  const info = video.type === "live" ? `${video.uploaderName} - live now` : `${video.uploaderName} - ${formatViews(video.views)}`;
  button.append(el("h3", "", video.title), el("p", "", info));
  card.appendChild(button);
  return card;
}

function buildNameForm() {
  const form = el("form", "form-stack");
  const label = el("label", "", "Username");
  const input = document.createElement("input");
  input.value = currentProfile.name;
  input.maxLength = 40;
  input.required = true;
  const button = el("button", "", "Save username");
  button.type = "submit";
  form.append(label, input, button);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const profile = await fetchJson("/api/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: input.value })
    });
    currentProfile = profile;
    renderNav();
    setStatus("Username saved.");
  });
  return form;
}

function buildImageForm(labelText, accept, endpoint, message) {
  const form = el("form", "form-stack");
  const label = el("label", "", labelText);
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.required = true;
  const button = el("button", "", "Upload");
  button.type = "submit";
  form.append(label, input, button);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const file = input.files[0];
    const payload = await buildFilePayload(file);
    const profile = await fetchJson(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    currentProfile = profile;
    form.reset();
    setStatus(message);
  });
  return form;
}

async function startUploadFlow(file, kind = "video") {
  if (!file) return;
  const durationSeconds = await getVideoDuration(file);
  if (kind === "mini" && durationSeconds > 60) {
    setStatus("Vido Minis must be 60 seconds or less.");
    return;
  }
  uploadDialogMessage.classList.remove("hidden");
  finishUploadForm.classList.add("hidden");
  uploadDialog.showModal();
  pendingUpload = await buildFilePayload(file);
  pendingUpload.kind = kind;
  pendingUpload.durationSeconds = Math.round(durationSeconds);
  finishTitle.value = file.name.replace(/\.[^/.]+$/, "");
  finishDescription.value = "";
  finishThumbnail.value = "";
  uploadDialogMessage.classList.add("hidden");
  finishUploadForm.classList.remove("hidden");
}

async function finishUpload(event) {
  event.preventDefault();
  if (!pendingUpload) return;
  const thumbnailFile = finishThumbnail.files[0];
  const payload = {
    ...pendingUpload,
    title: finishTitle.value.trim(),
    description: finishDescription.value.trim()
  };
  if (thumbnailFile) payload.thumbnail = await buildFilePayload(thumbnailFile);

  const data = await fetchJson("/api/videos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  pendingUpload = null;
  closeUploadDialog();
  setStatus(data.message || "Video uploaded.");
  navigate(`/view/${data.video.id}`);
}

function closeUploadDialog() {
  pendingUpload = null;
  uploadDialog.close();
}

function openAccountDialog() {
  accountSignedIn.classList.toggle("hidden", !currentProfile);
  accountSignedOut.classList.toggle("hidden", Boolean(currentProfile));
  if (currentProfile) {
    accountName.textContent = currentProfile.name;
    accountMeta.textContent = `${formatFollowers(currentProfile.followerCount)} - ${currentProfile.id}`;
  }
  accountDialog.showModal();
}

async function handleLogin(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const payload = await fetchJson("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: document.getElementById("login-name").value.trim(),
        password: document.getElementById("login-password").value
      })
    });
    currentProfile = payload.profile;
    form.reset();
    accountDialog.close();
    renderNav();
    await refreshNotifications();
    await renderRoute();
  } catch (error) {
    if (error.payload?.ban) {
      accountDialog.close();
      renderBanNotice(error.payload.ban);
    }
  }
}

async function handleSignup(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const payload = await fetchJson("/api/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: document.getElementById("signup-name").value.trim(),
        password: document.getElementById("signup-password").value
      })
    });
    currentProfile = payload.profile;
    form.reset();
    accountDialog.close();
    renderNav();
    await refreshNotifications();
    await renderRoute();
  } catch (error) {
    if (error.payload?.ban) {
      accountDialog.close();
      renderBanNotice(error.payload.ban);
    }
  }
}

async function handleLogout() {
  await fetchJson("/api/logout", { method: "POST" });
  currentProfile = null;
  accountDialog.close();
  renderNav();
  await renderRoute();
}

async function handlePassword(event) {
  event.preventDefault();
  await fetchJson("/api/profile/password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      currentPassword: document.getElementById("current-password").value,
      newPassword: document.getElementById("new-password").value
    })
  });
  event.currentTarget.reset();
  setStatus("Password saved.");
}

async function handleSearch(event) {
  event.preventDefault();
  navigate("/");
  await renderHomePage(searchInput.value.trim());
}

function renderFollowButton(button, profile, userId) {
  if (currentProfile && currentProfile.id === userId) {
    button.classList.add("hidden");
    return;
  }
  button.classList.remove("hidden");
  if (!currentProfile) {
    button.textContent = "Log in to follow";
    button.addEventListener("click", openAccountDialog);
    return;
  }
  if (!profile.canFollow) {
    button.classList.add("hidden");
    return;
  }
  button.textContent = profile.isFollowedByViewer ? "Unfollow" : "Follow";
  button.addEventListener("click", async () => {
    const method = profile.isFollowedByViewer ? "DELETE" : "POST";
    await fetchJson(`/api/profiles/${encodeURIComponent(userId)}/follow`, { method });
    await refreshNotifications();
    await renderUserPage(userId);
  });
}

async function openNotifications() {
  await renderNotificationsPanel();
  notificationsDialog.showModal();
}

async function refreshNotifications() {
  if (!currentProfile) {
    notificationCount.classList.add("hidden");
    return;
  }
  try {
    const payload = await fetchJson("/api/notifications");
    notificationCount.textContent = payload.unreadCount;
    notificationCount.classList.toggle("hidden", payload.unreadCount === 0);
  } catch {
    notificationCount.classList.add("hidden");
  }
}

async function renderNotificationsPanel() {
  const payload = await fetchJson("/api/notifications");
  notificationsList.replaceChildren();
  const markAll = el("button", "secondary-button", "Mark all read");
  markAll.type = "button";
  markAll.addEventListener("click", async () => {
    await fetchJson("/api/notifications/read-all", { method: "POST" });
    await refreshNotifications();
    await renderNotificationsPanel();
  });
  notificationsList.appendChild(markAll);
  for (const notification of payload.notifications || []) {
    const item = el("button", notification.readAt ? "notification-item" : "notification-item unread");
    item.type = "button";
    item.append(el("strong", "", notification.text), el("small", "muted", new Date(notification.createdAt).toLocaleString()));
    item.addEventListener("click", async () => {
      await fetchJson(`/api/notifications/${encodeURIComponent(notification.id)}/read`, { method: "POST" });
      notificationsDialog.close();
      await refreshNotifications();
      if (notification.link) navigate(notification.link);
    });
    notificationsList.appendChild(item);
  }
  if ((payload.notifications || []).length === 0) {
    notificationsList.appendChild(el("p", "empty-state", "No notifications yet."));
  }
}

async function renderHomePageInBackground() {
  const payload = await fetchJson("/api/videos");
  currentVideos = payload.videos || [];
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) {
    setStatus(payload.error || "Request failed.");
    const error = new Error(payload.error || "Request failed.");
    error.payload = payload;
    throw error;
  }
  return payload;
}

function renderBanNotice(ban) {
  currentProfile = null;
  renderNav();
  app.className = "app-shell";
  const card = el("section", "ban-notice");
  card.append(
    el("h1", "", ban.title || "Account Banned"),
    el("p", "", ban.reason ? `Reason: ${ban.reason}` : "No reason was given.")
  );
  if (ban.type === "temporary" && ban.endsAt) {
    card.appendChild(el("p", "", `You will be unbanned on ${new Date(ban.endsAt).toLocaleString()}.`));
  }
  if (ban.permanentText) card.appendChild(el("p", "", ban.permanentText));
  if (ban.poisonedText) card.appendChild(el("p", "", ban.poisonedText));
  app.replaceChildren(card);
}

function setStatus(message) {
  statusBox.textContent = message;
  clearTimeout(setStatus.timer);
  setStatus.timer = setTimeout(() => {
    statusBox.textContent = "";
  }, 3200);
}

function el(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function toAssetUrl(assetPath) {
  return `/${encodeURI(String(assetPath).replace(/^[/\\]+/, "").replace(/\\/g, "/"))}`;
}

async function buildFilePayload(file) {
  const dataUrl = await readFileAsDataUrl(file);
  const [, mimeType, data] = dataUrl.match(/^data:(.+);base64,(.+)$/) || [];
  return { fileName: file.name, mimeType, data };
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Failed to read file."));
    reader.readAsDataURL(file);
  });
}

function createAvatarPlaceholder(name) {
  const letter = (name || "V").trim().charAt(0).toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" rx="8" fill="#e12b2b"/><text x="50%" y="56%" text-anchor="middle" font-size="52" font-family="Segoe UI, sans-serif" font-weight="900" fill="white">${letter}</text></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

function createLivePlaceholder(stream) {
  const title = stream?.title || "Live";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"><rect width="1280" height="720" fill="#080b12"/><circle cx="640" cy="300" r="74" fill="#e12b2b"/><text x="640" y="315" text-anchor="middle" font-size="46" font-family="Segoe UI, sans-serif" font-weight="900" fill="white">LIVE</text><text x="640" y="430" text-anchor="middle" font-size="42" font-family="Segoe UI, sans-serif" font-weight="800" fill="#f8fafc">${escapeSvg(title)}</text><text x="640" y="495" text-anchor="middle" font-size="24" font-family="Segoe UI, sans-serif" fill="#94a3b8">Waiting for screen frames...</text></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

function createStreamEndedPlaceholder(stream) {
  const title = stream?.title || "Livestream";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"><rect width="1280" height="720" fill="#111827"/><circle cx="640" cy="285" r="76" fill="#475569"/><text x="640" y="302" text-anchor="middle" font-size="44" font-family="Segoe UI, sans-serif" font-weight="900" fill="white">ENDED</text><text x="640" y="420" text-anchor="middle" font-size="42" font-family="Segoe UI, sans-serif" font-weight="800" fill="#f8fafc">${escapeSvg(title)}</text><text x="640" y="486" text-anchor="middle" font-size="25" font-family="Segoe UI, sans-serif" fill="#cbd5e1">The streamer has stopped broadcasting.</text></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

function escapeSvg(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[character];
  });
}

function formatViews(views) {
  const count = Number(views || 0);
  return `${count} view${count === 1 ? "" : "s"}`;
}

function formatFollowers(count) {
  const total = Number(count || 0);
  return `${total} follower${total === 1 ? "" : "s"}`;
}

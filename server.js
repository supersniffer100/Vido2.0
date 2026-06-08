const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { randomUUID, scryptSync, timingSafeEqual } = require("crypto");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const LEGACY_PROFILE_DIR = path.join(DATA_DIR, "profile-pictures");
const LEGACY_VIDEO_DIR = path.join(DATA_DIR, "videos");
const DB_PATH = path.join(DATA_DIR, "db.json");
const PID_PATH = path.join(ROOT, ".vido-server.pid");
const PORT = process.env.PORT || 3000;

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp"
};

const BLOCKED_WORDS = [
  "asshole",
  "bastard",
  "bitch",
  "bullshit",
  "cocksucker",
  "cunt",
  "damn",
  "dick",
  "douche",
  "fag",
  "fuck",
  "fucker",
  "goddamn",
  "hell",
  "motherfucker",
  "nigger",
  "piss",
  "prick",
  "shit",
  "slut",
  "whore"
];

const liveFrameClients = new Map();
const liveChatClients = new Map();
const liveFrames = new Map();
const liveFrameKeys = new Map();

ensureDir(DATA_DIR);
ensureDir(LEGACY_PROFILE_DIR);
ensureDir(LEGACY_VIDEO_DIR);
ensureDb();
migrateDb();
writePidFile();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const clientIp = getClientIp(req);

    if (req.method === "GET" && url.pathname === "/api/session") {
      const db = readDb();
      const account = getAuthenticatedAccount(req, db);
      if (!account) {
        return sendJson(res, 200, { authenticated: false });
      }
      const ban = getActiveAccountBan(account);
      if (ban) {
        destroySession(req, db);
        clearSessionCookie(res);
        writeDb(db);
        return sendJson(res, 403, {
          authenticated: false,
          error: getBanTitle(ban),
          ban: formatBanNotice(ban)
        });
      }
      return sendJson(res, 200, { authenticated: true, profile: sanitizeAccount(account) });
    }

    if (req.method === "POST" && url.pathname === "/api/signup") {
      const body = await readJsonBody(req);
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const password = typeof body.password === "string" ? body.password : "";

      if (!name) {
        return sendJson(res, 400, { error: "Username is required." });
      }
      if (password.length < 4) {
        return sendJson(res, 400, { error: "Password must be at least 4 characters." });
      }

      const db = readDb();
      const poisonBan = getActivePoisonBan(db, clientIp);
      if (poisonBan) {
        return sendJson(res, 403, {
          error: "Device Poisoned",
          ban: formatBanNotice(poisonBan, "poison")
        });
      }
      if (findAccountByName(db, name)) {
        return sendJson(res, 409, { error: "That username is already taken." });
      }

      const account = createAccount(db, name, password);
      account.lastIp = clientIp;
      createSessionForAccount(db, account.id, res);
      writeDb(db);
      ensureAccountStructure(account);
      writeAccountReadme(account);
      logEvent("ACCOUNT_SIGNED_UP", { account: account.name, accountId: account.id });

      return sendJson(res, 201, {
        message: "Account created.",
        profile: sanitizeAccount(account)
      });
    }

    if (req.method === "POST" && url.pathname === "/api/login") {
      const body = await readJsonBody(req);
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const password = typeof body.password === "string" ? body.password : "";
      const db = readDb();
      const poisonBan = getActivePoisonBan(db, clientIp);
      if (poisonBan) {
        return sendJson(res, 403, {
          error: "Device Poisoned",
          ban: formatBanNotice(poisonBan, "poison")
        });
      }
      const account = findAccountByName(db, name);

      if (!account) {
        return sendJson(res, 401, { error: "Incorrect username or password." });
      }

      if (!verifyAccountPassword(account, password)) {
        return sendJson(res, 401, { error: "Incorrect username or password." });
      }
      const ban = getActiveAccountBan(account);
      if (ban) {
        return sendJson(res, 403, {
          error: getBanTitle(ban),
          ban: formatBanNotice(ban)
        });
      }

      account.lastIp = clientIp;
      createSessionForAccount(db, account.id, res);
      writeDb(db);
      logEvent("ACCOUNT_LOGGED_IN", { account: account.name, accountId: account.id });

      return sendJson(res, 200, {
        message: "Logged in.",
        profile: sanitizeAccount(account)
      });
    }

    if (req.method === "POST" && url.pathname === "/api/logout") {
      const db = readDb();
      const account = getAuthenticatedAccount(req, db);
      destroySession(req, db);
      clearSessionCookie(res);
      writeDb(db);
      logEvent("ACCOUNT_LOGGED_OUT", {
        account: account ? account.name : "anonymous",
        accountId: account ? account.id : ""
      });
      return sendJson(res, 200, { message: "Logged out." });
    }

    if (req.method === "GET" && url.pathname === "/api/notifications") {
      const db = readDb();
      const account = getAuthenticatedAccount(req, db);
      if (!account) {
        return sendJson(res, 401, { error: "You must be logged in." });
      }

      const notifications = getNotificationsForAccount(db, account.id);
      return sendJson(res, 200, {
        notifications,
        unreadCount: notifications.filter((notification) => !notification.readAt).length
      });
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/notifications/") && url.pathname.endsWith("/read")) {
      const db = readDb();
      const account = getAuthenticatedAccount(req, db);
      if (!account) {
        return sendJson(res, 401, { error: "You must be logged in." });
      }

      const parts = url.pathname.split("/");
      const notificationId = decodeURIComponent(parts[parts.length - 2] || "");
      const notification = db.notifications.find((entry) => entry.id === notificationId && entry.accountId === account.id);
      if (!notification) {
        return sendJson(res, 404, { error: "Notification not found." });
      }

      notification.readAt = new Date().toISOString();
      writeDb(db);
      return sendJson(res, 200, { message: "Notification read.", notification });
    }

    if (req.method === "POST" && url.pathname === "/api/notifications/read-all") {
      const db = readDb();
      const account = getAuthenticatedAccount(req, db);
      if (!account) {
        return sendJson(res, 401, { error: "You must be logged in." });
      }

      const now = new Date().toISOString();
      for (const notification of db.notifications) {
        if (notification.accountId === account.id && !notification.readAt) {
          notification.readAt = now;
        }
      }
      writeDb(db);
      return sendJson(res, 200, { message: "Notifications marked read." });
    }

    if (req.method === "POST" && url.pathname === "/api/live/start") {
      const db = readDb();
      const account = getAuthenticatedAccount(req, db);
      if (!account) {
        return sendJson(res, 401, { error: "You must be logged in to go live." });
      }
      if ((account.followerIds || []).length < 10) {
        return sendJson(res, 403, { error: "You need at least 10 followers to start a livestream." });
      }
      const existing = db.liveStreams.find((stream) => stream.uploaderId === account.id && stream.active);
      if (existing) {
        return sendJson(res, 200, { message: "You are already live.", stream: enrichLiveStream(db, existing) });
      }

      const body = await readJsonBody(req);
      const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 100) : `${account.name} is live`;
      const stream = {
        id: randomUUID(),
        title,
        uploaderId: account.id,
        active: true,
        startedAt: new Date().toISOString(),
        endedAt: "",
        chat: []
      };
      const streamKey = randomUUID();
      liveFrameKeys.set(stream.id, streamKey);
      db.liveStreams.push(stream);
      writeDb(db);
      logEvent("LIVE_STARTED", { account: account.name, accountId: account.id, streamId: stream.id, title: stream.title });
      return sendJson(res, 201, { message: "Livestream started.", stream: enrichLiveStream(db, stream), streamKey });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/live/") && url.pathname.endsWith("/chat/events")) {
      const db = readDb();
      const streamId = getLiveStreamIdFromPath(url.pathname);
      const stream = db.liveStreams.find((entry) => entry.id === streamId);
      if (!stream) {
        return sendJson(res, 404, { error: "Livestream not found." });
      }
      return openSse(req, res, liveChatClients, streamId, [
        { type: "chat_init", data: { messages: enrichLiveChat(db, stream.chat || []) } }
      ]);
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/live/") && url.pathname.endsWith("/events")) {
      const db = readDb();
      const streamId = getLiveStreamIdFromPath(url.pathname);
      const stream = db.liveStreams.find((entry) => entry.id === streamId);
      if (!stream) {
        return sendJson(res, 404, { error: "Livestream not found." });
      }
      return openSse(req, res, liveFrameClients, streamId, [
        { type: "stream", data: enrichLiveStream(db, stream) },
        { type: "frame", data: { frame: liveFrames.get(streamId) || "" } }
      ]);
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/live/")) {
      const db = readDb();
      const streamId = getLiveStreamIdFromPath(url.pathname);
      const stream = db.liveStreams.find((entry) => entry.id === streamId);
      if (!stream) {
        return sendJson(res, 404, { error: "Livestream not found." });
      }
      return sendJson(res, 200, {
        stream: enrichLiveStream(db, stream),
        frame: liveFrames.get(stream.id) || "",
        chat: enrichLiveChat(db, stream.chat || [])
      });
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/live/") && url.pathname.endsWith("/frame-fast")) {
      const streamId = getLiveStreamIdFromPath(url.pathname);
      const body = await readJsonBody(req);
      if (body.streamKey !== liveFrameKeys.get(streamId)) {
        return sendJson(res, 403, { error: "Invalid livestream key." });
      }
      const frame = validateBase64File(body, ["image/jpeg", "image/webp"]);
      if (!frame.ok) return sendJson(res, 400, { error: frame.error });
      const dataUrl = `data:${frame.mimeType};base64,${body.data}`;
      liveFrames.set(streamId, dataUrl);
      broadcastSse(liveFrameClients, streamId, "frame", { frame: dataUrl, sentAt: new Date().toISOString() });
      return sendJson(res, 200, { message: "Frame sent." });
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/live/") && url.pathname.endsWith("/frame")) {
      const db = readDb();
      const account = getAuthenticatedAccount(req, db);
      const streamId = getLiveStreamIdFromPath(url.pathname);
      const stream = db.liveStreams.find((entry) => entry.id === streamId);
      if (!account) return sendJson(res, 401, { error: "You must be logged in." });
      if (!stream) return sendJson(res, 404, { error: "Livestream not found." });
      if (stream.uploaderId !== account.id) return sendJson(res, 403, { error: "Only the streamer can send frames." });
      if (!stream.active) return sendJson(res, 400, { error: "This livestream has ended." });

      const body = await readJsonBody(req);
      const frame = validateBase64File(body, ["image/jpeg", "image/png", "image/webp"]);
      if (!frame.ok) return sendJson(res, 400, { error: frame.error });
      const dataUrl = `data:${frame.mimeType};base64,${body.data}`;
      liveFrames.set(stream.id, dataUrl);
      broadcastSse(liveFrameClients, stream.id, "frame", { frame: dataUrl, sentAt: new Date().toISOString() });
      return sendJson(res, 200, { message: "Frame sent." });
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/live/") && url.pathname.endsWith("/chat")) {
      const db = readDb();
      const account = getAuthenticatedAccount(req, db);
      const streamId = getLiveStreamIdFromPath(url.pathname);
      const stream = db.liveStreams.find((entry) => entry.id === streamId);
      if (!account) return sendJson(res, 401, { error: "You must be logged in to chat." });
      if (!stream) return sendJson(res, 404, { error: "Livestream not found." });
      if (!stream.active) return sendJson(res, 400, { error: "This livestream has ended." });
      const streamer = db.accounts.find((entry) => entry.id === stream.uploaderId);
      if (stream.uploaderId !== account.id && !(streamer?.followerIds || []).includes(account.id)) {
        return sendJson(res, 403, { error: "You must follow the streamer to chat." });
      }

      const body = await readJsonBody(req);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) return sendJson(res, 400, { error: "Chat message is required." });
      if (text.length > 300) return sendJson(res, 400, { error: "Live chat messages must be 300 characters or less." });
      if (containsBlockedWord(text)) return sendJson(res, 400, { error: "That message contains blocked language." });
      const message = { id: randomUUID(), authorId: account.id, text, createdAt: new Date().toISOString() };
      if (!Array.isArray(stream.chat)) stream.chat = [];
      stream.chat.push(message);
      if (stream.chat.length > 500) stream.chat = stream.chat.slice(-500);
      writeDb(db);
      const enriched = enrichLiveChat(db, [message])[0];
      broadcastSse(liveChatClients, stream.id, "chat", enriched);
      return sendJson(res, 201, { message: "Chat sent.", chat: enriched });
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/live/") && url.pathname.endsWith("/stop")) {
      const db = readDb();
      const account = getAuthenticatedAccount(req, db);
      const streamId = getLiveStreamIdFromPath(url.pathname);
      const stream = db.liveStreams.find((entry) => entry.id === streamId);
      if (!account) return sendJson(res, 401, { error: "You must be logged in." });
      if (!stream) return sendJson(res, 404, { error: "Livestream not found." });
      if (stream.uploaderId !== account.id) return sendJson(res, 403, { error: "Only the streamer can stop this livestream." });
      stream.active = false;
      stream.endedAt = new Date().toISOString();
      writeDb(db);
      liveFrames.delete(stream.id);
      liveFrameKeys.delete(stream.id);
      broadcastSse(liveFrameClients, stream.id, "ended", enrichLiveStream(db, stream));
      broadcastSse(liveChatClients, stream.id, "ended", enrichLiveStream(db, stream));
      logEvent("LIVE_STOPPED", { account: account.name, accountId: account.id, streamId: stream.id });
      return sendJson(res, 200, { message: "Livestream stopped.", stream: enrichLiveStream(db, stream) });
    }

    if (req.method === "GET" && url.pathname === "/api/profile") {
      const db = readDb();
      const account = getAuthenticatedAccount(req, db);
      if (!account) {
        return sendJson(res, 401, { error: "You must be logged in." });
      }
      return sendJson(res, 200, sanitizeAccount(account));
    }

    if (req.method === "POST" && url.pathname === "/api/profile/password") {
      const db = readDb();
      const account = getAuthenticatedAccount(req, db);
      if (!account) {
        return sendJson(res, 401, { error: "You must be logged in." });
      }

      const body = await readJsonBody(req);
      const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
      const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

      if (newPassword.length < 4) {
        return sendJson(res, 400, { error: "New password must be at least 4 characters." });
      }

      if (account.passwordHash && !verifyAccountPassword(account, currentPassword)) {
        return sendJson(res, 401, { error: "Current password is incorrect." });
      }

      setAccountPassword(account, newPassword);
      writeDb(db);
      logEvent("ACCOUNT_PASSWORD_UPDATED", { account: account.name, accountId: account.id });
      return sendJson(res, 200, { message: "Password updated." });
    }

    if (req.method === "PUT" && url.pathname === "/api/profile") {
      const body = await readJsonBody(req);
      const db = readDb();
      const account = getAuthenticatedAccount(req, db);
      if (!account) {
        return sendJson(res, 401, { error: "You must be logged in." });
      }

      const nextName = typeof body.name === "string" ? body.name.trim() : "";
      if (!nextName) {
        return sendJson(res, 400, { error: "Name is required." });
      }

      const existing = findAccountByName(db, nextName);
      if (existing && existing.id !== account.id) {
        return sendJson(res, 409, { error: "That username is already taken." });
      }

      const previousFolderPath = getAccountDir(account);
      account.name = nextName.slice(0, 40);
      account.folderName = allocateUniqueAccountFolder(db, account.name, account.id);
      const nextFolderPath = getAccountDir(account);

      if (path.normalize(previousFolderPath) !== path.normalize(nextFolderPath) && fs.existsSync(previousFolderPath)) {
        safeMove(previousFolderPath, nextFolderPath);
      }

      ensureDir(nextFolderPath);
      ensureDir(getAccountVideosDir(account));
      refreshAccountPaths(account, db.videos);
      syncAccountFiles(account, db.videos);
      writeAccountReadme(account);
      writeDb(db);
      logEvent("PROFILE_NAME_UPDATED", { account: account.name, accountId: account.id });

      return sendJson(res, 200, sanitizeAccount(account));
    }

    if (req.method === "POST" && url.pathname === "/api/profile-picture") {
      const body = await readJsonBody(req);
      const upload = validateBase64File(body, ["image/jpeg", "image/png", "image/webp"]);

      if (!upload.ok) {
        return sendJson(res, 400, { error: upload.error });
      }

      const db = readDb();
      const account = getAuthenticatedAccount(req, db);
      if (!account) {
        return sendJson(res, 401, { error: "You must be logged in." });
      }

      ensureAccountStructure(account);
      removeExistingProfilePictures(account);

      const extension = mimeToExtension(upload.mimeType);
      const filePath = path.join(getAccountDir(account), `pfp${extension}`);
      fs.writeFileSync(filePath, upload.buffer);
      account.picturePath = toPublicPath(filePath);
      writeAccountReadme(account);

      writeDb(db);
      logEvent("PROFILE_PICTURE_UPDATED", {
        account: account.name,
        accountId: account.id,
        picturePath: account.picturePath
      });
      return sendJson(res, 201, sanitizeAccount(account));
    }

    if (req.method === "GET" && url.pathname === "/api/admin") {
      const db = readDb();
      const admin = requireAdmin(req, res, db);
      if (!admin) return;

      const accounts = db.accounts
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((account) => sanitizeAdminAccount(account));
      const videos = enrichVideos(db, db.videos)
        .slice()
        .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));

      return sendJson(res, 200, {
        admin: sanitizeAccount(admin),
        accounts,
        videos,
        poisonBans: Array.isArray(db.poisonBans) ? db.poisonBans : []
      });
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/admin/videos/")) {
      const db = readDb();
      const admin = requireAdmin(req, res, db);
      if (!admin) return;

      const videoId = decodeURIComponent(url.pathname.split("/").pop() || "");
      const videoIndex = db.videos.findIndex((video) => video.id === videoId);
      if (videoIndex === -1) {
        return sendJson(res, 404, { error: "Video not found." });
      }

      const video = db.videos[videoIndex];
      const account = db.accounts.find((entry) => entry.id === video.uploaderId) || db.accounts[0];
      safeRemoveDir(getVideoDir(account, video));
      db.videos.splice(videoIndex, 1);
      writeDb(db);
      logEvent("ADMIN_VIDEO_DELETED", {
        admin: admin.name,
        adminId: admin.id,
        title: video.title,
        videoId: video.id
      });

      return sendJson(res, 200, { message: "Video deleted by admin." });
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/admin/users/") && url.pathname.endsWith("/ban")) {
      const db = readDb();
      const admin = requireAdmin(req, res, db);
      if (!admin) return;

      const body = await readJsonBody(req);
      const parts = url.pathname.split("/");
      const accountId = decodeURIComponent(parts[parts.length - 2] || "");
      const account = db.accounts.find((entry) => entry.id === accountId);
      if (!account) {
        return sendJson(res, 404, { error: "User not found." });
      }
      if (account.id === admin.id || isOfficialAdmin(account)) {
        return sendJson(res, 400, { error: "You cannot ban the official Vido account." });
      }

      const ban = buildBan(body, admin.id);
      account.ban = ban;
      db.sessions = db.sessions.filter((session) => session.accountId !== account.id);

      if (body.type === "poison") {
        const ip = typeof account.lastIp === "string" && account.lastIp ? account.lastIp : "";
        if (!ip) {
          return sendJson(res, 400, { error: "That user does not have a saved IP address yet." });
        }
        addPoisonBan(db, ip, ban.reason, admin.id, account.id);
      }

      writeAccountReadme(account);
      writeDb(db);
      logEvent("ADMIN_USER_BANNED", {
        admin: admin.name,
        adminId: admin.id,
        target: account.name,
        targetId: account.id,
        type: ban.type,
        reason: ban.reason
      });

      return sendJson(res, 200, {
        message: `${account.name} was banned.`,
        account: sanitizeAdminAccount(account)
      });
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/admin/users/") && url.pathname.endsWith("/unban")) {
      const db = readDb();
      const admin = requireAdmin(req, res, db);
      if (!admin) return;

      const parts = url.pathname.split("/");
      const accountId = decodeURIComponent(parts[parts.length - 2] || "");
      const account = db.accounts.find((entry) => entry.id === accountId);
      if (!account) {
        return sendJson(res, 404, { error: "User not found." });
      }

      account.ban = null;
      writeAccountReadme(account);
      writeDb(db);
      logEvent("ADMIN_USER_UNBANNED", {
        admin: admin.name,
        adminId: admin.id,
        target: account.name,
        targetId: account.id
      });

      return sendJson(res, 200, {
        message: `${account.name} was unbanned.`,
        account: sanitizeAdminAccount(account)
      });
    }

    if (req.method === "POST" && url.pathname === "/api/profile/banner") {
      const body = await readJsonBody(req);
      const upload = validateBase64File(body, ["image/jpeg", "image/png", "image/webp"]);

      if (!upload.ok) {
        return sendJson(res, 400, { error: upload.error });
      }

      const db = readDb();
      const account = getAuthenticatedAccount(req, db);
      if (!account) {
        return sendJson(res, 401, { error: "You must be logged in." });
      }

      ensureAccountStructure(account);
      removeExistingBanners(account);

      const extension = mimeToExtension(upload.mimeType);
      const filePath = path.join(getAccountDir(account), `banner${extension}`);
      fs.writeFileSync(filePath, upload.buffer);
      account.bannerPath = toPublicPath(filePath);
      writeAccountReadme(account);

      writeDb(db);
      logEvent("PROFILE_BANNER_UPDATED", {
        account: account.name,
        accountId: account.id,
        bannerPath: account.bannerPath
      });
      return sendJson(res, 201, sanitizeAccount(account));
    }

    if (req.method === "GET" && url.pathname === "/api/communities") {
      const db = readDb();
      const account = getAuthenticatedAccount(req, db);
      if (!account) {
        return sendJson(res, 401, { error: "You must be logged in to use communities." });
      }

      const communities = db.communities.map((community) => enrichCommunity(db, community, account));
      return sendJson(res, 200, {
        mine: communities.filter((community) => community.isMember),
        public: communities.filter((community) => community.isPublic && !community.isMember)
      });
    }

    if (req.method === "POST" && url.pathname === "/api/communities") {
      const db = readDb();
      const account = getAuthenticatedAccount(req, db);
      if (!account) {
        return sendJson(res, 401, { error: "You must be logged in to create a community." });
      }
      if ((account.followerIds || []).length < 10) {
        return sendJson(res, 403, { error: "You need at least 10 followers to create a community." });
      }

      const body = await readJsonBody(req);
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
      const description = typeof body.description === "string" ? body.description.trim().slice(0, 500) : "";
      if (!name) {
        return sendJson(res, 400, { error: "Community name is required." });
      }

      const community = {
        id: randomUUID(),
        name,
        description,
        folderName: allocateUniqueCommunityFolder(db, name),
        ownerId: account.id,
        adminIds: [],
        memberIds: [account.id],
        invitedIds: [],
        maxMembers: clampNumber(body.maxMembers, 2, 100, 25),
        isPublic: Boolean(body.isPublic),
        picturePath: "",
        bannerPath: "",
        boards: [],
        createdAt: new Date().toISOString()
      };
      ensureCommunityStructure(community);

      if (body.picture && typeof body.picture === "object") {
        const picture = validateBase64File(body.picture, ["image/jpeg", "image/png", "image/webp"]);
        if (!picture.ok) return sendJson(res, 400, { error: picture.error });
        const picturePath = path.join(getCommunityDir(community), `pfp${mimeToExtension(picture.mimeType)}`);
        fs.writeFileSync(picturePath, picture.buffer);
        community.picturePath = toPublicPath(picturePath);
      }
      if (body.banner && typeof body.banner === "object") {
        const banner = validateBase64File(body.banner, ["image/jpeg", "image/png", "image/webp"]);
        if (!banner.ok) return sendJson(res, 400, { error: banner.error });
        const bannerPath = path.join(getCommunityDir(community), `banner${mimeToExtension(banner.mimeType)}`);
        fs.writeFileSync(bannerPath, banner.buffer);
        community.bannerPath = toPublicPath(bannerPath);
      }

      db.communities.push(community);
      writeDb(db);
      logEvent("COMMUNITY_CREATED", { account: account.name, accountId: account.id, community: community.name, communityId: community.id });
      return sendJson(res, 201, { message: "Community created.", community: enrichCommunity(db, community, account) });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/communities/")) {
      const db = readDb();
      const account = getAuthenticatedAccount(req, db);
      if (!account) {
        return sendJson(res, 401, { error: "You must be logged in to view communities." });
      }
      const community = findCommunityFromPath(db, url.pathname);
      if (!community) {
        return sendJson(res, 404, { error: "Community not found." });
      }
      if (!canViewCommunity(community, account)) {
        return sendJson(res, 403, { error: "You need an invite to view this community." });
      }
      return sendJson(res, 200, { community: enrichCommunity(db, community, account, true) });
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/communities/") && url.pathname.endsWith("/join")) {
      const db = readDb();
      const account = getAuthenticatedAccount(req, db);
      if (!account) {
        return sendJson(res, 401, { error: "You must be logged in to join communities." });
      }
      const community = findCommunityFromPath(db, url.pathname);
      if (!community) {
        return sendJson(res, 404, { error: "Community not found." });
      }
      if (!community.isPublic && !community.invitedIds.includes(account.id) && !community.memberIds.includes(account.id)) {
        return sendJson(res, 403, { error: "You need an invite to join this community." });
      }
      if (!community.memberIds.includes(account.id) && community.memberIds.length >= community.maxMembers) {
        return sendJson(res, 403, { error: "This community is full." });
      }
      if (!community.memberIds.includes(account.id)) {
        community.memberIds.push(account.id);
      }
      community.invitedIds = community.invitedIds.filter((id) => id !== account.id);
      writeDb(db);
      return sendJson(res, 200, { message: "Joined community.", community: enrichCommunity(db, community, account, true) });
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/communities/") && url.pathname.endsWith("/invite")) {
      const db = readDb();
      const account = getAuthenticatedAccount(req, db);
      if (!account) {
        return sendJson(res, 401, { error: "You must be logged in." });
      }
      const community = findCommunityFromPath(db, url.pathname);
      if (!community) return sendJson(res, 404, { error: "Community not found." });
      if (!canModerateCommunity(community, account.id)) return sendJson(res, 403, { error: "Only owners and admins can invite users." });

      const body = await readJsonBody(req);
      const invitee = findAccountByName(db, body.username || "");
      if (!invitee) return sendJson(res, 404, { error: "User not found." });
      if (!community.invitedIds.includes(invitee.id) && !community.memberIds.includes(invitee.id)) {
        community.invitedIds.push(invitee.id);
      }
      addNotification(db, invitee.id, `${account.name} has invited you to join ${community.name}!`, `/communities/${community.id}?acceptInvite=1`, "community_invite");
      writeDb(db);
      return sendJson(res, 200, { message: "Invite sent." });
    }

    if (req.method === "PUT" && url.pathname.startsWith("/api/communities/") && url.pathname.endsWith("/settings")) {
      const db = readDb();
      const account = getAuthenticatedAccount(req, db);
      const community = findCommunityFromPath(db, url.pathname);
      if (!account) return sendJson(res, 401, { error: "You must be logged in." });
      if (!community) return sendJson(res, 404, { error: "Community not found." });
      if (community.ownerId !== account.id) return sendJson(res, 403, { error: "Only the owner can change community settings." });
      const body = await readJsonBody(req);
      community.maxMembers = clampNumber(body.maxMembers, 2, 100, community.maxMembers);
      community.isPublic = Boolean(body.isPublic);
      writeDb(db);
      return sendJson(res, 200, { message: "Community settings saved.", community: enrichCommunity(db, community, account, true) });
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/communities/") && url.pathname.endsWith("/boards")) {
      const db = readDb();
      const account = getAuthenticatedAccount(req, db);
      const community = findCommunityFromPath(db, url.pathname);
      if (!account) return sendJson(res, 401, { error: "You must be logged in." });
      if (!community) return sendJson(res, 404, { error: "Community not found." });
      if (!community.memberIds.includes(account.id)) return sendJson(res, 403, { error: "Join this community to make a message board." });
      if (community.boards.length >= 100) return sendJson(res, 403, { error: "This community already has 100 message boards." });
      const body = await readJsonBody(req);
      const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 80) : `${account.name}'s Message Board`;
      community.boards.push({ id: randomUUID(), title, ownerId: account.id, createdAt: new Date().toISOString(), messages: [] });
      writeDb(db);
      return sendJson(res, 201, { message: "Message board created.", community: enrichCommunity(db, community, account, true) });
    }

    if (req.method === "DELETE" && url.pathname.includes("/boards/")) {
      const db = readDb();
      const account = getAuthenticatedAccount(req, db);
      const { community, boardId } = findCommunityBoardFromPath(db, url.pathname);
      if (!account) return sendJson(res, 401, { error: "You must be logged in." });
      if (!community) return sendJson(res, 404, { error: "Community not found." });
      if (!canModerateCommunity(community, account.id)) return sendJson(res, 403, { error: "Only owners and admins can remove message boards." });
      community.boards = community.boards.filter((board) => board.id !== boardId);
      writeDb(db);
      return sendJson(res, 200, { message: "Message board removed." });
    }

    if (req.method === "POST" && url.pathname.includes("/boards/") && url.pathname.endsWith("/messages")) {
      const db = readDb();
      const account = getAuthenticatedAccount(req, db);
      const { community, board } = findCommunityBoardFromPath(db, url.pathname);
      if (!account) return sendJson(res, 401, { error: "You must be logged in." });
      if (!community || !board) return sendJson(res, 404, { error: "Message board not found." });
      if (!community.memberIds.includes(account.id)) return sendJson(res, 403, { error: "Join this community to post." });
      const body = await readJsonBody(req);
      const text = typeof body.text === "string" ? body.text.trim().slice(0, 1000) : "";
      if (!text && !body.attachment) return sendJson(res, 400, { error: "Write a message or add a file." });

      const message = {
        id: randomUUID(),
        authorId: account.id,
        text,
        linkedAccountId: body.linkedAccountId || "",
        linkedVideoId: body.linkedVideoId || "",
        attachmentPath: "",
        attachmentType: "",
        createdAt: new Date().toISOString()
      };

      if (body.attachment && typeof body.attachment === "object") {
        const upload = validateBase64File(body.attachment, ["image/jpeg", "image/png", "image/webp", "video/mp4"]);
        if (!upload.ok) return sendJson(res, 400, { error: upload.error });
        const boardDir = path.join(getCommunityDir(community), "boards", board.id);
        ensureDir(boardDir);
        const filePath = path.join(boardDir, `${message.id}${mimeToExtension(upload.mimeType)}`);
        fs.writeFileSync(filePath, upload.buffer);
        message.attachmentPath = toPublicPath(filePath);
        message.attachmentType = upload.mimeType;
      }

      board.messages.push(message);
      writeDb(db);
      return sendJson(res, 201, { message: "Message posted.", community: enrichCommunity(db, community, account, true) });
    }

    if (req.method === "DELETE" && url.pathname.includes("/members/")) {
      const db = readDb();
      const account = getAuthenticatedAccount(req, db);
      const { community, memberId } = findCommunityMemberFromPath(db, url.pathname);
      if (!account) return sendJson(res, 401, { error: "You must be logged in." });
      if (!community) return sendJson(res, 404, { error: "Community not found." });
      if (!canModerateCommunity(community, account.id)) return sendJson(res, 403, { error: "Only owners and admins can remove members." });
      if (memberId === community.ownerId) return sendJson(res, 400, { error: "You cannot remove the owner." });
      community.memberIds = community.memberIds.filter((id) => id !== memberId);
      community.adminIds = community.adminIds.filter((id) => id !== memberId);
      writeDb(db);
      return sendJson(res, 200, { message: "Member removed." });
    }

    if (req.method === "POST" && url.pathname.includes("/admins/")) {
      const db = readDb();
      const account = getAuthenticatedAccount(req, db);
      const { community, memberId } = findCommunityAdminFromPath(db, url.pathname);
      if (!account) return sendJson(res, 401, { error: "You must be logged in." });
      if (!community) return sendJson(res, 404, { error: "Community not found." });
      if (community.ownerId !== account.id) return sendJson(res, 403, { error: "Only the owner can add admins." });
      if (!community.memberIds.includes(memberId)) return sendJson(res, 400, { error: "That user is not in the community." });
      if (!community.adminIds.includes(memberId)) community.adminIds.push(memberId);
      writeDb(db);
      return sendJson(res, 200, { message: "Admin added." });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/profiles/")) {
      const db = readDb();
      const viewer = getAuthenticatedAccount(req, db);
      const profileId = decodeURIComponent(url.pathname.split("/").pop() || "");
      const account = db.accounts.find((entry) => entry.id === profileId);

      if (!account) {
        return sendJson(res, 404, { error: "Profile not found." });
      }

      const videos = enrichVideos(db, db.videos)
        .filter((video) => video.uploaderId === account.id)
        .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));

      return sendJson(res, 200, {
        profile: sanitizeAccount(account, viewer),
        videos
      });
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/profiles/") && url.pathname.endsWith("/follow")) {
      const db = readDb();
      const viewer = getAuthenticatedAccount(req, db);
      if (!viewer) {
        return sendJson(res, 401, { error: "You must be logged in to follow someone." });
      }

      const parts = url.pathname.split("/");
      const profileId = decodeURIComponent(parts[parts.length - 2] || "");
      const account = db.accounts.find((entry) => entry.id === profileId);

      if (!account) {
        return sendJson(res, 404, { error: "Profile not found." });
      }
      if (account.id === viewer.id) {
        return sendJson(res, 400, { error: "You cannot follow yourself." });
      }
      if (!Array.isArray(account.followerIds)) {
        account.followerIds = [];
      }
      if (!account.followerIds.includes(viewer.id)) {
        account.followerIds.push(viewer.id);
      }
      addNotification(db, account.id, `${viewer.name} followed you.`, `/users/${viewer.id}`, "follow");

      writeAccountReadme(account);
      writeDb(db);
      logEvent("ACCOUNT_FOLLOWED", {
        account: viewer.name,
        accountId: viewer.id,
        target: account.name,
        targetId: account.id
      });

      return sendJson(res, 200, {
        message: `You are now following ${account.name}.`,
        profile: sanitizeAccount(account, viewer)
      });
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/profiles/") && url.pathname.endsWith("/follow")) {
      const db = readDb();
      const viewer = getAuthenticatedAccount(req, db);
      if (!viewer) {
        return sendJson(res, 401, { error: "You must be logged in to unfollow someone." });
      }

      const parts = url.pathname.split("/");
      const profileId = decodeURIComponent(parts[parts.length - 2] || "");
      const account = db.accounts.find((entry) => entry.id === profileId);

      if (!account) {
        return sendJson(res, 404, { error: "Profile not found." });
      }
      if (account.id === viewer.id) {
        return sendJson(res, 400, { error: "You cannot unfollow yourself." });
      }

      account.followerIds = (account.followerIds || []).filter((id) => id !== viewer.id);
      writeAccountReadme(account);
      writeDb(db);
      logEvent("ACCOUNT_UNFOLLOWED", {
        account: viewer.name,
        accountId: viewer.id,
        target: account.name,
        targetId: account.id
      });

      return sendJson(res, 200, {
        message: `You unfollowed ${account.name}.`,
        profile: sanitizeAccount(account, viewer)
      });
    }

    if (req.method === "GET" && url.pathname === "/api/videos") {
      const db = readDb();
      const query = (url.searchParams.get("q") || "").trim().toLowerCase();
      const videos = enrichVideos(db, db.videos)
        .filter((video) => video.kind !== "mini")
        .slice()
        .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
      const liveStreams = enrichLiveStreams(db, db.liveStreams.filter((stream) => stream.active))
        .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));

      if (query) {
        const filteredVideos = videos.filter((video) => {
          return (
            video.title.toLowerCase().includes(query) ||
            video.originalName.toLowerCase().includes(query) ||
            video.uploaderName.toLowerCase().includes(query)
          );
        });
        const filteredLive = liveStreams.filter((stream) => {
          return stream.title.toLowerCase().includes(query) || stream.uploaderName.toLowerCase().includes(query);
        });
        const filtered = [...filteredLive, ...filteredVideos];

        return sendJson(res, 200, {
          query,
          videos: filtered,
          total: filtered.length
        });
      }

      const homeVideos = videos.filter((video) => video.showOnHome);
      const homeFeed = [...liveStreams, ...homeVideos];
      return sendJson(res, 200, {
        query: "",
        videos: homeFeed,
        total: homeFeed.length
      });
    }

    if (req.method === "GET" && url.pathname === "/api/minis") {
      const db = readDb();
      const query = (url.searchParams.get("q") || "").trim().toLowerCase();
      const minis = enrichVideos(db, db.videos)
        .filter((video) => video.kind === "mini")
        .slice()
        .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
      const filtered = query
        ? minis.filter((mini) => {
            return (
              mini.title.toLowerCase().includes(query) ||
              mini.originalName.toLowerCase().includes(query) ||
              mini.uploaderName.toLowerCase().includes(query)
            );
          })
        : minis;
      return sendJson(res, 200, {
        query,
        minis: filtered,
        total: filtered.length
      });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/videos/") && !url.pathname.endsWith("/comments")) {
      const db = readDb();
      const videoId = decodeURIComponent(url.pathname.split("/").pop() || "");
      const video = db.videos.find((entry) => entry.id === videoId);

      if (!video) {
        return sendJson(res, 404, { error: "Video not found." });
      }

      return sendJson(res, 200, {
        video: enrichVideo(db, video)
      });
    }

    if (req.method === "POST" && url.pathname === "/api/videos") {
      const body = await readJsonBody(req);
      const title = typeof body.title === "string" ? body.title.trim() : "";
      const description = typeof body.description === "string" ? body.description.trim() : "";
      const kind = body.kind === "mini" ? "mini" : "video";
      const durationSeconds = Number.isFinite(Number(body.durationSeconds)) ? Number(body.durationSeconds) : 0;
      const upload = validateBase64File(body, ["video/mp4"]);

      if (!title) {
        return sendJson(res, 400, { error: "Title is required." });
      }

      if (!upload.ok) {
        return sendJson(res, 400, { error: upload.error });
      }
      if (kind === "mini" && (!durationSeconds || durationSeconds > 60)) {
        return sendJson(res, 400, { error: "Vido Minis must be 60 seconds or less." });
      }

      const db = readDb();
      const account = getAuthenticatedAccount(req, db);
      if (!account) {
        return sendJson(res, 401, { error: "You must be logged in." });
      }

      ensureAccountStructure(account);
      const originalName = sanitizeFileName(body.fileName || `${title}.mp4`, ".mp4");
      const video = {
        id: randomUUID(),
        title: title.slice(0, 100),
        description: description.slice(0, 1000),
        originalName,
        uploadedAt: new Date().toISOString(),
        showOnHome: true,
        uploaderId: account.id,
        folderName: allocateUniqueVideoFolder(db, account.id, title),
        views: 0,
        kind,
        durationSeconds
      };

      const videoDir = getVideoDir(account, video);
      const filePath = path.join(videoDir, originalName);
      ensureDir(videoDir);
      fs.writeFileSync(filePath, upload.buffer);

      video.url = toPublicPath(filePath);
      video.detailsPath = toPublicPath(path.join(videoDir, "details.txt"));

      if (body.thumbnail && typeof body.thumbnail === "object") {
        const thumbnail = validateBase64File(body.thumbnail, ["image/jpeg", "image/png", "image/webp"]);
        if (!thumbnail.ok) {
          return sendJson(res, 400, { error: thumbnail.error });
        }

        const thumbnailPath = path.join(videoDir, `thumbnail${mimeToExtension(thumbnail.mimeType)}`);
        fs.writeFileSync(thumbnailPath, thumbnail.buffer);
        video.thumbnailPath = toPublicPath(thumbnailPath);
      }

      if (kind === "mini") {
        video.showOnHome = false;
      } else {
        updateHomeSlots(db, video);
      }
      writeVideoDetails(account, video);

      db.videos.push(video);
      writeDb(db);
      logEvent("VIDEO_UPLOADED", {
        account: account.name,
        accountId: account.id,
        title: video.title,
        videoId: video.id
      });

      return sendJson(res, 201, {
        video: enrichVideo(db, video),
        message: kind === "mini"
          ? "Mini uploaded."
          : video.showOnHome
          ? "Video uploaded and added to the home page."
          : "Video uploaded. It is searchable, but hidden from the home page because the first 100 slots are full."
      });
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/videos/")) {
      const db = readDb();
      const currentAccount = getAuthenticatedAccount(req, db);
      if (!currentAccount) {
        return sendJson(res, 401, { error: "You must be logged in." });
      }

      const videoId = decodeURIComponent(url.pathname.split("/").pop() || "");
      const videoIndex = db.videos.findIndex((video) => video.id === videoId);

      if (videoIndex === -1) {
        return sendJson(res, 404, { error: "Video not found." });
      }

      const video = db.videos[videoIndex];
      if (video.uploaderId !== currentAccount.id) {
        return sendJson(res, 403, { error: "You can only delete your own videos." });
      }

      safeRemoveDir(getVideoDir(currentAccount, video));
      db.videos.splice(videoIndex, 1);
      writeDb(db);
      logEvent("VIDEO_DELETED", {
        account: currentAccount.name,
        accountId: currentAccount.id,
        title: video.title,
        videoId: video.id
      });

      return sendJson(res, 200, { message: "Video deleted." });
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/videos/") && url.pathname.endsWith("/view")) {
      const db = readDb();
      const parts = url.pathname.split("/");
      const videoId = decodeURIComponent(parts[parts.length - 2] || "");
      const video = db.videos.find((entry) => entry.id === videoId);

      if (!video) {
        return sendJson(res, 404, { error: "Video not found." });
      }

      const account = db.accounts.find((entry) => entry.id === video.uploaderId) || db.accounts[0];
      video.views = Number(video.views || 0) + 1;
      writeVideoDetails(account, video);
      writeDb(db);
      logEvent("VIDEO_VIEWED", {
        account: account.name,
        accountId: account.id,
        title: video.title,
        videoId: video.id,
        views: video.views
      });

      return sendJson(res, 200, {
        message: "View recorded.",
        video: enrichVideo(db, video)
      });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/videos/") && url.pathname.endsWith("/comments")) {
      const db = readDb();
      const parts = url.pathname.split("/");
      const videoId = decodeURIComponent(parts[parts.length - 2] || "");
      const video = db.videos.find((entry) => entry.id === videoId);

      if (!video) {
        return sendJson(res, 404, { error: "Video not found." });
      }

      return sendJson(res, 200, {
        comments: enrichComments(db, video.comments || [])
      });
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/videos/") && url.pathname.endsWith("/comments")) {
      const db = readDb();
      const author = getAuthenticatedAccount(req, db);
      if (!author) {
        return sendJson(res, 401, { error: "You must be logged in to post a comment." });
      }

      const parts = url.pathname.split("/");
      const videoId = decodeURIComponent(parts[parts.length - 2] || "");
      const video = db.videos.find((entry) => entry.id === videoId);

      if (!video) {
        return sendJson(res, 404, { error: "Video not found." });
      }

      const body = await readJsonBody(req);
      const text = typeof body.text === "string" ? body.text.trim() : "";

      if (!text) {
        return sendJson(res, 400, { error: "Comment text is required." });
      }
      if (text.length > 500) {
        return sendJson(res, 400, { error: "Comments must be 500 characters or less." });
      }
      if (containsBlockedWord(text)) {
        return sendJson(res, 400, { error: "That comment contains blocked language." });
      }

      if (!Array.isArray(video.comments)) {
        video.comments = [];
      }

      const comment = {
        id: randomUUID(),
        authorId: author.id,
        text,
        createdAt: new Date().toISOString()
      };

      video.comments.push(comment);
      if (video.uploaderId !== author.id) {
        addNotification(db, video.uploaderId, `${author.name} commented on your video "${video.title}".`, `/view/${video.id}`, "comment");
      }
      writeDb(db);
      logEvent("VIDEO_COMMENT_POSTED", {
        account: author.name,
        accountId: author.id,
        videoId: video.id,
        commentId: comment.id
      });

      return sendJson(res, 201, {
        message: "Comment posted.",
        comment: enrichComment(db, comment)
      });
    }

    if ((req.method === "GET" || req.method === "HEAD") && url.pathname.startsWith("/data/")) {
      return serveFile(path.join(ROOT, stripLeadingSlash(decodePathname(url.pathname))), req, res);
    }

    if (req.method === "GET" || req.method === "HEAD") {
      const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
      if (!path.extname(requestedPath)) {
        return serveFile(path.join(PUBLIC_DIR, "index.html"), req, res);
      }
      return serveFile(path.join(PUBLIC_DIR, stripLeadingSlash(decodePathname(requestedPath))), req, res);
    }

    sendJson(res, 404, { error: "Not found." });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "Internal server error." });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  const ip = getLocalIp();

  logEvent("SERVER_STARTED", {
    port: PORT,
    pid: process.pid,
    ip
  });

  console.log(`Vido is running locally: http://localhost:${PORT}`);
  console.log(`Vido on Wi-Fi: http://${ip}:${PORT}`);
});

function getLocalIp() {
  const nets = os.networkInterfaces();

  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }

  return "localhost";
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", removePidFile);

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function ensureDb() {
  if (!fs.existsSync(DB_PATH)) {
    const accountId = randomUUID();
    const initialDb = {
      currentAccountId: accountId,
      accounts: [
        {
          id: accountId,
          name: "Vido Creator",
          folderName: "vido-creator",
          picturePath: "",
          bannerPath: "",
          passwordHash: "",
          passwordSalt: "",
          followerIds: []
        }
      ],
      sessions: [],
      videos: []
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(initialDb, null, 2));
  }
}

function migrateDb() {
  const db = readDb();

  if (!Array.isArray(db.accounts)) {
    const accountId = randomUUID();
    db.currentAccountId = accountId;
    db.accounts = [
      {
        id: accountId,
        name: db.profile?.name || "Vido Creator",
        folderName: sanitizeSegment(db.profile?.name || "Vido Creator", "vido-creator"),
        picturePath: db.profile?.picturePath || "",
        bannerPath: "",
        passwordHash: "",
        passwordSalt: "",
        followerIds: []
      }
    ];
    delete db.profile;
  }

  if (!Array.isArray(db.sessions)) {
    db.sessions = [];
  }
  if (!Array.isArray(db.poisonBans)) {
    db.poisonBans = [];
  }
  if (!Array.isArray(db.notifications)) {
    db.notifications = [];
  }
  if (!Array.isArray(db.communities)) {
    db.communities = [];
  }
  if (!Array.isArray(db.liveStreams)) {
    db.liveStreams = [];
  }

  if (!db.currentAccountId && db.accounts[0]) {
    db.currentAccountId = db.accounts[0].id;
  }

  for (const account of db.accounts) {
    if (!account.id) {
      account.id = randomUUID();
    }
    if (typeof account.name !== "string" || !account.name.trim()) {
      account.name = "Vido Creator";
    }
    if (typeof account.folderName !== "string" || !account.folderName.trim()) {
      account.folderName = allocateUniqueAccountFolder(db, account.name, account.id);
    }
    if (typeof account.picturePath !== "string") {
      account.picturePath = "";
    }
    if (typeof account.bannerPath !== "string") {
      account.bannerPath = "";
    }
    if (typeof account.passwordHash !== "string") {
      account.passwordHash = "";
    }
    if (typeof account.passwordSalt !== "string") {
      account.passwordSalt = "";
    }
    if (!Array.isArray(account.followerIds)) {
      account.followerIds = [];
    }
    if (!account.ban || typeof account.ban !== "object") {
      account.ban = null;
    }
    if (typeof account.lastIp !== "string") {
      account.lastIp = "";
    }

    ensureAccountStructure(account);
    migrateProfilePicture(account);
    migrateBanner(account);
    writeAccountReadme(account);
  }

  for (const video of db.videos) {
    if (!video.id) {
      video.id = randomUUID();
    }
    if (!video.uploaderId) {
      video.uploaderId = db.currentAccountId;
    }
    if (!video.originalName) {
      video.originalName = `${video.title || "video"}.mp4`;
    }
    video.originalName = sanitizeFileName(video.originalName, ".mp4");
    if (typeof video.description !== "string") {
      video.description = "";
    }
    if (typeof video.thumbnailPath !== "string") {
      video.thumbnailPath = "";
    }
    if (video.kind !== "mini") {
      video.kind = "video";
    }
    video.durationSeconds = Number.isFinite(Number(video.durationSeconds)) ? Number(video.durationSeconds) : 0;
    video.views = Number.isFinite(Number(video.views)) ? Number(video.views) : 0;
    if (!Array.isArray(video.comments)) {
      video.comments = [];
    }
  }

  for (const video of db.videos) {
    const account = db.accounts.find((entry) => entry.id === video.uploaderId) || db.accounts[0];
    if (!video.folderName || !video.folderName.trim()) {
      video.folderName = allocateUniqueVideoFolder(db, account.id, video.title || video.originalName, video.id);
    }
    migrateVideoStorage(account, video);
    syncVideoFromDetails(account, video);
    writeVideoDetails(account, video);
  }

  for (const community of db.communities) {
    migrateCommunity(community);
  }

  for (const stream of db.liveStreams) {
    migrateLiveStream(stream);
    stream.active = false;
  }

  writeDb(db);
}

function readDb() {
  return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
}

function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function sanitizeAccount(account, viewer = null) {
  const followerIds = Array.isArray(account.followerIds) ? account.followerIds : [];
  return {
    id: account.id,
    name: account.name,
    picturePath: account.picturePath,
    bannerPath: account.bannerPath,
    folderName: account.folderName,
    followerCount: followerIds.length,
    isFollowedByViewer: Boolean(viewer && followerIds.includes(viewer.id)),
    canFollow: Boolean(viewer && viewer.id !== account.id),
    isAdmin: isOfficialAdmin(account)
  };
}

function sanitizeAdminAccount(account) {
  return {
    ...sanitizeAccount(account),
    ban: account.ban || null,
    lastIp: account.lastIp || "",
    isBanned: Boolean(getActiveAccountBan(account))
  };
}

function findAccountByName(db, name) {
  const normalized = String(name || "").trim().toLowerCase();
  return db.accounts.find((account) => account.name.toLowerCase() === normalized) || null;
}

function createAccount(db, name, password) {
  const account = {
    id: randomUUID(),
    name: name.slice(0, 40),
    folderName: allocateUniqueAccountFolder(db, name, ""),
    picturePath: "",
    bannerPath: "",
    passwordHash: "",
    passwordSalt: "",
    followerIds: [],
    ban: null,
    lastIp: ""
  };
  setAccountPassword(account, password);
  db.accounts.push(account);
  return account;
}

function setAccountPassword(account, password) {
  const salt = randomUUID();
  account.passwordSalt = salt;
  account.passwordHash = scryptSync(password, salt, 64).toString("hex");
}

function verifyAccountPassword(account, password) {
  if (!account.passwordHash || !account.passwordSalt) {
    return password === "";
  }

  const expected = Buffer.from(account.passwordHash, "hex");
  const actual = scryptSync(password, account.passwordSalt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function isOfficialAdmin(account) {
  return String(account?.name || "").trim().toLowerCase() === "vido";
}

function requireAdmin(req, res, db) {
  const account = getAuthenticatedAccount(req, db);
  if (!account) {
    sendJson(res, 401, { error: "You must be logged in as Vido." });
    return null;
  }
  if (!isOfficialAdmin(account)) {
    sendJson(res, 403, { error: "Only the official Vido account can use the admin panel." });
    return null;
  }
  return account;
}

function buildBan(body, adminId) {
  const type = body.type === "permanent" || body.type === "poison" ? body.type : "temporary";
  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 500) : "No reason given.";
  const ban = {
    type,
    reason,
    createdAt: new Date().toISOString(),
    bannedBy: adminId,
    endsAt: ""
  };

  if (type === "temporary") {
    const minutes = Math.max(1, Math.min(525600, Number(body.minutes || 60)));
    ban.endsAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();
  }

  return ban;
}

function getActiveAccountBan(account) {
  const ban = account?.ban;
  if (!ban || typeof ban !== "object") {
    return null;
  }
  if (ban.type === "temporary" && ban.endsAt && new Date(ban.endsAt).getTime() <= Date.now()) {
    account.ban = null;
    return null;
  }
  return ban;
}

function getBanTitle(ban) {
  if (ban.type === "permanent") return "Account Deleted";
  if (ban.type === "poison") return "Device Poisoned";
  return "Account Banned";
}

function formatBanNotice(ban, overrideType = "") {
  const type = overrideType || ban.type || "temporary";
  return {
    type,
    title: type === "poison" ? "Device Poisoned" : getBanTitle(ban),
    reason: ban.reason || "No reason given.",
    endsAt: ban.endsAt || "",
    permanentText: type === "permanent" ? "This account is permanently gone." : "",
    poisonedText: type === "poison" ? "This device is poisoned and cannot make a new account." : ""
  };
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
}

function getActivePoisonBan(db, ip) {
  if (!ip || !Array.isArray(db.poisonBans)) {
    return null;
  }
  return db.poisonBans.find((ban) => ban.ip === ip) || null;
}

function addPoisonBan(db, ip, reason, adminId, targetAccountId) {
  if (!Array.isArray(db.poisonBans)) {
    db.poisonBans = [];
  }
  db.poisonBans = db.poisonBans.filter((ban) => ban.ip !== ip);
  db.poisonBans.push({
    ip,
    reason,
    type: "poison",
    createdAt: new Date().toISOString(),
    bannedBy: adminId,
    targetAccountId
  });
}

function getNotificationsForAccount(db, accountId) {
  return (db.notifications || [])
    .filter((notification) => notification.accountId === accountId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function addNotification(db, accountId, text, link = "", type = "general") {
  if (!accountId) return null;
  if (!Array.isArray(db.notifications)) db.notifications = [];
  const notification = {
    id: randomUUID(),
    accountId,
    text,
    link,
    type,
    createdAt: new Date().toISOString(),
    readAt: ""
  };
  db.notifications.push(notification);
  return notification;
}

function migrateCommunity(community) {
  if (!community.id) community.id = randomUUID();
  if (typeof community.name !== "string" || !community.name.trim()) community.name = "Untitled Community";
  if (typeof community.description !== "string") community.description = "";
  if (typeof community.folderName !== "string" || !community.folderName.trim()) {
    community.folderName = sanitizeSegment(community.name, `community-${community.id.slice(0, 8)}`);
  }
  if (!Array.isArray(community.memberIds)) community.memberIds = [];
  if (!Array.isArray(community.adminIds)) community.adminIds = [];
  if (!Array.isArray(community.invitedIds)) community.invitedIds = [];
  if (!Array.isArray(community.boards)) community.boards = [];
  community.maxMembers = clampNumber(community.maxMembers, 2, 100, 25);
  community.isPublic = Boolean(community.isPublic);
  if (typeof community.picturePath !== "string") community.picturePath = "";
  if (typeof community.bannerPath !== "string") community.bannerPath = "";
  ensureCommunityStructure(community);
  for (const board of community.boards) {
    if (!board.id) board.id = randomUUID();
    if (typeof board.title !== "string" || !board.title.trim()) board.title = "Message Board";
    if (!Array.isArray(board.messages)) board.messages = [];
  }
}

function ensureCommunityStructure(community) {
  ensureDir(getCommunityDir(community));
  ensureDir(path.join(getCommunityDir(community), "boards"));
}

function enrichCommunity(db, community, viewer, includeBoards = false) {
  const owner = db.accounts.find((account) => account.id === community.ownerId);
  const members = community.memberIds
    .map((id) => db.accounts.find((account) => account.id === id))
    .filter(Boolean)
    .map((account) => sanitizeAccount(account, viewer));
  const result = {
    id: community.id,
    name: community.name,
    description: community.description,
    ownerId: community.ownerId,
    ownerName: owner ? owner.name : "Unknown",
    adminIds: community.adminIds || [],
    memberCount: community.memberIds.length,
    maxMembers: community.maxMembers,
    isPublic: community.isPublic,
    picturePath: community.picturePath,
    bannerPath: community.bannerPath,
    isMember: community.memberIds.includes(viewer.id),
    isOwner: community.ownerId === viewer.id,
    isAdmin: canModerateCommunity(community, viewer.id),
    isInvited: community.invitedIds.includes(viewer.id)
  };
  if (includeBoards) {
    result.members = members;
    result.boards = community.boards.map((board) => enrichBoard(db, board));
  } else {
    result.boardCount = community.boards.length;
  }
  return result;
}

function enrichBoard(db, board) {
  return {
    id: board.id,
    title: board.title,
    ownerId: board.ownerId,
    createdAt: board.createdAt,
    messages: (board.messages || []).map((message) => {
      const author = db.accounts.find((account) => account.id === message.authorId);
      const linkedAccount = message.linkedAccountId ? db.accounts.find((account) => account.id === message.linkedAccountId) : null;
      const linkedVideo = message.linkedVideoId ? db.videos.find((video) => video.id === message.linkedVideoId) : null;
      return {
        ...message,
        authorName: author ? author.name : "Unknown",
        linkedAccountName: linkedAccount ? linkedAccount.name : "",
        linkedVideoTitle: linkedVideo ? linkedVideo.title : ""
      };
    })
  };
}

function canViewCommunity(community, account) {
  return community.isPublic || community.memberIds.includes(account.id) || community.invitedIds.includes(account.id);
}

function canModerateCommunity(community, accountId) {
  return community.ownerId === accountId || (community.adminIds || []).includes(accountId);
}

function findCommunityFromPath(db, pathname) {
  const match = pathname.match(/\/api\/communities\/([^/]+)/);
  const communityId = match ? decodeURIComponent(match[1]) : "";
  return db.communities.find((community) => community.id === communityId) || null;
}

function findCommunityBoardFromPath(db, pathname) {
  const match = pathname.match(/\/api\/communities\/([^/]+)\/boards\/([^/]+)/);
  const community = match ? db.communities.find((entry) => entry.id === decodeURIComponent(match[1])) : null;
  const boardId = match ? decodeURIComponent(match[2]) : "";
  const board = community ? community.boards.find((entry) => entry.id === boardId) : null;
  return { community, board, boardId };
}

function findCommunityMemberFromPath(db, pathname) {
  const match = pathname.match(/\/api\/communities\/([^/]+)\/members\/([^/]+)/);
  const community = match ? db.communities.find((entry) => entry.id === decodeURIComponent(match[1])) : null;
  const memberId = match ? decodeURIComponent(match[2]) : "";
  return { community, memberId };
}

function findCommunityAdminFromPath(db, pathname) {
  const match = pathname.match(/\/api\/communities\/([^/]+)\/admins\/([^/]+)/);
  const community = match ? db.communities.find((entry) => entry.id === decodeURIComponent(match[1])) : null;
  const memberId = match ? decodeURIComponent(match[2]) : "";
  return { community, memberId };
}

function allocateUniqueCommunityFolder(db, name) {
  const base = sanitizeSegment(name, "community");
  const used = new Set((db.communities || []).map((community) => community.folderName));
  let candidate = base;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${index}`;
    index += 1;
  }
  return candidate;
}

function getCommunityDir(community) {
  return path.join(DATA_DIR, "communities", community.folderName);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function migrateLiveStream(stream) {
  if (!stream.id) stream.id = randomUUID();
  if (typeof stream.title !== "string" || !stream.title.trim()) stream.title = "Untitled livestream";
  if (typeof stream.uploaderId !== "string") stream.uploaderId = "";
  if (typeof stream.startedAt !== "string") stream.startedAt = new Date().toISOString();
  if (typeof stream.endedAt !== "string") stream.endedAt = "";
  if (!Array.isArray(stream.chat)) stream.chat = [];
  stream.active = Boolean(stream.active);
}

function enrichLiveStreams(db, streams) {
  return streams.map((stream) => enrichLiveStream(db, stream));
}

function enrichLiveStream(db, stream) {
  const account = db.accounts.find((entry) => entry.id === stream.uploaderId) || db.accounts[0];
  return {
    id: stream.id,
    type: "live",
    title: stream.title,
    uploaderId: account?.id || "",
    uploaderName: account?.name || "Unknown",
    picturePath: account?.picturePath || "",
    active: Boolean(stream.active),
    startedAt: stream.startedAt,
    endedAt: stream.endedAt || "",
    viewerCount: getSseClientCount(liveFrameClients, stream.id),
    chatCount: Array.isArray(stream.chat) ? stream.chat.length : 0
  };
}

function enrichLiveChat(db, messages) {
  return messages.map((message) => {
    const author = db.accounts.find((account) => account.id === message.authorId);
    return {
      id: message.id,
      authorId: message.authorId,
      authorName: author ? author.name : "Unknown",
      text: message.text,
      createdAt: message.createdAt
    };
  });
}

function getLiveStreamIdFromPath(pathname) {
  const match = pathname.match(/\/api\/live\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

function openSse(req, res, clientMap, streamId, initialEvents = []) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  res.write("event: hello\ndata: {}\n\n");
  if (!clientMap.has(streamId)) clientMap.set(streamId, new Set());
  const clients = clientMap.get(streamId);
  clients.add(res);
  for (const event of initialEvents) {
    writeSse(res, event.type, event.data);
  }
  req.on("close", () => {
    clients.delete(res);
  });
}

function broadcastSse(clientMap, streamId, event, data) {
  const clients = clientMap.get(streamId);
  if (!clients) return;
  for (const client of clients) {
    writeSse(client, event, data);
  }
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function getSseClientCount(clientMap, streamId) {
  return clientMap.get(streamId)?.size || 0;
}

function getAuthenticatedAccount(req, db) {
  const sessionId = parseCookies(req).vido_session;
  if (!sessionId) {
    return null;
  }
  const session = db.sessions.find((entry) => entry.id === sessionId);
  if (!session) {
    return null;
  }
  return db.accounts.find((account) => account.id === session.accountId) || null;
}

function createSessionForAccount(db, accountId, res) {
  const session = {
    id: randomUUID(),
    accountId,
    createdAt: new Date().toISOString()
  };
  db.sessions = db.sessions.filter((entry) => entry.accountId !== accountId);
  db.sessions.push(session);
  setSessionCookie(res, session.id);
}

function destroySession(req, db) {
  const sessionId = parseCookies(req).vido_session;
  if (!sessionId) {
    return;
  }
  db.sessions = db.sessions.filter((entry) => entry.id !== sessionId);
}

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  const cookies = {};
  for (const part of raw.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (!name) continue;
    cookies[name] = decodeURIComponent(rest.join("="));
  }
  return cookies;
}

function setSessionCookie(res, sessionId) {
  res.setHeader("Set-Cookie", `vido_session=${encodeURIComponent(sessionId)}; HttpOnly; Path=/; SameSite=Lax`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "vido_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax");
}

function enrichVideos(db, videos) {
  return videos.map((video) => enrichVideo(db, video));
}

function enrichVideo(db, video) {
  const account = db.accounts.find((entry) => entry.id === video.uploaderId) || db.accounts[0];
  return {
    ...video,
    description: video.description || "",
    thumbnailPath: video.thumbnailPath || "",
    kind: video.kind === "mini" ? "mini" : "video",
    durationSeconds: Number(video.durationSeconds || 0),
    views: Number(video.views || 0),
    comments: enrichComments(db, video.comments || []),
    uploaderId: account.id,
    uploaderName: account.name,
    uploaderPicturePath: account.picturePath
  };
}

function enrichComments(db, comments) {
  return comments.map((comment) => enrichComment(db, comment));
}

function enrichComment(db, comment) {
  const author = db.accounts.find((entry) => entry.id === comment.authorId);
  return {
    ...comment,
    authorName: author ? author.name : "Unknown user"
  };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function writePidFile() {
  fs.writeFileSync(PID_PATH, String(process.pid));
}

function removePidFile() {
  if (fs.existsSync(PID_PATH)) {
    const current = fs.readFileSync(PID_PATH, "utf-8").trim();
    if (current === String(process.pid)) {
      fs.unlinkSync(PID_PATH);
    }
  }
}

function shutdown() {
  logEvent("SERVER_STOPPED", { port: PORT, pid: process.pid });
  removePidFile();
  process.exit(0);
}

function logEvent(type, details) {
  const timestamp = new Date().toISOString();
  const pairs = Object.entries(details || {})
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
  console.log(`[${timestamp}] ${type}${pairs ? ` ${pairs}` : ""}`);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 250 * 1024 * 1024) {
        reject(new Error("Request body too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

function validateBase64File(body, allowedMimeTypes) {
  if (!body || typeof body.data !== "string" || typeof body.mimeType !== "string") {
    return { ok: false, error: "Missing file upload data." };
  }
  if (!allowedMimeTypes.includes(body.mimeType)) {
    return { ok: false, error: `Unsupported file type: ${body.mimeType}` };
  }

  try {
    const buffer = Buffer.from(body.data, "base64");
    if (!buffer.length) {
      return { ok: false, error: "Uploaded file was empty." };
    }
    return { ok: true, buffer, mimeType: body.mimeType };
  } catch (error) {
    return { ok: false, error: "Could not decode uploaded file." };
  }
}

function containsBlockedWord(text) {
  const normalized = ` ${String(text || "").toLowerCase()} `;
  return BLOCKED_WORDS.some((word) => normalized.includes(` ${word} `) || normalized.includes(`${word}.`) || normalized.includes(`${word}!`) || normalized.includes(`${word}?`) || normalized.includes(`${word},`));
}

function mimeToExtension(mimeType) {
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "video/mp4") return ".mp4";
  return "";
}

function toPublicPath(filePath) {
  return path.relative(ROOT, filePath).split(path.sep).join("/");
}

function stripLeadingSlash(value) {
  return value.replace(/^[/\\]+/, "");
}

function decodePathname(value) {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    return value;
  }
}

function serveFile(filePath, req, res) {
  const normalizedPath = path.normalize(filePath);
  if (!normalizedPath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.stat(normalizedPath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const extension = path.extname(normalizedPath).toLowerCase();
    const contentType = MIME_TYPES[extension] || "application/octet-stream";
    const rangeHeader = req.headers.range;

    if (rangeHeader) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      if (!match) {
        res.writeHead(416, { "Content-Range": `bytes */${stats.size}` });
        res.end();
        return;
      }

      let start = match[1] ? Number(match[1]) : 0;
      let end = match[2] ? Number(match[2]) : stats.size - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stats.size) {
        res.writeHead(416, { "Content-Range": `bytes */${stats.size}` });
        res.end();
        return;
      }

      end = Math.min(end, stats.size - 1);
      res.writeHead(206, {
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${stats.size}`,
        "Content-Type": contentType
      });

      if (req.method === "HEAD") {
        res.end();
        return;
      }

      fs.createReadStream(normalizedPath, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, {
      "Accept-Ranges": "bytes",
      "Content-Length": stats.size,
      "Content-Type": contentType
    });

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    fs.createReadStream(normalizedPath).pipe(res);
  });
}

function sanitizeSegment(value, fallback) {
  const cleaned = String(value || "")
    .toLowerCase()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/\.+$/g, "")
    .replace(/^-+|-+$/g, "")
    .replace(/[^a-z0-9-_]/g, "-")
    .replace(/-+/g, "-");
  return cleaned || fallback;
}

function sanitizeFileName(value, fallbackExtension = "") {
  const parsed = path.parse(String(value || ""));
  const baseName = parsed.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").trim();
  const extension = parsed.ext || fallbackExtension;
  const safeBase = baseName || "video";
  return `${safeBase}${extension}`;
}

function allocateUniqueAccountFolder(db, accountName, accountId) {
  const base = sanitizeSegment(accountName, "account");
  let candidate = base;
  let index = 2;
  while (db.accounts.some((account) => account.id !== accountId && account.folderName === candidate)) {
    candidate = `${base}-${index}`;
    index += 1;
  }
  return candidate;
}

function allocateUniqueVideoFolder(db, uploaderId, title, excludeVideoId = "") {
  const base = sanitizeSegment(title, "video");
  let candidate = base;
  let index = 2;
  while (
    db.videos.some(
      (video) =>
        video.id !== excludeVideoId &&
        video.uploaderId === uploaderId &&
        video.folderName === candidate
    )
  ) {
    candidate = `${base}-${index}`;
    index += 1;
  }
  return candidate;
}

function getAccountDir(account) {
  return path.join(DATA_DIR, account.folderName);
}

function getAccountVideosDir(account) {
  return path.join(getAccountDir(account), "videos");
}

function getVideoDir(account, video) {
  return path.join(getAccountVideosDir(account), video.folderName);
}

function ensureAccountStructure(account) {
  ensureDir(getAccountDir(account));
  ensureDir(getAccountVideosDir(account));
}

function refreshAccountPaths(account, videos) {
  if (account.picturePath) {
    const ext = path.extname(account.picturePath) || ".png";
    account.picturePath = toPublicPath(path.join(getAccountDir(account), `pfp${ext}`));
  }
  if (account.bannerPath) {
    const ext = path.extname(account.bannerPath) || ".png";
    account.bannerPath = toPublicPath(path.join(getAccountDir(account), `banner${ext}`));
  }

  for (const video of videos.filter((entry) => entry.uploaderId === account.id)) {
    video.url = toPublicPath(path.join(getVideoDir(account, video), video.originalName));
    video.detailsPath = toPublicPath(path.join(getVideoDir(account, video), "details.txt"));
    if (video.thumbnailPath) {
      const ext = path.extname(video.thumbnailPath) || ".png";
      video.thumbnailPath = toPublicPath(path.join(getVideoDir(account, video), `thumbnail${ext}`));
    }
  }
}

function syncAccountFiles(account, videos) {
  if (account.picturePath) {
    const picturePath = path.join(ROOT, account.picturePath);
    if (!fs.existsSync(picturePath)) {
      const existing = findExistingProfilePicture(account);
      if (existing) {
        account.picturePath = toPublicPath(existing);
      }
    }
  }
  if (account.bannerPath) {
    const bannerPath = path.join(ROOT, account.bannerPath);
    if (!fs.existsSync(bannerPath)) {
      const existing = findExistingBanner(account);
      if (existing) {
        account.bannerPath = toPublicPath(existing);
      }
    }
  }

  for (const video of videos.filter((entry) => entry.uploaderId === account.id)) {
    ensureDir(getVideoDir(account, video));
    writeVideoDetails(account, video);
  }
}

function removeExistingProfilePictures(account) {
  for (const extension of [".jpg", ".png", ".webp"]) {
    const picturePath = path.join(getAccountDir(account), `pfp${extension}`);
    if (fs.existsSync(picturePath)) {
      fs.unlinkSync(picturePath);
    }
  }
}

function removeExistingBanners(account) {
  for (const extension of [".jpg", ".png", ".webp"]) {
    const bannerPath = path.join(getAccountDir(account), `banner${extension}`);
    if (fs.existsSync(bannerPath)) {
      fs.unlinkSync(bannerPath);
    }
  }
}

function findExistingProfilePicture(account) {
  for (const extension of [".jpg", ".png", ".webp"]) {
    const picturePath = path.join(getAccountDir(account), `pfp${extension}`);
    if (fs.existsSync(picturePath)) {
      return picturePath;
    }
  }
  return null;
}

function findExistingBanner(account) {
  for (const extension of [".jpg", ".png", ".webp"]) {
    const bannerPath = path.join(getAccountDir(account), `banner${extension}`);
    if (fs.existsSync(bannerPath)) {
      return bannerPath;
    }
  }
  return null;
}

function migrateProfilePicture(account) {
  if (!account.picturePath) {
    return;
  }

  const sourcePath = path.join(ROOT, account.picturePath);
  if (!fs.existsSync(sourcePath)) {
    const existing = findExistingProfilePicture(account);
    account.picturePath = existing ? toPublicPath(existing) : "";
    return;
  }

  const extension = path.extname(sourcePath) || ".png";
  const targetPath = path.join(getAccountDir(account), `pfp${extension}`);
  if (path.normalize(sourcePath) !== path.normalize(targetPath)) {
    removeExistingProfilePictures(account);
    safeMove(sourcePath, targetPath);
  }
  account.picturePath = toPublicPath(targetPath);
}

function migrateBanner(account) {
  if (!account.bannerPath) {
    return;
  }

  const sourcePath = path.join(ROOT, account.bannerPath);
  if (!fs.existsSync(sourcePath)) {
    const existing = findExistingBanner(account);
    account.bannerPath = existing ? toPublicPath(existing) : "";
    return;
  }

  const extension = path.extname(sourcePath) || ".png";
  const targetPath = path.join(getAccountDir(account), `banner${extension}`);
  if (path.normalize(sourcePath) !== path.normalize(targetPath)) {
    removeExistingBanners(account);
    safeMove(sourcePath, targetPath);
  }
  account.bannerPath = toPublicPath(targetPath);
}

function migrateVideoStorage(account, video) {
  ensureAccountStructure(account);
  const videoDir = getVideoDir(account, video);
  ensureDir(videoDir);

  const sourcePath = video.url ? path.join(ROOT, video.url) : "";
  const targetPath = path.join(videoDir, video.originalName);
  if (sourcePath && fs.existsSync(sourcePath) && path.normalize(sourcePath) !== path.normalize(targetPath)) {
    safeMove(sourcePath, targetPath);
  }

  video.url = toPublicPath(targetPath);
  video.detailsPath = toPublicPath(path.join(videoDir, "details.txt"));

  if (video.thumbnailPath) {
    const thumbnailSource = path.join(ROOT, video.thumbnailPath);
    const extension = path.extname(thumbnailSource) || ".png";
    const thumbnailTarget = path.join(videoDir, `thumbnail${extension}`);
    if (fs.existsSync(thumbnailSource) && path.normalize(thumbnailSource) !== path.normalize(thumbnailTarget)) {
      safeMove(thumbnailSource, thumbnailTarget);
    }
    if (fs.existsSync(thumbnailTarget)) {
      video.thumbnailPath = toPublicPath(thumbnailTarget);
    }
  }
}

function syncVideoFromDetails(account, video) {
  const detailsPath = path.join(getVideoDir(account, video), "details.txt");
  if (!fs.existsSync(detailsPath)) {
    return;
  }

  const details = fs.readFileSync(detailsPath, "utf-8");
  const parsedViews = readDetailNumber(details, "Views");
  if (parsedViews !== null) {
    video.views = parsedViews;
  }
}

function writeVideoDetails(account, video) {
  const details = [
    `Title: ${video.title}`,
    `Description: ${video.description || ""}`,
    `Uploader: ${account.name}`,
    `Uploaded At: ${video.uploadedAt}`,
    `Type: ${video.kind === "mini" ? "Mini" : "Video"}`,
    `Duration Seconds: ${Number(video.durationSeconds || 0)}`,
    `Views: ${Number(video.views || 0)}`,
    `Thumbnail: ${video.thumbnailPath ? path.basename(video.thumbnailPath) : "None"}`,
    `Original Filename: ${video.originalName}`,
    `Visible On Home Page: ${video.showOnHome ? "Yes" : "No"}`,
    `Video ID: ${video.id}`
  ].join("\n");

  fs.writeFileSync(path.join(getVideoDir(account, video), "details.txt"), details);
  video.detailsPath = toPublicPath(path.join(getVideoDir(account, video), "details.txt"));
}

function updateHomeSlots(db, newVideo) {
  const visibleVideos = db.videos
    .filter((video) => video.showOnHome)
    .sort((a, b) => new Date(a.uploadedAt) - new Date(b.uploadedAt));

  if (visibleVideos.length >= 100) {
    visibleVideos[0].showOnHome = false;
    const oldAccount = db.accounts.find((entry) => entry.id === visibleVideos[0].uploaderId) || db.accounts[0];
    writeVideoDetails(oldAccount, visibleVideos[0]);
  }

  newVideo.showOnHome = true;
}

function writeAccountReadme(account) {
  const readmePath = path.join(getAccountDir(account), "account.txt");
  const ban = account.ban || null;
  const contents = [
    `Username: ${account.name}`,
    `Account ID: ${account.id}`,
    `Profile Picture: ${account.picturePath ? path.basename(account.picturePath) : "None"}`,
    `Banner: ${account.bannerPath ? path.basename(account.bannerPath) : "None"}`,
    `Followers: ${Array.isArray(account.followerIds) ? account.followerIds.length : 0}`,
    `Ban Status: ${ban ? ban.type : "None"}`,
    `Ban Reason: ${ban ? ban.reason : "None"}`,
    `Ban Ends: ${ban && ban.endsAt ? ban.endsAt : "Never"}`
  ].join("\n");
  fs.writeFileSync(readmePath, contents);
}

function readDetailNumber(detailsText, label) {
  const pattern = new RegExp(`^${escapeRegExp(label)}:\\s*(\\d+)\\s*$`, "mi");
  const match = detailsText.match(pattern);
  return match ? Number(match[1]) : null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeMove(sourcePath, targetPath) {
  ensureDir(path.dirname(targetPath));
  if (path.normalize(sourcePath) === path.normalize(targetPath)) {
    return;
  }
  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }
  fs.renameSync(sourcePath, targetPath);
}

function safeRemoveDir(targetPath) {
  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }
}

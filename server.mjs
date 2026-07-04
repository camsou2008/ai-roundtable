import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initDb, listRooms, createRoom, updateRoom, deleteRoom, getRoom } from "./db.mjs";
import {
  handleRegister,
  handleLogin,
  handleLogout,
  handleGetMe,
  handleChangePassword,
  handleAdminResetPassword,
  getSessionId,
  setSessionCookie,
  clearSessionCookie,
  findSession,
  requireAdmin,
} from "./auth.mjs";
import {
  createInviteCode,
  listInviteCodes,
  deleteInviteCode,
  addRoomAgent,
  listRoomAgents,
  removeRoomAgent,
  listAllAgents,
  addRoomMember,
  getRoomMembers,
  removeRoomMember,
  isRoomMember,
  getUserRooms,
  getUserRoomIds,
  listAllUsers,
  updateUserRole,
  deleteUser as deleteUserDb,
} from "./db.mjs";
import { initWebSocket } from "./ws.mjs";
import { checkAgent } from "./agent-runner.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, "public");
const STATIC_FILES = new Set(["/", "/login", "/chat", "/admin", "/styles.css"]);

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

const MAX_BODY_BYTES = 256 * 1024;

function sendJson(response, status, data) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(data));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("请求内容过大");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function serveStatic(url, response) {
  let filename;
  if (url.pathname === "/") filename = "login.html";
  else if (url.pathname === "/login") filename = "login.html";
  else if (url.pathname === "/chat") filename = "chat.html";
  else if (url.pathname === "/admin") filename = "admin.html";
  else filename = url.pathname.slice(1);

  const filePath = join(PUBLIC, filename);
  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(filename)] || "application/octet-stream",
      "cache-control": "no-cache",
    });
    response.end(content);
  } catch {
    sendJson(response, 404, { error: "页面文件不存在" });
  }
}

// ── 创建初始房间和 Agent ──

function seedInitialData() {
  const rooms = listRooms();
  if (rooms.length === 0) {
    const roomId = createRoom("AI 圆桌", "AI 应不应该拥有长期记忆？", 1);
    addRoomMember(roomId, 1);
    console.log("  → 已创建默认房间: AI 圆桌");
  }
}

// ── Server ──

async function handleRequest(request, response) {
  const url = new URL(request.url, "http://127.0.0.1");
  const sessionId = getSessionId(request);
  const session = sessionId ? findSession(sessionId) : null;

  // ── CORS ──
  response.setHeader("access-control-allow-origin", "*");

  // ── Auth API ──

  if (request.method === "POST" && url.pathname === "/api/auth/register") {
    try {
      const body = await readJson(request);
      const result = await handleRegister(body);
      return sendJson(response, result.status, result.error ? { error: result.error } : { ok: true, userId: result.userId });
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
  }

  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    try {
      const body = await readJson(request);
      const result = await handleLogin(body);
      if (result.status === 200) {
        setSessionCookie(response, result.sessionId);
        return sendJson(response, 200, { user: result.user });
      }
      return sendJson(response, result.status, { error: result.error });
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
  }

  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    handleLogout(sessionId);
    clearSessionCookie(response);
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === "GET" && url.pathname === "/api/auth/me") {
    const result = handleGetMe(sessionId);
    if (result.status === 200) return sendJson(response, 200, result.user);
    return sendJson(response, result.status, { error: result.error });
  }

  if (request.method === "PUT" && url.pathname === "/api/auth/password") {
    try {
      const body = await readJson(request);
      const result = handleChangePassword(sessionId, body);
      return sendJson(response, result.status, result.error ? { error: result.error } : { ok: true });
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
  }

  // ── Rooms API ──

  if (request.method === "GET" && url.pathname === "/api/rooms") {
    if (!session) return sendJson(response, 401, { error: "未登录" });
    const rooms = getUserRooms(session.user_id);
    return sendJson(response, 200, rooms);
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/rooms/") && url.pathname.endsWith("/members")) {
    if (!session) return sendJson(response, 401, { error: "未登录" });
    const roomId = Number(url.pathname.split("/")[3]);
    const members = getRoomMembers(roomId);
    return sendJson(response, 200, members);
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/rooms/") && url.pathname.endsWith("/agents")) {
    if (!session) return sendJson(response, 401, { error: "未登录" });
    const roomId = Number(url.pathname.split("/")[3]);
    const agents = listRoomAgents(roomId);
    return sendJson(response, 200, agents);
  }

  // ── Member room & agent management ──
  // Any logged-in user can create a room
  if (request.method === "POST" && url.pathname === "/api/rooms") {
    if (!session) return sendJson(response, 401, { error: "未登录" });
    try {
      const body = await readJson(request);
      if (!body.name) return sendJson(response, 400, { error: "房间名称必填" });
      const roomId = createRoom(body.name, body.topic || body.name, session.user_id);
      addRoomMember(roomId, session.user_id); // creator auto-joins
      return sendJson(response, 200, { id: roomId });
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
  }

  // Any room member can add an agent to that room
  if (request.method === "POST" && url.pathname.match(/^\/api\/rooms\/\d+\/agents$/)) {
    if (!session) return sendJson(response, 401, { error: "未登录" });
    const roomId = Number(url.pathname.split("/")[3]);
    if (!isRoomMember(roomId, session.user_id)) {
      return sendJson(response, 403, { error: "你不是该房间成员" });
    }
    try {
      const body = await readJson(request);
      if (!body.name || !body.command) return sendJson(response, 400, { error: "名称和命令必填" });
      addRoomAgent(roomId, body.name, body.command, body.prompt || "", session.user_id);
      return sendJson(response, 200, { ok: true });
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
  }

  // ── Agents status ──

  if (request.method === "GET" && url.pathname === "/api/agents/check") {
    if (!session) return sendJson(response, 401, { error: "未登录" });
    const [codex, hermes] = await Promise.all([checkAgent("codex"), checkAgent("hermes")]);
    return sendJson(response, 200, { codex, hermes });
  }

  // ── Admin API (need admin role) ──

  if (url.pathname.startsWith("/api/admin")) {
    if (!session || !requireAdmin(session)) {
      return sendJson(response, 403, { error: "仅管理员可操作" });
    }

    // Invite codes
    if (request.method === "GET" && url.pathname === "/api/admin/invites") {
      return sendJson(response, 200, listInviteCodes());
    }

    if (request.method === "POST" && url.pathname === "/api/admin/invites") {
      const body = await readJson(request);
      const days = body.expiresInDays || 7;
      const code = createInviteCode(session.user_id, days);
      return sendJson(response, 200, { code });
    }

    if (request.method === "DELETE" && url.pathname.startsWith("/api/admin/invites/")) {
      const id = Number(url.pathname.split("/")[4]);
      deleteInviteCode(id);
      return sendJson(response, 200, { ok: true });
    }

    // Rooms (admin: list all)
    if (request.method === "GET" && url.pathname === "/api/admin/rooms") {
      return sendJson(response, 200, listRooms());
    }

    // All agents
    if (request.method === "GET" && url.pathname === "/api/admin/agents") {
      return sendJson(response, 200, listAllAgents());
    }

    if (request.method === "POST" && url.pathname === "/api/admin/rooms") {
      const body = await readJson(request);
      if (!body.name) return sendJson(response, 400, { error: "房间名称必填" });
      const roomId = createRoom(body.name, body.topic || body.name, session.user_id);
      // Admin自动加入
      addRoomMember(roomId, session.user_id);
      return sendJson(response, 200, { id: roomId });
    }

    if (request.method === "PUT" && url.pathname.startsWith("/api/admin/rooms/")) {
      const id = Number(url.pathname.split("/")[4]);
      const body = await readJson(request);
      updateRoom(id, body.name, body.topic || "");
      return sendJson(response, 200, { ok: true });
    }

    if (request.method === "DELETE" && url.pathname.startsWith("/api/admin/rooms/")) {
      const id = Number(url.pathname.split("/")[4]);
      deleteRoom(id);
      return sendJson(response, 200, { ok: true });
    }

    // Add member to room
    if (request.method === "POST" && url.pathname.endsWith("/members")) {
      const parts = url.pathname.split("/");
      const roomId = Number(parts[3]);
      const body = await readJson(request);
      addRoomMember(roomId, body.user_id);
      return sendJson(response, 200, { ok: true });
    }

    // Remove member from room
    if (request.method === "DELETE" && url.pathname.match(/^\/api\/admin\/rooms\/\d+\/members\/\d+$/)) {
      const parts = url.pathname.split("/");
      const roomId = Number(parts[3]);
      const userId = Number(parts[5]);
      removeRoomMember(roomId, userId);
      return sendJson(response, 200, { ok: true });
    }

    // Room agents
    if (request.method === "POST" && url.pathname.match(/^\/api\/admin\/rooms\/\d+\/agents$/)) {
      const parts = url.pathname.split("/");
      const roomId = Number(parts[4]);
      const body = await readJson(request);
      if (!body.name || !body.command) return sendJson(response, 400, { error: "名称和命令必填" });
      addRoomAgent(roomId, body.name, body.command, body.prompt || "", session.user_id);
      return sendJson(response, 200, { ok: true });
    }

    if (request.method === "DELETE" && url.pathname.match(/^\/api\/admin\/agents\/\d+$/)) {
      const id = Number(url.pathname.split("/")[4]);
      removeRoomAgent(id);
      return sendJson(response, 200, { ok: true });
    }

    // Users
    if (request.method === "GET" && url.pathname === "/api/admin/users") {
      return sendJson(response, 200, listAllUsers());
    }

    if (request.method === "PUT" && url.pathname.match(/^\/api\/admin\/users\/\d+\/role$/)) {
      const id = Number(url.pathname.split("/")[4]);
      const body = await readJson(request);
      if (!["admin", "member"].includes(body.role)) {
        return sendJson(response, 400, { error: "无效角色" });
      }
      updateUserRole(id, body.role);
      return sendJson(response, 200, { ok: true });
    }

    if (request.method === "DELETE" && url.pathname.match(/^\/api\/admin\/users\/\d+$/)) {
      const id = Number(url.pathname.split("/")[4]);
      if (id === session.user_id) {
        return sendJson(response, 400, { error: "不能删除自己" });
      }
      deleteUserDb(id);
      return sendJson(response, 200, { ok: true });
    }

    // User room assignment
    if (request.method === "GET" && url.pathname.match(/^\/api\/admin\/users\/\d+\/rooms$/)) {
      const id = Number(url.pathname.split("/")[4]);
      const allRooms = listRooms();
      const userRoomIds = getUserRoomIds(id);
      const result = allRooms.map(r => ({ ...r, assigned: userRoomIds.includes(r.id) }));
      return sendJson(response, 200, result);
    }

    if (request.method === "PUT" && url.pathname.match(/^\/api\/admin\/users\/\d+\/rooms$/)) {
      const id = Number(url.pathname.split("/")[4]);
      const body = await readJson(request);
      const roomIds = body.room_ids || [];
      // Remove from all rooms first, then add selected
      const currentRooms = getUserRoomIds(id);
      for (const rid of currentRooms) {
        if (!roomIds.includes(rid)) removeRoomMember(rid, id);
      }
      for (const rid of roomIds) {
        addRoomMember(rid, id);
      }
      return sendJson(response, 200, { ok: true });
    }

    // Admin reset user password
    if (request.method === "PUT" && url.pathname.match(/^\/api\/admin\/users\/\d+\/password$/)) {
      const id = Number(url.pathname.split("/")[4]);
      const body = await readJson(request);
      const result = handleAdminResetPassword(id, body.newPassword);
      return sendJson(response, result.status, result.error ? { error: result.error } : { ok: true });
    }
  }

  // ── Static files ──

  if (request.method === "GET" && STATIC_FILES.has(url.pathname)) {
    return serveStatic(url, response);
  }

  return sendJson(response, 404, { error: "未找到该路径" });
}

// ── Main ──

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const port = Number(process.env.PORT || 4173);

  console.log("🌀 初始化数据库...");
  initDb();
  seedInitialData();
  console.log("✅ 数据库就绪");

  const server = createServer(handleRequest);
  initWebSocket(server);

  server.listen(port, "0.0.0.0", () => {
    console.log(`󰀃 Roundtable v2 运行中 http://0.0.0.0:${port}`);
    console.log(`   默认管理员: admin / admin123`);
  });
}

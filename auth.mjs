import crypto from "node:crypto";
import {
  findUserByUsername,
  findUserById,
  createSession as dbCreateSession,
  deleteSession,
  findSession,
  isValidInviteCode,
  useInviteCode,
  getDb,
} from "./db.mjs";

const COOKIE_NAME = "roundtable_sid";
const SALT_LEN = 16;
const HASH_LEN = 64;

function hashPassword(password, saltHex = null) {
  const salt = saltHex ? Buffer.from(saltHex, "hex") : crypto.randomBytes(SALT_LEN);
  const hash = crypto.scryptSync(password, salt, HASH_LEN);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

function verifyPassword(password, stored) {
  const [saltHex] = stored.split(":");
  return hashPassword(password, saltHex) === stored;
}

// ── Auth API 处理函数 ──

export function handleRegister(body) {
  const { username, password, inviteCode } = body;
  if (!username || !password || !inviteCode) {
    return { status: 400, error: "用户名、密码和邀请码必填" };
  }
  if (username.length < 2 || username.length > 20) {
    return { status: 400, error: "用户名长度 2-20 个字符" };
  }
  if (password.length < 6) {
    return { status: 400, error: "密码至少 6 位" };
  }
  const invite = isValidInviteCode(inviteCode);
  if (!invite) {
    return { status: 400, error: "邀请码无效或已过期" };
  }
  if (findUserByUsername(username)) {
    return { status: 400, error: "用户名已被注册" };
  }

  const db = getDb();
  const info = db.prepare("INSERT INTO users (username, password, role) VALUES (?, ?, 'member')").run(
    username,
    hashPassword(password)
  );
  useInviteCode(inviteCode, info.lastInsertRowid);

  // 自动加入所有现有房间
  const allRooms = db.prepare("SELECT id FROM rooms").all();
  const insertMember = db.prepare("INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)");
  for (const room of allRooms) {
    insertMember.run(room.id, info.lastInsertRowid);
  }

  return { status: 201, userId: info.lastInsertRowid };
}

export function handleLogin(body) {
  const { username, password } = body;
  if (!username || !password) {
    return { status: 400, error: "用户名和密码必填" };
  }
  const user = findUserByUsername(username);
  if (!user || !verifyPassword(password, user.password)) {
    return { status: 401, error: "用户名或密码错误" };
  }
  const sid = dbCreateSession(user.id);
  return { status: 200, sessionId: sid, user: { id: user.id, username: user.username, role: user.role } };
}

export function handleLogout(sessionId) {
  if (sessionId) deleteSession(sessionId);
  return { status: 200 };
}

export function handleGetMe(sessionId) {
  if (!sessionId) return { status: 401, error: "未登录" };
  const session = findSession(sessionId);
  if (!session) return { status: 401, error: "会话已过期" };
  return { status: 200, user: { id: session.user_id, username: session.username, role: session.role } };
}

export function handleChangePassword(sessionId, body) {
  if (!sessionId) return { status: 401, error: "未登录" };
  const session = findSession(sessionId);
  if (!session) return { status: 401, error: "会话已过期" };

  const { oldPassword, newPassword } = body;
  if (!oldPassword || !newPassword) return { status: 400, error: "旧密码和新密码必填" };
  if (newPassword.length < 6) return { status: 400, error: "新密码至少 6 位" };

  const db = getDb();
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(session.user_id);
  if (!user || !verifyPassword(oldPassword, user.password)) {
    return { status: 401, error: "旧密码错误" };
  }

  db.prepare("UPDATE users SET password = ? WHERE id = ?").run(hashPassword(newPassword), session.user_id);
  return { status: 200 };
}

export function handleAdminResetPassword(targetUserId, newPassword) {
  if (!targetUserId || !newPassword) return { status: 400, error: "参数不完整" };
  if (newPassword.length < 6) return { status: 400, error: "新密码至少 6 位" };
  const db = getDb();
  db.prepare("UPDATE users SET password = ? WHERE id = ?").run(hashPassword(newPassword), targetUserId);
  return { status: 200 };
}

// ── Cookie 解析 (简化版，不依赖外部库) ──

export function parseCookies(request) {
  const cookie = request.headers?.cookie || "";
  const cookies = {};
  for (const pair of cookie.split(";")) {
    const [key, ...rest] = pair.trim().split("=");
    if (key) cookies[key.trim()] = rest.join("=").trim();
  }
  return cookies;
}

export function getSessionId(request) {
  return parseCookies(request)[COOKIE_NAME] || null;
}

export function setSessionCookie(response, sessionId) {
  response.setHeader("Set-Cookie", `${COOKIE_NAME}=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`);
}

export function clearSessionCookie(response) {
  response.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

// ── 用于 WebSocket 的 session 验证 ──

export function validateWsSession(cookieHeader) {
  const cookies = {};
  for (const pair of (cookieHeader || "").split(";")) {
    const [key, ...rest] = pair.trim().split("=");
    if (key) cookies[key.trim()] = rest.join("=").trim();
  }
  const sid = cookies[COOKIE_NAME];
  if (!sid) return null;
  return findSession(sid);
}

// ── 需要管理员权限 ──

export function requireAdmin(session) {
  return session?.role === "admin";
}

export { hashPassword, verifyPassword, findSession };

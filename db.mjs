import Database from "better-sqlite3";
import crypto from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(ROOT, "data");

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

let db;

export function getDb() {
  if (!db) throw new Error("Database not initialized. Call initDb() first.");
  return db;
}

export function initDb() {
  ensureDataDir();
  db = new Database(join(DATA_DIR, "roundtable.db"));

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      username    TEXT    NOT NULL UNIQUE,
      password    TEXT    NOT NULL,
      role        TEXT    NOT NULL DEFAULT 'member' CHECK(role IN ('admin','member')),
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT    PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS invite_codes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      code        TEXT    NOT NULL UNIQUE,
      created_by  INTEGER NOT NULL REFERENCES users(id),
      used_by     INTEGER REFERENCES users(id),
      used_at     TEXT,
      expires_at  TEXT    NOT NULL,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      topic       TEXT    NOT NULL DEFAULT '',
      created_by  INTEGER NOT NULL REFERENCES users(id),
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS room_members (
      room_id   INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (room_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS room_agents (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id   INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      name      TEXT    NOT NULL,
      command   TEXT    NOT NULL,
      prompt    TEXT    NOT NULL DEFAULT '',
      active    INTEGER NOT NULL DEFAULT 1,
      added_by  INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT   NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id     INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      sender_type TEXT    NOT NULL CHECK(sender_type IN ('user','agent','system')),
      sender_id   INTEGER,
      sender_name TEXT    NOT NULL,
      content     TEXT    NOT NULL,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_invite_code ON invite_codes(code);
  `);

  // Seed default admin if no users exist
  const count = db.prepare("SELECT COUNT(*) AS c FROM users").get();
  if (count.c === 0) {
    const rawSalt = crypto.randomBytes(16);
    const saltHex = rawSalt.toString("hex");
    const hash = crypto.scryptSync("admin123", rawSalt, 64).toString("hex");
    db.prepare("INSERT INTO users (username, password, role) VALUES (?, ?, 'admin')").run(
      "admin",
      `${saltHex}:${hash}`
    );
    console.log("  → 已创建默认管理员: admin / admin123");
  }

  return db;
}

// ── Users ──

export function findUserByUsername(username) {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username);
}

export function findUserById(id) {
  return db.prepare("SELECT id, username, role, created_at FROM users WHERE id = ?").get(id);
}

export function listAllUsers() {
  return db.prepare(`
    SELECT u.id, u.username, u.role, u.created_at,
           (SELECT COUNT(*) FROM room_members rm WHERE rm.user_id = u.id) AS room_count
    FROM users u ORDER BY u.created_at DESC
  `).all();
}

export function updateUserRole(id, role) {
  db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, id);
}

export function deleteUser(id) {
  db.prepare("DELETE FROM users WHERE id = ?").run(id);
}

// ── Sessions ──

export function findSession(id) {
  return db.prepare(`
    SELECT s.*, u.username, u.role
    FROM sessions s JOIN users u ON s.user_id = u.id
    WHERE s.id = ?
  `).get(id);
}

export function createSession(userId) {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO sessions (id, user_id) VALUES (?, ?)").run(id, userId);
  return id;
}

export function deleteSession(id) {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

// ── Invite Codes ──

export function isValidInviteCode(code) {
  return db.prepare(`
    SELECT id FROM invite_codes
    WHERE code = ? AND used_by IS NULL AND expires_at > datetime('now')
  `).get(code);
}

export function useInviteCode(code, userId) {
  db.prepare("UPDATE invite_codes SET used_by = ?, used_at = datetime('now') WHERE code = ?").run(userId, code);
}

export function createInviteCode(createdBy, expiresInDays = 7) {
  const code = crypto.randomBytes(4).toString("hex").toUpperCase();
  db.prepare(`
    INSERT INTO invite_codes (code, created_by, expires_at)
    VALUES (?, ?, datetime('now', ?))
  `).run(code, createdBy, `+${expiresInDays} days`);
  return code;
}

export function listInviteCodes() {
  return db.prepare(`
    SELECT c.*, u.username AS creator_name,
           u2.username AS used_by_name
    FROM invite_codes c
    JOIN users u ON c.created_by = u.id
    LEFT JOIN users u2 ON c.used_by = u2.id
    ORDER BY c.created_at DESC
  `).all();
}

export function deleteInviteCode(id) {
  db.prepare("DELETE FROM invite_codes WHERE id = ?").run(id);
}

// ── Rooms ──

export function createRoom(name, topic, createdBy) {
  const info = db.prepare("INSERT INTO rooms (name, topic, created_by) VALUES (?, ?, ?)").run(name, topic, createdBy);
  return info.lastInsertRowid;
}

export function listRooms() {
  return db.prepare("SELECT * FROM rooms ORDER BY created_at DESC").all();
}

export function getRoom(id) {
  return db.prepare("SELECT * FROM rooms WHERE id = ?").get(id);
}

export function updateRoom(id, name, topic) {
  db.prepare("UPDATE rooms SET name = ?, topic = ? WHERE id = ?").run(name, topic, id);
}

export function deleteRoom(id) {
  db.prepare("DELETE FROM rooms WHERE id = ?").run(id);
}

// ── Room Members ──

export function addRoomMember(roomId, userId) {
  db.prepare("INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)").run(roomId, userId);
}

export function removeRoomMember(roomId, userId) {
  db.prepare("DELETE FROM room_members WHERE room_id = ? AND user_id = ?").run(roomId, userId);
}

export function getRoomMembers(roomId) {
  return db.prepare(`
    SELECT u.id, u.username, u.role FROM room_members rm
    JOIN users u ON rm.user_id = u.id
    WHERE rm.room_id = ?
  `).all(roomId);
}

export function getUserRooms(userId) {
  return db.prepare(`
    SELECT r.* FROM rooms r
    JOIN room_members rm ON r.id = rm.room_id
    WHERE rm.user_id = ?
    ORDER BY r.created_at DESC
  `).all(userId);
}

export function getUserRoomIds(userId) {
  return db.prepare("SELECT room_id FROM room_members WHERE user_id = ?").all(userId).map(r => r.room_id);
}

export function isRoomMember(roomId, userId) {
  return !!db.prepare("SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?").get(roomId, userId);
}

// ── Room Agents ──

export function addRoomAgent(roomId, name, command, prompt, addedBy) {
  db.prepare("INSERT INTO room_agents (room_id, name, command, prompt, added_by) VALUES (?, ?, ?, ?, ?)")
    .run(roomId, name, command, prompt, addedBy);
}

export function listRoomAgents(roomId) {
  return db.prepare("SELECT * FROM room_agents WHERE room_id = ? AND active = 1").all(roomId);
}

export function listAllAgents() {
  return db.prepare(`
    SELECT a.*, r.name AS room_name
    FROM room_agents a JOIN rooms r ON a.room_id = r.id
    WHERE a.active = 1
    ORDER BY a.created_at DESC
  `).all();
}

export function removeRoomAgent(id) {
  db.prepare("UPDATE room_agents SET active = 0 WHERE id = ?").run(id);
}

// ── Messages ──

export function saveMessage(roomId, senderType, senderId, senderName, content) {
  const info = db.prepare(
    "INSERT INTO messages (room_id, sender_type, sender_id, sender_name, content) VALUES (?, ?, ?, ?, ?)"
  ).run(roomId, senderType, senderId, senderName, content);
  return info.lastInsertRowid;
}

export function getMessages(roomId, limit = 50, beforeId = null) {
  if (beforeId) {
    return db.prepare(`
      SELECT * FROM messages
      WHERE room_id = ? AND id < ?
      ORDER BY created_at DESC LIMIT ?
    `).all(roomId, beforeId, limit).reverse();
  }
  return db.prepare(`
    SELECT id, room_id, sender_type, sender_id, sender_name, content, created_at
    FROM messages WHERE room_id = ? ORDER BY id DESC LIMIT ?
  `).all(roomId, limit).reverse();
}

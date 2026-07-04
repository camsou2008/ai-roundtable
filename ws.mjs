import { WebSocketServer } from "ws";
import { validateWsSession } from "./auth.mjs";
import {
  saveMessage,
  getMessages,
  listRoomAgents,
  isRoomMember,
  getRoom,
} from "./db.mjs";
import { runAgent, checkAgent } from "./agent-runner.mjs";

// Map: roomId -> Set<{ ws, user }>
const rooms = new Map();
const agentSessions = new Map(); // Map: "agentId:roomId" -> sessionStr

function getRoomClients(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  return rooms.get(roomId);
}

function broadcast(roomId, message, excludeWs = null) {
  const data = typeof message === "string" ? message : JSON.stringify(message);
  for (const client of getRoomClients(roomId)) {
    if (client.ws !== excludeWs && client.ws.readyState === 1) {
      client.ws.send(data);
    }
  }
}

async function handleAgentReply(room, agent, prompt) {
  const key = `${agent.id}:${room.id}`;
  const sessionStr = agentSessions.get(key) || "";

  try {
    const result = await runAgent(
      agent.name,
      agent.command,
      prompt,
      room.topic,
      [],   // context 暂时空着，可以后续扩展
      sessionStr,
      null  // signal
    );
    if (result.sessionId) agentSessions.set(key, result.sessionId);
    const msgId = saveMessage(room.id, "agent", agent.id, agent.name, result.response);
    broadcast(room.id, {
      type: "message",
      id: msgId,
      room_id: room.id,
      sender_type: "agent",
      sender_id: agent.id,
      sender_name: agent.name,
      content: result.response,
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    const errMsg = `${agent.name} 暂时无法回复：${error.message}`;
    const msgId = saveMessage(room.id, "agent", agent.id, agent.name, errMsg);
    broadcast(room.id, {
      type: "message",
      id: msgId,
      room_id: room.id,
      sender_type: "agent",
      sender_id: agent.id,
      sender_name: agent.name,
      content: errMsg,
      created_at: new Date().toISOString(),
      error: true,
    });
  }
}

function handleMessage(ws, user, data) {
  if (!data.room_id || !data.content?.trim()) {
    ws.send(JSON.stringify({ type: "error", message: "参数不完整" }));
    return;
  }

  const roomId = data.room_id;
  const room = getRoom(roomId);
  if (!room || !isRoomMember(roomId, user.id)) {
    ws.send(JSON.stringify({ type: "error", message: "无权在该房间发言" }));
    return;
  }

  const content = data.content.trim();
  const msgId = saveMessage(roomId, "user", user.id, user.username, content);
  const msg = {
    type: "message",
    id: msgId,
    room_id: roomId,
    sender_type: "user",
    sender_id: user.id,
    sender_name: user.username,
    content,
    created_at: new Date().toISOString(),
  };

  broadcast(roomId, msg);

  // Trigger agent replies
  const agents = listRoomAgents(roomId);
  for (const agent of agents) {
    // 根据消息内容决定是否触发
    // 如果是 @AgentName 或者 @全体 则触发
    const mentionAll = content.includes("@全体");
    const mentionAgent = content.includes(`@${agent.name}`);
    const isDirect = data.target === "all" || data.target === agent.command || mentionAll || mentionAgent;
    if (isDirect) {
      const agentPrompt = mentionAgent
        ? content.replace(new RegExp(`@${agent.name}`, "g"), "").trim()
        : content;
      handleAgentReply(room, agent, agentPrompt);
    }
  }
}

function handleJoin(ws, user, data) {
  const roomId = data.room_id;
  const room = getRoom(roomId);
  if (!room || !isRoomMember(roomId, user.id)) {
    ws.send(JSON.stringify({ type: "error", message: "无权加入该房间" }));
    return;
  }

  // Leave other rooms in this WS connection
  for (const [rId, clients] of rooms) {
    for (const client of clients) {
      if (client.ws === ws && rId !== roomId) {
        clients.delete(client);
      }
    }
  }

  getRoomClients(roomId).add({ ws, user });
  ws.roomId = roomId;

  // Send recent messages
  const messages = getMessages(roomId, 50);
  ws.send(JSON.stringify({ type: "history", messages }));

  // Broadcast user joined
  broadcast(roomId, {
    type: "user_joined",
    user: { id: user.id, username: user.username },
  }, ws);
}

function handleLeave(ws) {
  for (const [roomId, clients] of rooms) {
    for (const client of clients) {
      if (client.ws === ws) {
        clients.delete(client);
        broadcast(roomId, {
          type: "user_left",
          user: { id: client.user.id, username: client.user.username },
        });
        return;
      }
    }
  }
}

function handleOnlineUsers(ws, data) {
  const roomId = data.room_id;
  if (!roomId) return;
  const clients = getRoomClients(roomId);
  const users = [];
  for (const client of clients) {
    users.push({ id: client.user.id, username: client.user.username });
  }
  ws.send(JSON.stringify({ type: "online_users", users }));
}

function handleAgentStatus(ws, data) {
  const roomId = data.room_id;
  if (!roomId) return;
  const agents = listRoomAgents(roomId);
  // 异步检查状态
  Promise.all(agents.map(async (agent) => {
    const status = await checkAgent(agent.command);
    return { ...agent, ...status };
  })).then((results) => {
    ws.send(JSON.stringify({ type: "agent_status", agents: results }));
  });
}

// ── Cross-examination ──

function handleCrossExamine(ws, data) {
  const roomId = data.room_id;
  if (!roomId) return;
  const room = getRoom(roomId);
  if (!room) return;

  // Get latest messages from DB
  const recentMessages = getMessages(roomId, 50);
  const agentMessages = {};
  for (const msg of recentMessages) {
    if (msg.sender_type === "agent" && !msg.error) {
      if (!agentMessages[msg.sender_name]) {
        agentMessages[msg.sender_name] = msg;
      }
    }
  }

  const agentNames = Object.keys(agentMessages);
  if (agentNames.length < 2) return;

  // Have each agent respond to the other's latest message
  for (let i = 0; i < agentNames.length; i++) {
    for (let j = i + 1; j < agentNames.length; j++) {
      const a = agentNames[i];
      const b = agentNames[j];
      const msgA = agentMessages[a].content;
      const msgB = agentMessages[b].content;
      const agents = listRoomAgents(roomId);
      const agentA = agents.find(ag => ag.name === a);
      const agentB = agents.find(ag => ag.name === b);

      if (agentA) {
        handleAgentReply(room, agentA, `请阅读另一位参与者 ${b} 的最新观点，指出你最认同和最不同意的部分：\n\n${b} 的观点：${msgB}`);
      }
      if (agentB) {
        handleAgentReply(room, agentB, `请阅读另一位参与者 ${a} 的最新观点，指出你最认同和最不同意的部分：\n\n${a} 的观点：${msgA}`);
      }
    }
  }
}

// ── 初始化 WebSocket Server ──

export function initWebSocket(httpServer) {
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws, request) => {
    const session = validateWsSession(request.headers.cookie || "");
    if (!session) {
      ws.send(JSON.stringify({ type: "error", message: "请先登录" }));
      ws.close();
      return;
    }

    const user = { id: session.user_id, username: session.username, role: session.role };
    ws.user = user;
    ws.roomId = null;

    ws.on("message", (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "无效消息格式" }));
        return;
      }

      switch (data.type) {
        case "join":
          handleJoin(ws, user, data);
          break;
        case "message":
          handleMessage(ws, user, data);
          break;
        case "leave":
          handleLeave(ws);
          break;
        case "online_users":
          handleOnlineUsers(ws, data);
          break;
        case "agent_status":
          handleAgentStatus(ws, data);
          break;
        case "cross_examine":
          handleCrossExamine(ws, data);
          break;
        default:
          ws.send(JSON.stringify({ type: "error", message: `未知消息类型: ${data.type}` }));
      }
    });

    ws.on("close", () => {
      handleLeave(ws);
    });
  });

  return wss;
}

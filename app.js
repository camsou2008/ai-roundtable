const STORAGE_KEY = "roundtable.rooms.v1";
const isStaticPreview = location.hostname.endsWith(".github.io");
const roomList = document.querySelector("#room-list");
const conversation = document.querySelector("#conversation");
const roomTitle = document.querySelector("#room-title");
const input = document.querySelector("#message-input");
const sendButton = document.querySelector("#send-button");
const topicDialog = document.querySelector("#topic-dialog");
const topicForm = document.querySelector("#topic-form");
const topicInput = document.querySelector("#topic-input");
const messageTemplate = document.querySelector("#message-template");
const sidebar = document.querySelector(".sidebar");

let state = loadState();
let activeRoomId = state.activeRoomId;
let target = "all";
let pending = new Set();

function makeRoom(topic = "AI 应不应该拥有长期记忆？") {
  return {
    id: crypto.randomUUID(),
    title: topic,
    topic,
    createdAt: Date.now(),
    sessions: { codex: "", hermes: "" },
    messages: [],
  };
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved?.rooms?.length) return saved;
  } catch {
    // Start with a clean local state if an older value is malformed.
  }
  const room = makeRoom();
  return { activeRoomId: room.id, rooms: [room] };
}

function saveState() {
  state.activeRoomId = activeRoomId;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function activeRoom() {
  return state.rooms.find((room) => room.id === activeRoomId) || state.rooms[0];
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(timestamp);
}

function speakerInfo(speaker) {
  return {
    user: { label: "你", avatar: "你", className: "avatar-user" },
    codex: { label: "Codex", avatar: "C", className: "avatar-codex" },
    hermes: { label: "Hermes", avatar: "H", className: "avatar-hermes" },
    system: { label: "房间助手", avatar: "圆", className: "avatar-system" },
  }[speaker];
}

function renderRooms() {
  roomList.replaceChildren();
  for (const room of [...state.rooms].sort((a, b) => b.createdAt - a.createdAt)) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = room.title;
    button.className = room.id === activeRoomId ? "active" : "";
    button.addEventListener("click", () => {
      activeRoomId = room.id;
      saveState();
      render();
      sidebar.classList.remove("open");
    });
    roomList.append(button);
  }
}

function renderMessage(message) {
  const info = speakerInfo(message.speaker);
  const node = messageTemplate.content.firstElementChild.cloneNode(true);
  node.classList.add(message.speaker);
  if (message.error) node.classList.add("error");
  const avatar = node.querySelector(".message-avatar");
  avatar.classList.add(info.className);
  avatar.textContent = info.avatar;
  node.querySelector("strong").textContent = info.label;
  node.querySelector("time").textContent = formatTime(message.timestamp);
  node.querySelector(".message-text").textContent = message.text;
  return node;
}

function renderTyping(agent) {
  const info = speakerInfo(agent);
  const node = messageTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.typing = agent;
  const avatar = node.querySelector(".message-avatar");
  avatar.classList.add(info.className);
  avatar.textContent = info.avatar;
  node.querySelector("strong").textContent = info.label;
  node.querySelector("time").textContent = "正在思考";
  const text = node.querySelector(".message-text");
  text.innerHTML = '<span class="typing" aria-label="正在输入"><i></i><i></i><i></i></span>';
  return node;
}

function addCrossExamineAction(room) {
  const latestCodex = [...room.messages].reverse().find((message) => message.speaker === "codex" && !message.error);
  const latestHermes = [...room.messages].reverse().find((message) => message.speaker === "hermes" && !message.error);
  if (!latestCodex || !latestHermes || pending.size) return;

  const wrap = document.createElement("div");
  wrap.className = "round-action";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "让他们互相回应";
  button.addEventListener("click", () => runCrossExamination(latestCodex, latestHermes));
  wrap.append(button);
  conversation.append(wrap);
}

function renderConversation() {
  const room = activeRoom();
  conversation.replaceChildren();

  const banner = document.createElement("section");
  banner.className = "topic-banner";
  const kicker = document.createElement("span");
  kicker.textContent = "本期话题";
  const heading = document.createElement("h2");
  heading.textContent = room.topic;
  const description = document.createElement("p");
  description.textContent = room.messages.length ? "你可以随时插话、点名，或让两位参与者继续交锋。" : "Codex 与 Hermes 会先独立思考，再交换观点。";
  banner.append(kicker, heading, description);
  conversation.append(banner);

  if (!room.messages.length) {
    const systemMessage = renderMessage({
      speaker: "system",
      text: "房间已经准备好。点击“开始首轮”，让两位参与者独立表达观点。",
      timestamp: Date.now(),
    });
    conversation.append(systemMessage);
    const wrap = document.createElement("div");
    wrap.className = "round-action";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "开始首轮";
    button.addEventListener("click", startFirstRound);
    wrap.append(button);
    conversation.append(wrap);
  } else {
    room.messages.forEach((message) => conversation.append(renderMessage(message)));
  }

  for (const agent of pending) conversation.append(renderTyping(agent));
  addCrossExamineAction(room);
}

function render() {
  const room = activeRoom();
  activeRoomId = room.id;
  roomTitle.textContent = room.title;
  renderRooms();
  renderConversation();
  sendButton.disabled = pending.size > 0;
}

function scrollToBottom() {
  requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }));
}

function contextFor(room) {
  return room.messages
    .filter((message) => !message.error)
    .slice(-10)
    .map((message) => ({ speaker: speakerInfo(message.speaker).label, text: message.text }));
}

async function askAgent(agent, message, context) {
  const room = activeRoom();
  pending.add(agent);
  render();
  scrollToBottom();

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent,
        topic: room.topic,
        message,
        context,
        sessionId: room.sessions[agent],
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `${agent} 暂时无法回复`);
    room.sessions[agent] = data.sessionId || room.sessions[agent];
    room.messages.push({ speaker: agent, text: data.response, timestamp: Date.now() });
  } catch (error) {
    room.messages.push({
      speaker: agent,
      text: `连接失败：${error.message}`,
      timestamp: Date.now(),
      error: true,
    });
  } finally {
    pending.delete(agent);
    saveState();
    render();
    scrollToBottom();
  }
}

async function sendToAgents(message, selectedTarget = target) {
  const room = activeRoom();
  if (isStaticPreview) {
    room.messages.push({
      speaker: "system",
      text: "GitHub Pages 仅提供界面预览。要连接你本机的 Codex 和 Hermes，请在项目目录运行 npm start。",
      timestamp: Date.now(),
      error: true,
    });
    saveState();
    render();
    return;
  }
  const context = contextFor(room);
  const agents = selectedTarget === "all" ? ["codex", "hermes"] : [selectedTarget];
  await Promise.all(agents.map((agent) => askAgent(agent, message, context)));
}

async function startFirstRound() {
  const room = activeRoom();
  const text = `我们来讨论“${room.topic}”。请先独立给出你的核心判断、理由，以及你认为最容易被忽略的一点。`;
  room.messages.push({ speaker: "user", text, timestamp: Date.now() });
  saveState();
  render();
  await sendToAgents(text, "all");
}

async function runCrossExamination(codexMessage, hermesMessage) {
  const room = activeRoom();
  const text = "请阅读另一位参与者的最新观点，指出你最认同和最不同意的部分，再修正或加强自己的立场。";
  room.messages.push({ speaker: "user", text, timestamp: Date.now() });
  const shared = contextFor(room);
  saveState();
  render();
  await Promise.all([
    askAgent("codex", `${text}\n\nHermes 的观点：${hermesMessage.text}`, shared),
    askAgent("hermes", `${text}\n\nCodex 的观点：${codexMessage.text}`, shared),
  ]);
}

async function submitMessage() {
  const text = input.value.trim();
  if (!text || pending.size) return;
  const room = activeRoom();
  room.messages.push({ speaker: "user", text, timestamp: Date.now() });
  input.value = "";
  resizeInput();
  saveState();
  render();
  await sendToAgents(text);
}

function resizeInput() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

function openTopicDialog({ editing = false } = {}) {
  topicDialog.dataset.editing = editing ? "true" : "false";
  topicInput.value = editing ? activeRoom().topic : "";
  topicDialog.showModal();
  requestAnimationFrame(() => topicInput.focus());
}

topicForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const topic = topicInput.value.trim();
  if (!topic) return;

  if (topicDialog.dataset.editing === "true") {
    const room = activeRoom();
    room.topic = topic;
    room.title = topic;
  } else {
    const room = makeRoom(topic);
    state.rooms.push(room);
    activeRoomId = room.id;
  }
  saveState();
  topicDialog.close();
  render();
});

document.querySelector("#new-room-button").addEventListener("click", () => openTopicDialog());
document.querySelector("#edit-topic-button").addEventListener("click", () => openTopicDialog({ editing: true }));
document.querySelector("#cancel-dialog").addEventListener("click", () => topicDialog.close());
document.querySelector("#mobile-menu").addEventListener("click", () => sidebar.classList.toggle("open"));
document.querySelectorAll(".topic-suggestions button").forEach((button) => {
  button.addEventListener("click", () => {
    topicInput.value = button.textContent;
    topicInput.focus();
  });
});

document.querySelectorAll(".target-tab").forEach((button) => {
  button.addEventListener("click", () => {
    target = button.dataset.target;
    document.querySelectorAll(".target-tab").forEach((item) => item.classList.toggle("active", item === button));
    input.focus();
  });
});

input.addEventListener("input", resizeInput);
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submitMessage();
  }
});
sendButton.addEventListener("click", submitMessage);

async function loadStatus() {
  if (isStaticPreview) {
    for (const agent of ["codex", "hermes"]) {
      document.querySelector(`#${agent}-dot`).classList.add("preview");
      document.querySelector(`#${agent}-version`).textContent = "需本机运行";
    }
    return;
  }
  try {
    const response = await fetch("/api/status");
    const status = await response.json();
    for (const agent of ["codex", "hermes"]) {
      const dot = document.querySelector(`#${agent}-dot`);
      const version = document.querySelector(`#${agent}-version`);
      dot.classList.add(status[agent].online ? "online" : "offline");
      version.textContent = status[agent].version || "未连接";
      version.title = status[agent].version || "未连接";
    }
  } catch {
    document.querySelectorAll(".status-dot").forEach((dot) => dot.classList.add("offline"));
  }
}

render();
loadStatus();

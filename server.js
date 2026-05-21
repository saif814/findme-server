const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 20000,
  pingInterval: 10000,
});

app.use(cors());
app.get("/", (req, res) => res.send("FindMe server is running."));
app.get("/health", (req, res) => res.json({ ok: true, rooms: Object.keys(rooms).length }));

const rooms = {};

function sanitize(str, max = 32) {
  if (typeof str !== "string") return "Anonymous";
  return str.replace(/[<>"\/]/g, "").trim().slice(0, max) || "Anonymous";
}

function validateCode(code) {
  return typeof code === "string" && /^[A-Z]{3}-\d{3}$/.test(code);
}

function broadcastCount(code) {
  if (!rooms[code]) return;
  const guests = [...rooms[code].users.values()].filter(u => u.role === "guest").length;
  io.to(code).emit("room-count", { guests });
}

function broadcastUserList(code) {
  if (!rooms[code]) return;
  const users = [...rooms[code].users.values()].map(u => ({ username: u.username, role: u.role }));
  io.to(code).emit("user-list", { users });
}

io.on("connection", (socket) => {
  console.log("+ connected:", socket.id);

  socket.on("join-room", ({ code, role, username }) => {
    if (!validateCode(code)) { socket.emit("error-msg", { msg: "Invalid room code." }); return; }

    const name = sanitize(username);
    const safeRole = role === "host" ? "host" : "guest";

    if (safeRole === "guest" && !rooms[code]) { socket.emit("room-not-found"); return; }

    if (socket.roomCode && socket.roomCode !== code) {
      socket.leave(socket.roomCode);
      if (rooms[socket.roomCode]) {
        rooms[socket.roomCode].users.delete(socket.id);
        broadcastCount(socket.roomCode);
      }
    }

    socket.join(code);
    socket.roomCode = code;
    socket.username = name;
    socket.role = safeRole;

    if (!rooms[code]) rooms[code] = { hostId: socket.id, users: new Map(), lastUrl: null };

    rooms[code].users.set(socket.id, { username: name, role: safeRole });

    if (safeRole === "host") {
      rooms[code].hostId = socket.id;
      console.log("HOST " + name + " created room " + code);
    } else {
      console.log("GUEST " + name + " joined room " + code);
      socket.to(code).emit("guest-joined", { username: name });
      if (rooms[code].lastUrl) {
        socket.emit("tab-sync", { url: rooms[code].lastUrl, username: socket.username });
      }
    }

    broadcastCount(code);
    broadcastUserList(code);
  });

  socket.on("tab-sync", ({ url }) => {
    if (socket.role !== "host" || !socket.roomCode) return;
    if (typeof url !== "string" || !url.startsWith("http")) return;
    const safeUrl = url.slice(0, 500);
    if (rooms[socket.roomCode]) rooms[socket.roomCode].lastUrl = safeUrl;
    socket.to(socket.roomCode).emit("tab-sync", { url: safeUrl, username: socket.username });
  });

  socket.on("scroll-sync", ({ x, y }) => {
    if (socket.role !== "host" || !socket.roomCode) return;
    if (typeof x !== "number" || typeof y !== "number") return;
    socket.to(socket.roomCode).emit("scroll-sync", { x, y });
  });

  socket.on("search_sync", ({ query }) => {
    if (socket.role !== "host" || !socket.roomCode) return;
    socket.to(socket.roomCode).emit("search_sync", {
      query: typeof query === "string" ? query.slice(0, 100) : "",
    });
  });

  socket.on("scroll_section", ({ secId }) => {
    if (socket.role !== "host" || !socket.roomCode) return;
    if (typeof secId !== "string") return;
    socket.to(socket.roomCode).emit("scroll_section", { secId: secId.slice(0, 40) });
  });

  socket.on("chat", ({ text }) => {
    if (!socket.roomCode || !socket.username) return;
    const safe = typeof text === "string" ? text.trim().slice(0, 300) : "";
    if (!safe) return;
    socket.to(socket.roomCode).emit("chat", { text: safe, username: socket.username, role: socket.role });
  });

  socket.on("typing", () => {
    if (!socket.roomCode) return;
    socket.to(socket.roomCode).emit("typing", { username: socket.username });
  });

  socket.on("room_closed", () => {
    if (socket.role !== "host" || !socket.roomCode) return;
    socket.to(socket.roomCode).emit("room_closed");
    delete rooms[socket.roomCode];
  });

  socket.on("disconnect", (reason) => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    rooms[code].users.delete(socket.id);
    if (rooms[code].hostId === socket.id) {
      socket.to(code).emit("room_closed");
      delete rooms[code];
    } else {
      socket.to(code).emit("guest-left", { username: socket.username });
      broadcastCount(code);
      broadcastUserList(code);
      if (rooms[code] && rooms[code].users.size === 0) delete rooms[code];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("FindMe server on port " + PORT));
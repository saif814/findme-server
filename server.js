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

// rooms[code] = { hostId, users: Map<socketId, { username, role }> }
const rooms = {};

function sanitize(str, maxLen = 32) {
  if (typeof str !== "string") return "Anonymous";
  return str.replace(/[<>"/]/g, "").trim().slice(0, maxLen) || "Anonymous";
}

function validateCode(code) {
  return typeof code === "string" && /^[A-Z]{3}-\d{3}$/.test(code);
}

function roomCount(code) {
  return io.sockets.adapter.rooms.get(code)?.size || 0;
}

function broadcastCount(code) {
  const guests = rooms[code]
    ? [...rooms[code].users.values()].filter(u => u.role === "guest").length
    : 0;
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
    if (!validateCode(code)) {
      socket.emit("error-msg", { msg: "Invalid room code." });
      return;
    }

    const name = sanitize(username);
    const safeRole = role === "host" ? "host" : "guest";

    // if guest joining a room that doesn't exist yet, reject
    if (safeRole === "guest" && !rooms[code]) {
      socket.emit("room-not-found");
      return;
    }

    // leave any old room first (handles reconnects / tab duplicates)
    if (socket.roomCode && socket.roomCode !== code) {
      socket.leave(socket.roomCode);
      if (rooms[socket.roomCode]) {
        rooms[socket.roomCode].users.delete(socket.id);
        broadcastCount(socket.roomCode);
        broadcastUserList(socket.roomCode);
      }
    }

    socket.join(code);
    socket.roomCode = code;
    socket.username = name;
    socket.role = safeRole;

    if (!rooms[code]) {
      rooms[code] = { hostId: socket.id, users: new Map() };
    }

    rooms[code].users.set(socket.id, { username: name, role: safeRole });

    if (safeRole === "host") {
      rooms[code].hostId = socket.id;
      console.log(`HOST "${name}" created room ${code}`);
    } else {
      console.log(`GUEST "${name}" joined room ${code}`);
      socket.to(code).emit("guest-joined", { username: name });
    }

    broadcastCount(code);
    broadcastUserList(code);
  });

  socket.on("navigate", (data) => {
    if (socket.role !== "host" || !socket.roomCode) return;
    if (typeof data.url !== "string" || typeof data.name !== "string") return;
    socket.to(socket.roomCode).emit("navigate", {
      url: data.url.slice(0, 500),
      name: data.name.slice(0, 100),
      username: socket.username,
    });
  });

  socket.on("close_viewer", () => {
    if (socket.role !== "host" || !socket.roomCode) return;
    socket.to(socket.roomCode).emit("close_viewer");
  });

  socket.on("scroll_section", (data) => {
    if (socket.role !== "host" || !socket.roomCode) return;
    if (typeof data.secId !== "string") return;
    socket.to(socket.roomCode).emit("scroll_section", { secId: data.secId.slice(0, 40) });
  });

  socket.on("search_sync", (data) => {
    if (socket.role !== "host" || !socket.roomCode) return;
    socket.to(socket.roomCode).emit("search_sync", {
      query: typeof data.query === "string" ? data.query.slice(0, 100) : "",
    });
  });

  socket.on("chat", (data) => {
    if (!socket.roomCode || !socket.username) return;
    const text = typeof data.text === "string" ? data.text.trim().slice(0, 300) : "";
    if (!text) return;
    socket.to(socket.roomCode).emit("chat", {
      text,
      username: socket.username,
      role: socket.role,
    });
  });

  socket.on("typing", () => {
    if (!socket.roomCode) return;
    socket.to(socket.roomCode).emit("typing", { username: socket.username });
  });

  socket.on("room_closed", () => {
    if (socket.role !== "host" || !socket.roomCode) return;
    socket.to(socket.roomCode).emit("room_closed");
    delete rooms[socket.roomCode];
    console.log(`Room ${socket.roomCode} closed by host`);
  });

  socket.on("disconnect", (reason) => {
    console.log(`- disconnected: ${socket.id} (${reason})`);
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;

    rooms[code].users.delete(socket.id);

    if (rooms[code].hostId === socket.id) {
      socket.to(code).emit("room_closed");
      delete rooms[code];
      console.log(`Room ${code} destroyed — host left`);
    } else {
      socket.to(code).emit("guest-left", { username: socket.username });
      broadcastCount(code);
      broadcastUserList(code);

      // clean up empty rooms
      if (rooms[code] && rooms[code].users.size === 0) {
        delete rooms[code];
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`FindMe server on port ${PORT}`));
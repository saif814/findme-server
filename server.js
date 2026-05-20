const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());

app.get("/", (req, res) => {
  res.send("FindMe server is running.");
});

// track which socket is the host of which room
const roomHosts = {};

io.on("connection", (socket) => {
  console.log("connected:", socket.id);

  // both host and guest emit this to enter a room
  socket.on("join-room", ({ code, role }) => {
    socket.join(code);
    socket.roomCode = code;
    socket.role = role;

    if (role === "host") {
      roomHosts[code] = socket.id;
      console.log(`host ${socket.id} created room ${code}`);
    } else {
      console.log(`guest ${socket.id} joined room ${code}`);
      // tell the host someone joined
      socket.to(code).emit("guest-joined");
    }

    // send back count of people in the room
    const count = io.sockets.adapter.rooms.get(code)?.size || 0;
    io.to(code).emit("room-count", { count });
  });

  // host navigated to a site — relay to all guests in room
  socket.on("navigate", (data) => {
    socket.to(socket.roomCode).emit("navigate", data);
  });

  // host closed the viewer — guests close theirs
  socket.on("close_viewer", () => {
    socket.to(socket.roomCode).emit("close_viewer");
  });

  // host scrolled to a section — guests scroll too
  socket.on("scroll_section", (data) => {
    socket.to(socket.roomCode).emit("scroll_section", data);
  });

  // host typed in search — guests see same results
  socket.on("search_sync", (data) => {
    socket.to(socket.roomCode).emit("search_sync", data);
  });

  // chat message — relay to everyone else in the room
  socket.on("chat", (data) => {
    socket.to(socket.roomCode).emit("chat", data);
  });

  // host stopped the stream — kick all guests back to lobby
  socket.on("room_closed", () => {
    socket.to(socket.roomCode).emit("room_closed");
    delete roomHosts[socket.roomCode];
  });

  socket.on("disconnect", () => {
    console.log("disconnected:", socket.id);
    const code = socket.roomCode;
    if (!code) return;

    // if the host disconnected, tell guests the room is gone
    if (roomHosts[code] === socket.id) {
      socket.to(code).emit("room_closed");
      delete roomHosts[code];
    }

    // update count for remaining people
    setTimeout(() => {
      const count = io.sockets.adapter.rooms.get(code)?.size || 0;
      io.to(code).emit("room-count", { count });
    }, 200);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`FindMe server running on port ${PORT}`);
});

import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import connectDB from "./connectDb.js";
import { User, Chat, Message } from "./chat.model.js";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

app.use(express.json());

// CORS cho Express HTTP endpoints
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept"
  );
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

// ================== REST APIs ==================

// Đăng ký user - client gửi username + publicKey + encrypted backup
app.post("/api/register", async (req, res) => {
  try {
    const {
      username,
      publicKey,
      encryptedPrivateKey,
      privateKeyNonce,
      kdfSalt,
      kdfParams,
    } = req.body;

    if (!username || !publicKey) {
      return res
        .status(400)
        .json({ error: "Username và publicKey là bắt buộc" });
    }

    // Kiểm tra user đã tồn tại
    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(400).json({ error: "Username đã tồn tại" });
    }

    const user = new User({
      username,
      publicKey,
      encryptedPrivateKey: encryptedPrivateKey || null,
      privateKeyNonce: privateKeyNonce || null,
      kdfSalt: kdfSalt || null,
      kdfParams: kdfParams || undefined,
    });
    await user.save();

    res.status(201).json({
      message: "Đăng ký thành công",
      user: {
        _id: user._id,
        username: user.username,
        publicKey: user.publicKey,
        hasBackup: !!user.encryptedPrivateKey,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Lấy danh sách users (để chọn người chat)
app.get("/api/users", async (req, res) => {
  try {
    const users = await User.find({}, "username publicKey");
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Lấy thông tin 1 user (lấy publicKey để trao đổi khóa)
app.get("/api/user/:id", async (req, res) => {
  try {
    const user = await User.findById(req.params.id, "username publicKey");
    if (!user) {
      return res.status(404).json({ error: "User không tồn tại" });
    }
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Login - lấy user theo username
app.get("/api/user/by-username/:username", async (req, res) => {
  try {
    const user = await User.findOne(
      { username: req.params.username },
      "username publicKey"
    );
    if (!user) {
      return res.status(404).json({ error: "User không tồn tại" });
    }
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get encrypted private key for recovery on new device
app.get("/api/user/:username/encrypted-key", async (req, res) => {
  try {
    const user = await User.findOne(
      { username: req.params.username },
      "encryptedPrivateKey privateKeyNonce kdfSalt kdfParams publicKey"
    );

    if (!user) {
      return res.status(404).json({ error: "User không tồn tại" });
    }

    if (!user.encryptedPrivateKey) {
      return res.status(404).json({ error: "No backup key found" });
    }

    res.json({
      encryptedPrivateKey: user.encryptedPrivateKey,
      privateKeyNonce: user.privateKeyNonce,
      kdfSalt: user.kdfSalt,
      kdfParams: user.kdfParams,
      publicKey: user.publicKey,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Tạo hoặc lấy cuộc chat giữa 2 người
app.post("/api/chat/create", async (req, res) => {
  try {
    const { participantIds } = req.body;

    if (!participantIds || participantIds.length !== 2) {
      return res.status(400).json({ error: "Cần đúng 2 participants" });
    }

    // Tìm chat đã tồn tại giữa 2 người
    let chat = await Chat.findOne({
      participants: { $all: participantIds },
    }).populate("participants", "username publicKey");

    if (!chat) {
      chat = new Chat({
        participants: participantIds,
      });
      await chat.save();
      // Populate participants sau khi save
      await chat.populate("participants", "username publicKey");
    }

    res.json(chat);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// SharedKey APIs đã được loại bỏ
// SharedKey bây giờ được derive on-the-fly từ nacl.box.before(theirPubKey, myPrivKey)
// Xem: Signal Protocol, X3DH

// Lấy tin nhắn của chat (encrypted) - với cursor-based pagination
app.get("/api/chat/:chatId/messages", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const cursor = req.query.cursor; // MessageId để làm điểm bắt đầu

    const query = { chatId: req.params.chatId };

    // 🔄 Cursor-based pagination: Nếu có cursor, lấy messages cũ hơn cursor đó
    if (cursor) {
      query._id = { $lt: cursor }; // Lấy messages có _id < cursor (cũ hơn)
    }

    // ⚡ Query với index: { chatId: 1, _id: -1 }
    // Lấy tin nhắn mới nhất trước, sort theo _id giảm dần
    const messages = await Message.find(query)
      .sort({ _id: -1 }) // Sort theo _id (có timestamp embedded) thay vì timestamp
      .limit(limit + 1) // Lấy thêm 1 để check hasMore
      .populate("senderId", "username")
      .lean(); // .lean() để performance tốt hơn (không tạo Mongoose document)

    // Check hasMore
    const hasMore = messages.length > limit;
    if (hasMore) {
      messages.pop(); // Bỏ message thừa
    }

    // nextCursor là _id của message cuối cùng
    const nextCursor =
      messages.length > 0 ? messages[messages.length - 1]._id : null;

    res.json({
      messages,
      hasMore,
      nextCursor, // Client dùng nextCursor để load trang tiếp theo
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 👥 Lấy tin nhắn của một user cụ thể (across all chats)
app.get("/api/user/:userId/messages", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const cursor = req.query.cursor;

    const query = { senderId: req.params.userId };

    if (cursor) {
      query._id = { $lt: cursor };
    }

    // ⚡ Dùng index: { senderId: 1 }
    const messages = await Message.find(query)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .populate("senderId", "username")
      .populate("chatId", "participants")
      .lean();

    const hasMore = messages.length > limit;
    if (hasMore) {
      messages.pop();
    }

    const nextCursor =
      messages.length > 0 ? messages[messages.length - 1]._id : null;

    res.json({
      messages,
      hasMore,
      nextCursor,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ================== SOCKET.IO ==================

io.on("connection", (socket) => {
  console.log("🔌 User connected:", socket.id);

  // User join room với userId
  socket.on("join", (userId) => {
    socket.join(userId);
    console.log(`👤 User ${userId} joined their room`);
  });

  // Join chat room
  socket.on("join_chat", (chatId) => {
    socket.join(chatId);
    console.log(`💬 Socket ${socket.id} joined chat ${chatId}`);
  });

  // Gửi tin nhắn (encrypted) - server chỉ lưu & chuyển tiếp
  socket.on("send_message", async (data) => {
    try {
      const { chatId, senderId, encryptedContent, nonce, messageCounter } =
        data;

      // Lưu tin nhắn vào DB
      const message = new Message({
        chatId,
        senderId,
        encryptedContent,
        nonce,
        messageCounter,
      });
      await message.save();

      // Populate sender info
      await message.populate("senderId", "username");

      // Broadcast to chat room
      io.to(chatId).emit("receive_message", message);

      console.log(`📨 Message saved & broadcasted to chat ${chatId}`);
    } catch (error) {
      console.error("Error sending message:", error);
      socket.emit("error", { message: error.message });
    }
  });

  // key_exchange socket event đã được loại bỏ
  // SharedKey bây giờ được derive on-the-fly từ nacl.box.before()

  socket.on("disconnect", () => {
    console.log("❌ User disconnected:", socket.id);
  });
});

// ================== START SERVER ==================

const PORT = process.env.PORT || 4000;

connectDB().then(() => {
  httpServer.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
  });
});

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

// Đăng ký user - client gửi username + publicKey (đã sinh ở client)
app.post("/api/register", async (req, res) => {
  try {
    const { username, publicKey } = req.body;

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

    const user = new User({ username, publicKey });
    await user.save();

    res.status(201).json({
      message: "Đăng ký thành công",
      user: {
        _id: user._id,
        username: user.username,
        publicKey: user.publicKey,
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
    });

    if (!chat) {
      chat = new Chat({
        participants: participantIds,
        encryptedKeys: [],
        counters: participantIds.map((id) => ({ oderId: id, count: 0 })),
      });
      await chat.save();
    }

    res.json(chat);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Lưu encrypted sharedKey (client gửi, server chỉ lưu)
app.post("/api/chat/:chatId/key", async (req, res) => {
  try {
    const { chatId } = req.params;
    const { recipientId, senderId, encryptedSharedKey, nonce } = req.body;

    const chat = await Chat.findById(chatId);
    if (!chat) {
      return res.status(404).json({ error: "Chat không tồn tại" });
    }

    // Thêm encrypted key vào chat
    chat.encryptedKeys.push({
      recipientId,
      senderId,
      encryptedSharedKey,
      nonce,
    });
    await chat.save();

    // Thông báo cho recipient qua socket
    io.to(recipientId).emit("key_received", {
      chatId,
      senderId,
      encryptedSharedKey,
      nonce,
    });

    res.json({ message: "Key đã được lưu và gửi" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Lấy encrypted key cho user trong chat
app.get("/api/chat/:chatId/key/:userId", async (req, res) => {
  try {
    const { chatId, userId } = req.params;

    const chat = await Chat.findById(chatId);
    if (!chat) {
      return res.status(404).json({ error: "Chat không tồn tại" });
    }

    // Tìm key mà user có thể dùng:
    // - Nếu user là recipientId: key do người khác gửi cho mình
    // - Nếu user là senderId: key do mình tạo (trường hợp user tạo key và cần lấy lại)
    let keyData = chat.encryptedKeys.find(
      (k) => k.recipientId.toString() === userId
    );

    // Nếu không tìm thấy key cho user này là recipient,
    // thử tìm key mà user này đã tạo (là sender)
    if (!keyData) {
      keyData = chat.encryptedKeys.find(
        (k) => k.senderId.toString() === userId
      );

      // Nếu tìm thấy key mà user là sender, user cần dùng sharedKey gốc
      // (không cần decrypt vì đây là người tạo key)
      if (keyData) {
        // Return về để frontend biết đây là key mà mình đã tạo
        return res.json({
          ...keyData.toObject(),
          isSender: true, // Flag để frontend biết đây là key mình tạo
        });
      }
    }

    if (!keyData) {
      return res.status(404).json({ error: "Chưa có key cho user này" });
    }

    res.json({ ...keyData.toObject(), isSender: false });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

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

  // Trao đổi key - forward encrypted key đến recipient
  socket.on("key_exchange", async (data) => {
    const { chatId, recipientId, senderId, encryptedSharedKey, nonce } = data;

    try {
      // Lưu vào DB
      const chat = await Chat.findById(chatId);
      if (chat) {
        // Kiểm tra đã có key cho recipient chưa
        const existingKey = chat.encryptedKeys.find(
          (k) => k.recipientId.toString() === recipientId
        );

        if (!existingKey) {
          chat.encryptedKeys.push({
            recipientId,
            senderId,
            encryptedSharedKey,
            nonce,
          });
          await chat.save();
        }
      }

      // Forward to recipient
      io.to(recipientId).emit("key_received", {
        chatId,
        senderId,
        encryptedSharedKey,
        nonce,
      });

      console.log(`🔑 Key exchanged: ${senderId} -> ${recipientId}`);
    } catch (error) {
      console.error("Key exchange error:", error);
    }
  });

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

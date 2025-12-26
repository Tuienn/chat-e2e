import mongoose from "mongoose";

// User Schema - lưu publicKey để trao đổi khóa
const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
  },
  publicKey: {
    type: String, // Base64 encoded nacl.box.keyPair().publicKey
    required: true,
  },
  // Password-derived key backup fields
  encryptedPrivateKey: {
    type: String, // Base64 - Private key encrypted by Master Key (derived from password)
    default: null,
  },
  privateKeyNonce: {
    type: String, // Base64 - Nonce for nacl.secretbox encryption
    default: null,
  },
  kdfSalt: {
    type: String, // Base64 - Salt for KDF (32 bytes)
    default: null,
  },
  kdfParams: {
    algorithm: { type: String, default: "pbkdf2" },
    iterations: { type: Number, default: 600000 },
    hash: { type: String, default: "SHA-256" },
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// 📌 Note: username đã có unique: true nên tự động có index, không cần thêm

// Chat Schema - cuộc hội thoại giữa 2 người
// SharedKey sẽ được derive on-the-fly từ nacl.box.before(theirPubKey, myPrivKey)
// Không lưu encryptedKeys → giảm attack surface, giống Signal/WhatsApp
const chatSchema = new mongoose.Schema({
  participants: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  ],
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// 📌 Index cho query chat theo participants
// Tìm chat giữa 2 người - dùng $all
chatSchema.index({ participants: 1 });

// Message Schema - tin nhắn đã mã hóa
const messageSchema = new mongoose.Schema({
  chatId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Chat",
    required: true,
  },
  senderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  // Server chỉ lưu ciphertext, không biết nội dung
  encryptedContent: {
    type: String, // nacl.secretbox encrypted (base64)
    required: true,
  },
  nonce: {
    type: String, // random(16) + counter(8) = 24 bytes (base64)
    required: true,
  },
  // Counter để tracking & đảm bảo không reuse nonce
  messageCounter: {
    type: Number,
    required: true,
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
});

// 📌 Compound Index cho query message theo chatId + sắp xếp theo timestamp
// Query pattern: find({ chatId }).sort({ timestamp: -1 })
messageSchema.index({ chatId: 1, timestamp: -1 });

// 📌 Index riêng cho senderId (để query messages của 1 user)
messageSchema.index({ senderId: 1 });

// 📌 Index cho cursor-based pagination: chatId + _id
// Dùng _id làm cursor vì MongoDB tự động tạo _id có timestamp embedded
messageSchema.index({ chatId: 1, _id: -1 });

export const User = mongoose.model("User", userSchema);
export const Chat = mongoose.model("Chat", chatSchema);
export const Message = mongoose.model("Message", messageSchema);

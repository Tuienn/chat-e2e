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
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Chat Schema - cuộc hội thoại giữa 2 người
const chatSchema = new mongoose.Schema({
  participants: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  ],
  // encryptedKeys: lưu sharedKey đã mã hóa cho từng participant
  // Client tạo, server chỉ lưu & chuyển tiếp
  encryptedKeys: [
    {
      recipientId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
      senderId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
      encryptedSharedKey: String, // nacl.box encrypted (base64)
      nonce: String, // base64
    },
  ],
  // messageCounter cho mỗi participant để tạo nonce
  counters: [
    {
      oderId: mongoose.Schema.Types.ObjectId,
      count: { type: Number, default: 0 },
    },
  ],
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

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

export const User = mongoose.model("User", userSchema);
export const Chat = mongoose.model("Chat", chatSchema);
export const Message = mongoose.model("Message", messageSchema);

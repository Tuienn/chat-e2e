import { useState, useEffect, useRef, useCallback } from "react";
import { io } from "socket.io-client";
import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";

// ==================== CONFIG ====================
const API_URL = "http://localhost:4000/api";
const SOCKET_URL = "http://localhost:4000";

// ==================== CRYPTO FUNCTIONS ====================

// Sinh key pair bất đối xứng (Curve25519)
function generateKeyPair() {
  const keyPair = nacl.box.keyPair();
  return {
    publicKey: naclUtil.encodeBase64(keyPair.publicKey),
    secretKey: naclUtil.encodeBase64(keyPair.secretKey),
    raw: keyPair,
  };
}

// Tạo nonce = random(16 bytes) + counter(8 bytes) = 24 bytes
function createNonce(counter) {
  const nonce = new Uint8Array(24);
  const randomPart = nacl.randomBytes(16);
  nonce.set(randomPart, 0);
  const counterBytes = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    counterBytes[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  nonce.set(counterBytes, 16);
  return nonce;
}

// Sinh shared key ngẫu nhiên (32 bytes)
function generateSharedKey() {
  return nacl.randomBytes(32);
}

// Mã hóa sharedKey bằng nacl.box
function encryptSharedKey(sharedKeyBytes, recipientPublicKey, mySecretKey) {
  const nonce = nacl.randomBytes(24);
  const recipientPubKeyBytes = naclUtil.decodeBase64(recipientPublicKey);
  const mySecretKeyBytes = naclUtil.decodeBase64(mySecretKey);
  const encrypted = nacl.box(
    sharedKeyBytes,
    nonce,
    recipientPubKeyBytes,
    mySecretKeyBytes
  );
  return {
    encryptedSharedKey: naclUtil.encodeBase64(encrypted),
    nonce: naclUtil.encodeBase64(nonce),
  };
}

// Giải mã sharedKey
function decryptSharedKey(
  encryptedBase64,
  nonceBase64,
  senderPublicKey,
  mySecretKey
) {
  const encrypted = naclUtil.decodeBase64(encryptedBase64);
  const nonce = naclUtil.decodeBase64(nonceBase64);
  const senderPubKeyBytes = naclUtil.decodeBase64(senderPublicKey);
  const mySecretKeyBytes = naclUtil.decodeBase64(mySecretKey);
  const decrypted = nacl.box.open(
    encrypted,
    nonce,
    senderPubKeyBytes,
    mySecretKeyBytes
  );
  if (!decrypted) throw new Error("Không thể giải mã sharedKey");
  return decrypted;
}

// Mã hóa tin nhắn bằng secretbox
function encryptMessage(message, sharedKeyBytes, counter) {
  const nonce = createNonce(counter);
  const messageBytes = naclUtil.decodeUTF8(message);
  const encrypted = nacl.secretbox(messageBytes, nonce, sharedKeyBytes);
  return {
    encryptedContent: naclUtil.encodeBase64(encrypted),
    nonce: naclUtil.encodeBase64(nonce),
  };
}

// Giải mã tin nhắn
function decryptMessage(encryptedBase64, nonceBase64, sharedKeyBytes) {
  const encrypted = naclUtil.decodeBase64(encryptedBase64);
  const nonce = naclUtil.decodeBase64(nonceBase64);
  const decrypted = nacl.secretbox.open(encrypted, nonce, sharedKeyBytes);
  if (!decrypted) throw new Error("Không thể giải mã tin nhắn");
  return naclUtil.encodeUTF8(decrypted);
}

// ==================== PASSWORD-DERIVED KEY FUNCTIONS ====================

// Generate random salt for KDF
function generateKdfSalt() {
  return nacl.randomBytes(32);
}

// Derive Master Key from password using PBKDF2 (Web Crypto API)
async function deriveKeyFromPassword(password, saltBytes) {
  const encoder = new TextEncoder();
  const passwordBytes = encoder.encode(password);

  // Import password as key material
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    passwordBytes,
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );

  // Derive 32 bytes using PBKDF2 with high iterations
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations: 600000, // High iterations for security
      hash: "SHA-256",
    },
    keyMaterial,
    256 // 32 bytes = 256 bits
  );

  return new Uint8Array(derivedBits);
}

// Encrypt private key with Master Key (derived from password)
function encryptPrivateKey(privateKeyBytes, masterKeyBytes) {
  const nonce = nacl.randomBytes(24);
  const encrypted = nacl.secretbox(privateKeyBytes, nonce, masterKeyBytes);
  return {
    encryptedPrivateKey: naclUtil.encodeBase64(encrypted),
    nonce: naclUtil.encodeBase64(nonce),
  };
}

// Decrypt private key with Master Key
function decryptPrivateKey(encryptedBase64, nonceBase64, masterKeyBytes) {
  const encrypted = naclUtil.decodeBase64(encryptedBase64);
  const nonce = naclUtil.decodeBase64(nonceBase64);
  const decrypted = nacl.secretbox.open(encrypted, nonce, masterKeyBytes);
  if (!decrypted)
    throw new Error("Sai password - không thể giải mã private key");
  return decrypted;
}

// ==================== MAIN APP ====================
function App() {
  // State
  const [step, setStep] = useState("register"); // register | users | chat
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [users, setUsers] = useState([]);
  const [chatPartner, setChatPartner] = useState(null);
  const [currentChat, setCurrentChat] = useState(null);
  const [messages, setMessages] = useState([]);
  const [messageInput, setMessageInput] = useState("");
  const [keyStatus, setKeyStatus] = useState("");
  const [debugLogs, setDebugLogs] = useState([]);

  // Pagination state - Cursor-based
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [nextCursor, setNextCursor] = useState(null); // Cursor cho trang tiếp theo

  // Refs
  const myKeyPairRef = useRef(null);
  const sharedKeyRef = useRef(null);
  const messageCounterRef = useRef(0);
  const socketRef = useRef(null);
  const chatBoxRef = useRef(null);

  // Debug logger
  const log = (msg, data = "") => {
    const time = new Date().toLocaleTimeString();
    const entry = `[${time}] ${msg} ${
      data ? JSON.stringify(data).substring(0, 80) : ""
    }`;
    setDebugLogs((prev) => [...prev.slice(-20), entry]);
  };

  // Auto scroll chat (only on initial load or new messages, not on load more)
  const shouldScrollToBottomRef = useRef(true);

  useEffect(() => {
    if (chatBoxRef.current && shouldScrollToBottomRef.current) {
      chatBoxRef.current.scrollTop = chatBoxRef.current.scrollHeight;
    }
  }, [messages]);

  // ==================== REGISTER ====================
  const register = async () => {
    if (!username.trim() || !password.trim()) {
      alert("Vui lòng nhập username và password");
      return;
    }
    if (password.length < 6) {
      alert("Password phải có ít nhất 6 ký tự");
      return;
    }

    try {
      setIsLoading(true);
      log("🔐 Đang tạo key và mã hóa với password...");

      // 1. Sinh key pair
      myKeyPairRef.current = generateKeyPair();
      log("🔑 Generated key pair");

      // 2. Generate KDF salt và derive Master Key từ password
      const kdfSalt = generateKdfSalt();
      const masterKey = await deriveKeyFromPassword(password, kdfSalt);
      log("🔐 Derived master key from password");

      // 3. Encrypt private key với Master Key
      const privateKeyBytes = naclUtil.decodeBase64(
        myKeyPairRef.current.secretKey
      );
      const { encryptedPrivateKey, nonce: privateKeyNonce } = encryptPrivateKey(
        privateKeyBytes,
        masterKey
      );
      log("🔒 Encrypted private key for backup");

      // 4. Gửi register request với encrypted backup
      const res = await fetch(`${API_URL}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: username.trim(),
          publicKey: myKeyPairRef.current.publicKey,
          encryptedPrivateKey,
          privateKeyNonce,
          kdfSalt: naclUtil.encodeBase64(kdfSalt),
          kdfParams: {
            algorithm: "pbkdf2",
            iterations: 600000,
            hash: "SHA-256",
          },
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        alert(data.error);
        return;
      }

      // 5. Lưu private key vào localStorage
      setCurrentUser(data.user);
      localStorage.setItem(
        `secretKey_${data.user._id}`,
        myKeyPairRef.current.secretKey
      );
      localStorage.setItem(`userId_${username.trim()}`, data.user._id);
      log("✅ Registered with encrypted key backup", { userId: data.user._id });

      // Connect socket
      connectSocket(data.user._id);
      setStep("users");
      setPassword(""); // Clear password from memory
      loadUsers();
    } catch (error) {
      log("❌ Register error", error.message);
      alert("Lỗi đăng ký: " + error.message);
    } finally {
      setIsLoading(false);
    }
  };

  // ==================== LOGIN ====================
  const login = async () => {
    if (!username.trim() || !password.trim()) {
      alert("Vui lòng nhập username và password");
      return;
    }

    try {
      setIsLoading(true);

      // 1. Kiểm tra có secretKey trong localStorage không
      const res = await fetch(`${API_URL}/user/by-username/${username.trim()}`);
      const userData = await res.json();

      if (!res.ok) {
        alert(userData.error || "User không tồn tại");
        return;
      }

      const secretKey = localStorage.getItem(`secretKey_${userData._id}`);

      if (secretKey) {
        // Case 1: Có localStorage -> sử dụng trực tiếp
        log("🔑 Found local key, logging in...");
        myKeyPairRef.current = {
          publicKey: userData.publicKey,
          secretKey: secretKey,
        };
        setCurrentUser(userData);
        log("✅ Logged in with local key", { userId: userData._id });
      } else {
        // Case 2: Không có localStorage -> Recovery từ server
        log("🔐 No local key, attempting recovery from server...");

        // Lấy encrypted key từ server
        const keyRes = await fetch(
          `${API_URL}/user/${username.trim()}/encrypted-key`
        );
        const keyData = await keyRes.json();

        if (!keyRes.ok) {
          alert(
            keyData.error ||
              "Không thể khôi phục key. Vui lòng đăng ký tài khoản mới."
          );
          return;
        }

        // Derive Master Key từ password
        log("🔐 Deriving master key from password...");
        const kdfSalt = naclUtil.decodeBase64(keyData.kdfSalt);
        const masterKey = await deriveKeyFromPassword(password, kdfSalt);

        // Decrypt private key
        try {
          const decryptedPrivateKey = decryptPrivateKey(
            keyData.encryptedPrivateKey,
            keyData.privateKeyNonce,
            masterKey
          );

          const recoveredSecretKey = naclUtil.encodeBase64(decryptedPrivateKey);

          // Lưu vào localStorage
          localStorage.setItem(`secretKey_${userData._id}`, recoveredSecretKey);
          localStorage.setItem(`userId_${username.trim()}`, userData._id);

          myKeyPairRef.current = {
            publicKey: keyData.publicKey,
            secretKey: recoveredSecretKey,
          };

          setCurrentUser(userData);
          log("✅ Recovered key from server backup", { userId: userData._id });
        } catch (decryptError) {
          log("❌ Key recovery failed", decryptError.message);
          alert("Sai password! Không thể khôi phục key.");
          return;
        }
      }

      // Connect socket
      connectSocket(userData._id);
      setStep("users");
      setPassword(""); // Clear password from memory
      loadUsers();
    } catch (error) {
      log("❌ Login error", error.message);
      alert("Lỗi đăng nhập: " + error.message);
    } finally {
      setIsLoading(false);
    }
  };

  // ==================== SOCKET ====================
  const connectSocket = (userId) => {
    socketRef.current = io(SOCKET_URL);

    socketRef.current.on("connect", () => {
      log("🔌 Socket connected");
      socketRef.current.emit("join", userId);
    });

    socketRef.current.on("key_received", async (data) => {
      console.log("🚀 ~ connectSocket ~ data:", data);
      log("🔑 Received encrypted key");
      // Will be handled when partner is set
    });

    socketRef.current.on("receive_message", (message) => {
      log("📨 Received encrypted", {
        content: message.encryptedContent?.substring(0, 20) + "...",
      });

      if (!sharedKeyRef.current) {
        log("⚠️ No sharedKey yet");
        return;
      }

      try {
        const plaintext = decryptMessage(
          message.encryptedContent,
          message.nonce,
          sharedKeyRef.current
        );
        const senderId = message.senderId._id || message.senderId;
        setMessages((prev) => [
          ...prev,
          {
            text: plaintext,
            sender: message.senderId.username || "Unknown",
            isMine: senderId === currentUser?._id,
            time: new Date(message.timestamp).toLocaleTimeString(),
          },
        ]);
        log("✅ Decrypted", { plaintext });
      } catch (error) {
        log("❌ Decrypt error", error.message);
      }
    });
  };

  // ==================== USERS ====================
  const loadUsers = async () => {
    try {
      const res = await fetch(`${API_URL}/users`);
      const data = await res.json();
      setUsers(data.filter((u) => u._id !== currentUser?._id));
      log("📋 Loaded users", data.length);
    } catch (error) {
      log("❌ Load users error", error.message);
    }
  };

  // ==================== START CHAT ====================
  const startChat = async (partner) => {
    setChatPartner(partner);
    log("💬 Starting chat with", partner.username);

    try {
      // Create/get chat
      const res = await fetch(`${API_URL}/chat/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          participantIds: [currentUser._id, partner._id],
        }),
      });

      const chat = await res.json();
      setCurrentChat(chat);
      socketRef.current.emit("join_chat", chat._id);
      log("📝 Chat created", { chatId: chat._id });

      // Check existing key
      const keyRes = await fetch(
        `${API_URL}/chat/${chat._id}/key/${currentUser._id}`
      );

      if (keyRes.ok) {
        const keyData = await keyRes.json();
        try {
          // Lấy public key của sender để decrypt
          const senderRes = await fetch(`${API_URL}/user/${keyData.senderId}`);
          const sender = await senderRes.json();

          sharedKeyRef.current = decryptSharedKey(
            keyData.encryptedSharedKey,
            keyData.nonce,
            sender.publicKey,
            myKeyPairRef.current.secretKey
          );
          setKeyStatus("🔐 Đã có sharedKey từ trước");
          log("✅ Loaded existing sharedKey");
        } catch (error) {
          log("⚠️ Cannot decrypt existing key, creating new", error.message);
          await createAndShareKey(chat._id, partner);
        }
      } else {
        await createAndShareKey(chat._id, partner);
      }

      // Reset pagination state
      setNextCursor(null);
      setHasMoreMessages(false);
      shouldScrollToBottomRef.current = true;

      setStep("chat");
      await loadMessages(chat._id, null, false);
    } catch (error) {
      log("❌ Start chat error", error.message);
    }
  };

  const createAndShareKey = async (chatId, partner) => {
    sharedKeyRef.current = generateSharedKey();
    log("🔑 Generated new sharedKey");

    // Mã hóa sharedKey cho partner (recipient)
    const partnerKey = encryptSharedKey(
      sharedKeyRef.current,
      partner.publicKey,
      myKeyPairRef.current.secretKey
    );

    // Mã hóa sharedKey cho chính mình (để có thể recover sau khi reload)
    const myKey = encryptSharedKey(
      sharedKeyRef.current,
      myKeyPairRef.current.publicKey,
      myKeyPairRef.current.secretKey
    );

    // Gửi key cho partner
    socketRef.current.emit("key_exchange", {
      chatId,
      recipientId: partner._id,
      senderId: currentUser._id,
      encryptedSharedKey: partnerKey.encryptedSharedKey,
      nonce: partnerKey.nonce,
    });

    // Lưu key cho chính mình
    socketRef.current.emit("key_exchange", {
      chatId,
      recipientId: currentUser._id,
      senderId: currentUser._id,
      encryptedSharedKey: myKey.encryptedSharedKey,
      nonce: myKey.nonce,
    });

    setKeyStatus("🔐 Đã tạo và gửi sharedKey");
    log("📤 Sent encrypted sharedKey cho cả 2 users");
  };

  // ==================== MESSAGES ====================
  // 🔄 Cursor-based pagination cho performance tốt hơn
  const loadMessages = async (chatId, cursor = null, isLoadingMore = false) => {
    if (loadingMessages) return;

    try {
      setLoadingMessages(true);
      const limit = 20;

      // Build URL with cursor-based pagination
      let url = `${API_URL}/chat/${chatId}/messages?limit=${limit}`;
      if (cursor) {
        url += `&cursor=${cursor}`;
      }

      const res = await fetch(url);
      const data = await res.json();

      const decryptedMessages = [];
      // Backend trả về descending (_id giảm dần), cần reverse để hiển thị đúng thứ tự
      const messagesArray = data.messages || [];
      const messagesReversed = [...messagesArray].reverse();

      for (const msg of messagesReversed) {
        if (sharedKeyRef.current) {
          try {
            const plaintext = decryptMessage(
              msg.encryptedContent,
              msg.nonce,
              sharedKeyRef.current
            );
            decryptedMessages.push({
              text: plaintext,
              sender: msg.senderId.username,
              isMine: msg.senderId._id === currentUser._id,
              time: new Date(msg.timestamp).toLocaleTimeString(),
            });
          } catch {
            log("⚠️ Cannot decrypt old message");
          }
        }
        if (msg.messageCounter >= messageCounterRef.current) {
          messageCounterRef.current = msg.messageCounter + 1;
        }
      }

      if (isLoadingMore) {
        // Prepend older messages
        setMessages((prev) => [...decryptedMessages, ...prev]);
      } else {
        // Initial load
        setMessages(decryptedMessages);
      }

      // Update pagination state
      setHasMoreMessages(data.hasMore || false);
      setNextCursor(data.nextCursor || null);

      log("📜 Loaded messages", {
        count: messagesReversed.length,
        hasMore: data.hasMore,
        cursor: cursor ? "with cursor" : "initial",
      });
    } catch (error) {
      log("❌ Load messages error", error.message);
    } finally {
      setLoadingMessages(false);
    }
  };

  const loadMoreMessages = useCallback(() => {
    if (currentChat && hasMoreMessages && !loadingMessages && nextCursor) {
      loadMessages(currentChat._id, nextCursor, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChat, hasMoreMessages, loadingMessages, nextCursor]);

  // Infinite scroll - load more when scrolling to top
  useEffect(() => {
    const chatBox = chatBoxRef.current;
    if (!chatBox) return;

    const handleScroll = () => {
      // If user scrolls to near top (within 50px)
      if (chatBox.scrollTop < 50 && hasMoreMessages && !loadingMessages) {
        // Save current scroll height to restore position
        const previousScrollHeight = chatBox.scrollHeight;
        shouldScrollToBottomRef.current = false;

        loadMoreMessages();

        // After messages load, restore scroll position
        setTimeout(() => {
          const newScrollHeight = chatBox.scrollHeight;
          chatBox.scrollTop = newScrollHeight - previousScrollHeight;
          shouldScrollToBottomRef.current = true;
        }, 100);
      }
    };

    chatBox.addEventListener("scroll", handleScroll);
    return () => chatBox.removeEventListener("scroll", handleScroll);
  }, [
    hasMoreMessages,
    loadingMessages,
    nextCursor,
    currentChat,
    loadMoreMessages,
  ]);

  const sendMessage = () => {
    if (!messageInput.trim() || !sharedKeyRef.current || !currentChat) return;

    const { encryptedContent, nonce } = encryptMessage(
      messageInput.trim(),
      sharedKeyRef.current,
      messageCounterRef.current
    );

    log("📤 Sending encrypted", { counter: messageCounterRef.current });

    socketRef.current.emit("send_message", {
      chatId: currentChat._id,
      senderId: currentUser._id,
      encryptedContent,
      nonce,
      messageCounter: messageCounterRef.current,
    });

    messageCounterRef.current++;
    setMessageInput("");
  };

  // ==================== RENDER ====================
  const styles = {
    container: {
      maxWidth: 800,
      margin: "20px auto",
      fontFamily: "Arial, sans-serif",
      padding: 20,
    },
    section: {
      border: "1px solid #ccc",
      padding: 15,
      margin: "10px 0",
      borderRadius: 8,
    },
    hidden: { display: "none" },
    input: {
      padding: "8px 12px",
      margin: 5,
      borderRadius: 4,
      border: "1px solid #ccc",
    },
    button: {
      padding: "8px 16px",
      margin: 5,
      background: "#007bff",
      color: "white",
      border: "none",
      borderRadius: 4,
      cursor: "pointer",
    },
    userItem: {
      padding: 10,
      margin: 5,
      background: "#181717ff",
      cursor: "pointer",
      borderRadius: 4,
    },
    chatBox: {
      height: 300,
      overflowY: "auto",
      border: "1px solid #ddd",
      padding: 10,
      margin: "10px 0",
      background: "#121111ff",
      borderRadius: 4,
    },
    messageSent: {
      padding: "8px 12px",
      margin: 5,
      background: "#1e1f1dff",
      textAlign: "right",
      borderRadius: 8,
    },
    messageReceived: {
      padding: "8px 12px",
      margin: 5,
      background: "#1d1c1cff",
      borderRadius: 8,
    },
    meta: { fontSize: 11, color: "#666" },
    debug: {
      background: "#0b0b0bff",
      fontFamily: "monospace",
      fontSize: 11,
      padding: 10,
      maxHeight: 150,
      overflowY: "auto",
      borderRadius: 4,
    },
  };

  return (
    <div style={styles.container}>
      <h1>🔐 E2E Chat Demo (React)</h1>

      {/* Step 1: Register or Login */}
      {step === "register" && (
        <div style={styles.section}>
          <h3>Bước 1: Đăng ký hoặc Đăng nhập</h3>
          <div style={{ marginBottom: 10 }}>
            <input
              style={styles.input}
              placeholder="Nhập username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={isLoading}
            />
          </div>
          <div style={{ marginBottom: 10 }}>
            <input
              style={styles.input}
              type="password"
              placeholder="Nhập password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyPress={(e) => e.key === "Enter" && login()}
              disabled={isLoading}
            />
          </div>
          <button
            style={{
              ...styles.button,
              opacity: isLoading ? 0.6 : 1,
              cursor: isLoading ? "wait" : "pointer",
            }}
            onClick={register}
            disabled={isLoading}
          >
            {isLoading ? "⏳ Đang xử lý..." : "📝 Đăng ký"}
          </button>
          <button
            style={{
              ...styles.button,
              background: "#28a745",
              opacity: isLoading ? 0.6 : 1,
              cursor: isLoading ? "wait" : "pointer",
            }}
            onClick={login}
            disabled={isLoading}
          >
            {isLoading ? "⏳ Đang xử lý..." : "🔑 Đăng nhập"}
          </button>
          <div
            style={{
              fontSize: 12,
              color: "#888",
              marginTop: 15,
              padding: 10,
              background: "#1a1a1a",
              borderRadius: 4,
            }}
          >
            <strong>🔐 Password-Protected Key Backup</strong>
            <br />
            <br />• <strong>Đăng ký:</strong> Tạo key pair mới, được mã hóa và
            backup bằng password
            <br />• <strong>Đăng nhập:</strong> Nếu đã có key trên thiết bị sẽ
            dùng ngay, nếu không sẽ khôi phục từ server bằng password
            <br />
            <br />
            <span style={{ color: "#ff9800" }}>
              ⚠️ Nếu quên password sẽ KHÔNG thể khôi phục chat cũ!
            </span>
          </div>
        </div>
      )}

      {/* Step 2: Users */}
      {step === "users" && (
        <div style={styles.section}>
          <h3>Bước 2: Chọn người để chat</h3>
          <p>
            Đang đăng nhập: <strong>{currentUser?.username}</strong>
          </p>
          <button style={styles.button} onClick={loadUsers}>
            🔄 Refresh
          </button>
          <div>
            {users.map((user) => (
              <div
                key={user._id}
                style={styles.userItem}
                onClick={() => startChat(user)}
              >
                {user.username}
              </div>
            ))}
            {users.length === 0 && (
              <p>Chưa có user khác. Mở tab mới để đăng ký user khác.</p>
            )}
          </div>
        </div>
      )}

      {/* Step 3: Chat */}
      {step === "chat" && (
        <div style={styles.section}>
          <h3>Bước 3: Chat với {chatPartner?.username}</h3>
          <div style={{ fontSize: 12, color: "green" }}>{keyStatus}</div>

          <div ref={chatBoxRef} style={styles.chatBox}>
            {loadingMessages && (
              <div style={{ textAlign: "center", padding: 10, color: "#888" }}>
                ⏳ Đang tải tin nhắn...
              </div>
            )}
            {!loadingMessages && hasMoreMessages && (
              <div style={{ textAlign: "center", padding: 10, color: "#888" }}>
                ↑ Cuộn lên để tải thêm tin nhắn
              </div>
            )}
            {messages.map((msg, idx) => (
              <div
                key={idx}
                style={msg.isMine ? styles.messageSent : styles.messageReceived}
              >
                <div>
                  <strong>{msg.sender}:</strong> {msg.text}
                </div>
                <div style={styles.meta}>{msg.time}</div>
              </div>
            ))}
          </div>

          <div>
            <input
              style={{ ...styles.input, width: "70%" }}
              placeholder="Nhập tin nhắn..."
              value={messageInput}
              onChange={(e) => setMessageInput(e.target.value)}
              onKeyPress={(e) => e.key === "Enter" && sendMessage()}
            />
            <button style={styles.button} onClick={sendMessage}>
              Gửi
            </button>
          </div>
        </div>
      )}

      {/* Debug */}
      <div style={styles.section}>
        <h3>🔧 Debug (Encrypted Data)</h3>
        <div style={styles.debug}>
          {debugLogs.length === 0 && (
            <em>Các tin nhắn encrypted sẽ hiển thị ở đây...</em>
          )}
          {debugLogs.map((log, idx) => (
            <div key={idx}>{log}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default App;

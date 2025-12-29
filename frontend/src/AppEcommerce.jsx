import { useState, useEffect, useRef, useCallback } from "react";
import { io } from "socket.io-client";
import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";

// ==================== CONFIG ====================
const API_URL = "http://localhost:4000/v1/api"; // Ecommerce backend uses /v1 prefix
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

// Derive shared key từ public/private key pair (Signal-style)
function deriveSharedKey(theirPublicKey, mySecretKey) {
  const theirPubKeyBytes = naclUtil.decodeBase64(theirPublicKey);
  const mySecretKeyBytes = naclUtil.decodeBase64(mySecretKey);
  const sharedKey = nacl.box.before(theirPubKeyBytes, mySecretKeyBytes);
  return sharedKey;
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

function generateKdfSalt() {
  return nacl.randomBytes(32);
}

async function deriveKeyFromPassword(password, saltBytes) {
  const encoder = new TextEncoder();
  const passwordBytes = encoder.encode(password);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    passwordBytes,
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations: 600000,
      hash: "SHA-256",
    },
    keyMaterial,
    256
  );
  return new Uint8Array(derivedBits);
}

function encryptPrivateKey(privateKeyBytes, masterKeyBytes) {
  const nonce = nacl.randomBytes(24);
  const encrypted = nacl.secretbox(privateKeyBytes, nonce, masterKeyBytes);
  return {
    encryptedPrivateKey: naclUtil.encodeBase64(encrypted),
    nonce: naclUtil.encodeBase64(nonce),
  };
}

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
  const [step, setStep] = useState("auth"); // auth | users | chat
  const [userId, setUserId] = useState(""); // MongoDB ObjectId
  const [accessToken, setAccessToken] = useState(""); // JWT Token
  const [password, setPassword] = useState(""); // Password for E2E key encryption
  const [isLoading, setIsLoading] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [currentUserRole, setCurrentUserRole] = useState(""); // admin | customer | staff
  const [users, setUsers] = useState([]);
  const [chatPartner, setChatPartner] = useState(null);
  const [currentChat, setCurrentChat] = useState(null);
  const [messages, setMessages] = useState([]);
  const [messageInput, setMessageInput] = useState("");
  const [keyStatus, setKeyStatus] = useState("");
  const [debugLogs, setDebugLogs] = useState([]);

  // Pagination state
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [nextCursor, setNextCursor] = useState(null);

  // Refs
  const myKeyPairRef = useRef(null);
  const sharedKeyRef = useRef(null);
  const messageCounterRef = useRef(0);
  const socketRef = useRef(null);
  const chatBoxRef = useRef(null);
  const shouldScrollToBottomRef = useRef(true);

  // API headers with JWT Token
  const getHeaders = () => ({
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
  });

  // Debug logger
  const log = (msg, data = "") => {
    const time = new Date().toLocaleTimeString();
    const entry = `[${time}] ${msg} ${
      data ? JSON.stringify(data).substring(0, 80) : ""
    }`;
    setDebugLogs((prev) => [...prev.slice(-20), entry]);
  };

  // Auto scroll chat
  useEffect(() => {
    if (chatBoxRef.current && shouldScrollToBottomRef.current) {
      chatBoxRef.current.scrollTop = chatBoxRef.current.scrollHeight;
    }
  }, [messages]);

  // ==================== REGISTER CHAT KEY ====================
  const registerChatKey = async () => {
    if (!userId.trim() || !accessToken.trim()) {
      alert("Vui lòng nhập userId và accessToken");
      return;
    }
    if (!password.trim() || password.length < 6) {
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

      // 4. Gửi register request đến ecommerce backend
      const res = await fetch(`${API_URL}/chat-key/register`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({
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
        alert(data.message || data.error || "Lỗi đăng ký chat key");
        return;
      }

      // 5. Lưu private key vào localStorage
      setCurrentUser({ _id: userId, ...data.data });
      localStorage.setItem(
        `secretKey_${userId}`,
        myKeyPairRef.current.secretKey
      );

      // Decode role from accessToken
      const tokenPayload = JSON.parse(atob(accessToken.split(".")[1]));
      setCurrentUserRole(tokenPayload.role || "customer");
      log("✅ Registered chat key", { userId, role: tokenPayload.role });

      // Connect socket
      connectSocket(userId);
      setStep("users");
      setPassword("");
      loadUsers(tokenPayload.role);
    } catch (error) {
      log("❌ Register error", error.message);
      alert("Lỗi đăng ký: " + error.message);
    } finally {
      setIsLoading(false);
    }
  };

  // ==================== LOGIN WITH EXISTING KEY ====================
  const loginWithKey = async () => {
    if (!userId.trim() || !accessToken.trim()) {
      alert("Vui lòng nhập userId và accessToken");
      return;
    }
    if (!password.trim()) {
      alert("Vui lòng nhập password");
      return;
    }

    try {
      setIsLoading(true);
      log("🔐 Đang xác thực...");

      // Try to get encrypted key from server
      const keyRes = await fetch(
        `${API_URL}/chat-key/${userId}/encrypted-key`,
        {
          headers: getHeaders(),
        }
      );
      const keyData = await keyRes.json();

      if (!keyRes.ok) {
        alert(
          keyData.message ||
            keyData.error ||
            "Không thể lấy key. Hãy đăng ký chat key trước."
        );
        return;
      }

      const keyInfo = keyData.data || keyData;

      // Derive Master Key từ password
      const kdfSalt = naclUtil.decodeBase64(keyInfo.kdfSalt);
      const masterKey = await deriveKeyFromPassword(password, kdfSalt);

      // Thử decrypt private key để verify password
      try {
        const decryptedPrivateKey = decryptPrivateKey(
          keyInfo.encryptedPrivateKey,
          keyInfo.privateKeyNonce,
          masterKey
        );

        const recoveredSecretKey = naclUtil.encodeBase64(decryptedPrivateKey);

        // Password đúng!
        localStorage.setItem(`secretKey_${userId}`, recoveredSecretKey);

        myKeyPairRef.current = {
          publicKey: keyInfo.publicKey,
          secretKey: recoveredSecretKey,
        };

        // Decode role from accessToken
        const tokenPayload = JSON.parse(atob(accessToken.split(".")[1]));
        setCurrentUserRole(tokenPayload.role || "customer");
        setCurrentUser({ _id: userId, publicKey: keyInfo.publicKey });
        log("✅ Password verified, logged in", {
          userId,
          role: tokenPayload.role,
        });
      } catch (decryptError) {
        log("❌ Password verification failed", decryptError.message);
        alert("Sai password!");
        return;
      }

      // Decode role from accessToken for loadUsers
      const tokenPayload = JSON.parse(atob(accessToken.split(".")[1]));

      // Connect socket
      connectSocket(userId);
      setStep("users");
      setPassword("");
      loadUsers(tokenPayload.role);
    } catch (error) {
      log("❌ Login error", error.message);
      alert("Lỗi đăng nhập: " + error.message);
    } finally {
      setIsLoading(false);
    }
  };

  // ==================== SOCKET ====================
  const connectSocket = (connUserId) => {
    socketRef.current = io(SOCKET_URL);

    socketRef.current.on("connect", () => {
      log("🔌 Socket connected");
      socketRef.current.emit("join", connUserId);
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
            sender:
              message.senderId.name || message.senderId.email || "Unknown",
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
  const loadUsers = async (userRole) => {
    try {
      const res = await fetch(`${API_URL}/chat-key/users`, {
        headers: getHeaders(),
      });
      const data = await res.json();
      const userList = data.data || data || [];

      // Filter out current user
      let filteredUsers = userList.filter((u) => {
        const uid = u.userId?._id || u.userId;
        return String(uid) !== String(userId);
      });

      // If current user is NOT admin, only show admins to chat with
      if (userRole !== "admin") {
        filteredUsers = filteredUsers.filter(
          (u) => u.userId?.name === "Administrator"
        );
        log(
          "📋 Filtered to admins only (you are not admin)",
          filteredUsers.length
        );

        // Auto-start chat with first admin for customers
        if (filteredUsers.length > 0) {
          log("🚀 Auto-starting chat with admin for customer");
          setUsers(filteredUsers);
          // Automatically start chat with first admin
          setTimeout(() => {
            startChat(filteredUsers[0]);
          }, 100);
          return;
        }
      } else {
        log("📋 Loaded all users (you are admin)", filteredUsers.length);
      }

      setUsers(filteredUsers);
    } catch (error) {
      log("❌ Load users error", error.message);
    }
  };

  // ==================== START CHAT ====================
  const startChat = async (partner) => {
    const partnerId = partner.userId?._id || partner.userId;
    setChatPartner({ ...partner, oderId: partnerId });
    log("💬 Starting chat with", partnerId);

    try {
      // Create/get chat
      const res = await fetch(`${API_URL}/chat/create`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({
          participantIds: [userId, partnerId],
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        alert(data.message || data.error || "Không thể tạo chat");
        return;
      }

      const chat = data.data || data;
      setCurrentChat(chat);
      socketRef.current.emit("join_chat", chat._id);
      log("📝 Chat created", { chatId: chat._id });

      // Derive shared key từ partner's publicKey
      const partnerPubKey =
        partner.publicKey ||
        chat.participants.find((p) => {
          const pid = p._id || p;
          return String(pid) !== String(userId);
        })?.publicKey;

      if (!partnerPubKey) {
        throw new Error("Không tìm thấy publicKey của partner");
      }

      sharedKeyRef.current = deriveSharedKey(
        partnerPubKey,
        myKeyPairRef.current.secretKey
      );
      setKeyStatus("🔐 Derived sharedKey từ publicKey");
      log("✅ Derived sharedKey using nacl.box.before()");

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

  // ==================== MESSAGES ====================
  const loadMessages = async (chatId, cursor = null, isLoadingMore = false) => {
    if (loadingMessages) return;

    try {
      setLoadingMessages(true);
      const limit = 20;

      let url = `${API_URL}/message/chat/${chatId}?limit=${limit}`;
      if (cursor) {
        url += `&cursor=${cursor}`;
      }

      const res = await fetch(url, { headers: getHeaders() });
      const responseData = await res.json();
      const data = responseData.data || responseData;

      const decryptedMessages = [];
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
              sender: msg.senderId.name || msg.senderId.email || "Unknown",
              isMine: String(msg.senderId._id) === String(userId),
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
        setMessages((prev) => [...decryptedMessages, ...prev]);
      } else {
        setMessages(decryptedMessages);
      }

      setHasMoreMessages(data.hasMore || false);
      setNextCursor(data.nextCursor || null);

      log("📜 Loaded messages", {
        count: messagesReversed.length,
        hasMore: data.hasMore,
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

  // Infinite scroll
  useEffect(() => {
    const chatBox = chatBoxRef.current;
    if (!chatBox) return;

    const handleScroll = () => {
      if (chatBox.scrollTop < 50 && hasMoreMessages && !loadingMessages) {
        const previousScrollHeight = chatBox.scrollHeight;
        shouldScrollToBottomRef.current = false;
        loadMoreMessages();
        setTimeout(() => {
          const newScrollHeight = chatBox.scrollHeight;
          chatBox.scrollTop = newScrollHeight - previousScrollHeight;
          shouldScrollToBottomRef.current = true;
        }, 100);
      }
    };

    chatBox.addEventListener("scroll", handleScroll);
    return () => chatBox.removeEventListener("scroll", handleScroll);
  }, [hasMoreMessages, loadingMessages, loadMoreMessages]);

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
      senderId: userId,
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
      maxWidth: 900,
      margin: "20px auto",
      fontFamily: "Arial, sans-serif",
      padding: 20,
    },
    section: {
      border: "1px solid #444",
      padding: 20,
      margin: "15px 0",
      borderRadius: 8,
      background: "#1a1a1a",
    },
    input: {
      padding: "12px 16px",
      margin: "8px 0",
      borderRadius: 6,
      border: "1px solid #555",
      background: "#2a2a2a",
      color: "#fff",
      width: "100%",
      maxWidth: 450,
      fontSize: 14,
    },
    button: {
      padding: "12px 24px",
      margin: "8px 8px 8px 0",
      background: "#007bff",
      color: "white",
      border: "none",
      borderRadius: 6,
      cursor: "pointer",
      fontSize: 14,
      fontWeight: 500,
    },
    userItem: {
      padding: 14,
      margin: 8,
      background: "#2d2d2d",
      cursor: "pointer",
      borderRadius: 8,
      border: "1px solid #444",
      transition: "background 0.2s",
    },
    chatBox: {
      height: 350,
      overflowY: "auto",
      border: "1px solid #444",
      padding: 12,
      margin: "15px 0",
      background: "#0d0d0d",
      borderRadius: 8,
    },
    messageSent: {
      padding: "10px 14px",
      margin: 6,
      background: "#1e3a5f",
      textAlign: "right",
      borderRadius: 12,
      maxWidth: "70%",
      marginLeft: "auto",
    },
    messageReceived: {
      padding: "10px 14px",
      margin: 6,
      background: "#2d2d2d",
      borderRadius: 12,
      maxWidth: "70%",
    },
    meta: { fontSize: 11, color: "#888", marginTop: 4 },
    debug: {
      background: "#0a0a0a",
      fontFamily: "monospace",
      fontSize: 11,
      padding: 12,
      maxHeight: 180,
      overflowY: "auto",
      borderRadius: 6,
      border: "1px solid #333",
    },
    label: {
      fontSize: 13,
      color: "#aaa",
      marginBottom: 4,
      display: "block",
    },
  };

  return (
    <div style={styles.container}>
      <h1>🔐 E2E Chat - Ecommerce Backend</h1>
      <p style={{ color: "#888", marginBottom: 20 }}>
        Kết nối đến: <code>{API_URL}</code>
      </p>

      {/* Step 1: Auth */}
      {step === "auth" && (
        <div style={styles.section}>
          <h3>Bước 1: Xác thực với Ecommerce Backend</h3>
          <p style={{ fontSize: 13, color: "#aaa", marginBottom: 20 }}>
            Nhập userId và JWT Access Token từ hệ thống ecommerce
          </p>

          <div style={{ marginBottom: 15 }}>
            <label style={styles.label}>User ID (MongoDB ObjectId)</label>
            <input
              style={styles.input}
              placeholder="VD: 507f1f77bcf86cd799439011"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              disabled={isLoading}
            />
          </div>

          <div style={{ marginBottom: 15 }}>
            <label style={styles.label}>JWT Access Token</label>
            <input
              style={styles.input}
              placeholder="eyJhbGciOiJIUzI1NiIs..."
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              disabled={isLoading}
            />
          </div>

          <div style={{ marginBottom: 20 }}>
            <label style={styles.label}>
              Password cho E2E Key (min 6 ký tự)
            </label>
            <input
              style={styles.input}
              type="password"
              placeholder="Dùng để mã hóa private key"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={isLoading}
            />
          </div>

          <div>
            <button
              style={{
                ...styles.button,
                opacity: isLoading ? 0.6 : 1,
              }}
              onClick={registerChatKey}
              disabled={isLoading}
            >
              {isLoading ? "⏳ Đang xử lý..." : "📝 Đăng ký Chat Key"}
            </button>
            <button
              style={{
                ...styles.button,
                background: "#28a745",
                opacity: isLoading ? 0.6 : 1,
              }}
              onClick={loginWithKey}
              disabled={isLoading}
            >
              {isLoading ? "⏳ Đang xử lý..." : "🔑 Đăng nhập với Key đã có"}
            </button>
          </div>

          <div
            style={{
              fontSize: 12,
              color: "#888",
              marginTop: 25,
              padding: 15,
              background: "#222",
              borderRadius: 6,
            }}
          >
            <strong>💡 Hướng dẫn:</strong>
            <br />
            <br />
            1. Đăng nhập vào app/web ecommerce để lấy <b>userId</b> và{" "}
            <b>accessToken</b>
            <br />
            2. Nếu chưa có chat key → chọn <b>"Đăng ký Chat Key"</b>
            <br />
            3. Nếu đã có chat key → chọn <b>"Đăng nhập với Key đã có"</b>
            <br />
            <br />
            <span style={{ color: "#ff9800" }}>
              ⚠️ Password ở đây dùng để mã hóa private key E2E, không phải
              password đăng nhập ecommerce!
            </span>
          </div>
        </div>
      )}

      {/* Step 2: Users */}
      {step === "users" && (
        <div style={styles.section}>
          <h3>Bước 2: Chọn người để chat</h3>
          <p style={{ marginBottom: 15 }}>
            Đang đăng nhập với userId: <strong>{userId}</strong>
            <span
              style={{
                marginLeft: 10,
                padding: "4px 10px",
                borderRadius: 4,
                background: currentUserRole === "admin" ? "#28a745" : "#6c757d",
                color: "white",
                fontSize: 12,
              }}
            >
              {currentUserRole.toUpperCase()}
            </span>
          </p>
          {currentUserRole !== "admin" && (
            <div
              style={{
                padding: 12,
                background: "#332700",
                borderRadius: 6,
                marginBottom: 15,
                border: "1px solid #ffc107",
              }}
            >
              ⚠️ <strong>Lưu ý:</strong> Bạn không phải admin, bạn chỉ có thể
              chat với admin.
            </div>
          )}
          {/* Admin only: Refresh button */}
          {currentUserRole === "admin" && (
            <button
              style={styles.button}
              onClick={() => loadUsers(currentUserRole)}
            >
              🔄 Refresh danh sách
            </button>
          )}

          <div style={{ marginTop: 15 }}>
            {users.map((user, idx) => (
              <div
                key={user._id || idx}
                style={{
                  ...styles.userItem,
                  borderLeft:
                    user.userId?.name === "Administrator"
                      ? "4px solid #28a745"
                      : "4px solid #6c757d",
                }}
                onClick={() => startChat(user)}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.background = "#3d3d3d")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.background = "#2d2d2d")
                }
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <strong>
                    {user.userId?.name || user.userId?.email || "User"}
                  </strong>
                  <span
                    style={{
                      padding: "2px 8px",
                      borderRadius: 4,
                      background:
                        user.userId?.name === "Administrator"
                          ? "#28a745"
                          : "#6c757d",
                      color: "white",
                      fontSize: 10,
                      textTransform: "uppercase",
                    }}
                  >
                    {user.userId?.name || "user"}
                  </span>
                </div>
                <span style={{ fontSize: 11, color: "#888" }}>
                  ID: {user.userId?._id || user.userId}
                </span>
              </div>
            ))}
            {/* Admin only: Show empty message */}
            {users.length === 0 && currentUserRole === "admin" && (
              <p style={{ color: "#888", fontStyle: "italic" }}>
                Chưa có user khác đăng ký chat key. Mở tab mới với user khác.
              </p>
            )}
            {/* Customer: Show waiting message if no admin */}
            {users.length === 0 && currentUserRole !== "admin" && (
              <p style={{ color: "#888", fontStyle: "italic" }}>
                ⏳ Đang tìm admin để hỗ trợ...
              </p>
            )}
          </div>
        </div>
      )}

      {/* Step 3: Chat */}
      {step === "chat" && (
        <div style={styles.section}>
          <h3>
            💬 Chat với{" "}
            {chatPartner?.userId?.name ||
              chatPartner?.userId?.email ||
              chatPartner?.oderId}
          </h3>
          <div style={{ fontSize: 12, color: "#4caf50", marginBottom: 10 }}>
            {keyStatus}
          </div>

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

          <div style={{ display: "flex", gap: 10 }}>
            <input
              style={{ ...styles.input, flex: 1, maxWidth: "none" }}
              placeholder="Nhập tin nhắn..."
              value={messageInput}
              onChange={(e) => setMessageInput(e.target.value)}
              onKeyPress={(e) => e.key === "Enter" && sendMessage()}
            />
            <button style={styles.button} onClick={sendMessage}>
              Gửi
            </button>
          </div>

          <button
            style={{ ...styles.button, background: "#666", marginTop: 15 }}
            onClick={() => setStep("users")}
          >
            ← Quay lại danh sách
          </button>
        </div>
      )}

      {/* Debug */}
      <div style={styles.section}>
        <h3>🔧 Debug Log</h3>
        <div style={styles.debug}>
          {debugLogs.length === 0 && (
            <em style={{ color: "#666" }}>Logs sẽ hiển thị ở đây...</em>
          )}
          {debugLogs.map((logEntry, idx) => (
            <div key={idx}>{logEntry}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default App;

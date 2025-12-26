# 🛠️ Developer Guide - E2E Chat

Hướng dẫn chi tiết cho developer để debug và hiểu flow mã hóa.

---

## 📦 Cài đặt & Chạy

```bash
# Terminal 1 - Backend
cd backend
npm install
npm run dev

# Terminal 2 - Frontend
cd frontend
npm install
npm run dev
```

Mở browser: `http://localhost:5173`

---

## 🔍 Debug với DevTools

### 1. Xem localStorage (Lưu trữ Private Key)

**Cách mở:**

1. Nhấn `F12` hoặc `Ctrl+Shift+I` để mở DevTools
2. Chọn tab **Application** (Chrome) hoặc **Storage** (Firefox)
3. Sidebar trái → **Local Storage** → `http://localhost:5173`

**Các key quan trọng:**

| Key                  | Giá trị          | Giải thích                                  |
| -------------------- | ---------------- | ------------------------------------------- |
| `secretKey_{userId}` | Base64 string    | **Private key** của user (32 bytes encoded) |
| `userId_{username}`  | MongoDB ObjectId | Mapping username → userId                   |

**Ví dụ:**

```
secretKey_6766e1234567890abcdef12 = "Abc123XYZ...=" (44 chars base64)
userId_alice = "6766e1234567890abcdef12"
```

> ⚠️ **QUAN TRỌNG:** Nếu xóa `secretKey_*`, user sẽ cần password để recover!

**Test xóa localStorage:**

1. Right-click → **Clear** hoặc chọn key → **Delete**
2. Refresh page
3. Login lại với password → Key sẽ được recover từ server

---

### 2. Xem Network Requests (API Calls)

**Cách mở:**

1. `F12` → Tab **Network**
2. Filter: `XHR` hoặc `Fetch` để chỉ xem API calls
3. Thực hiện action (đăng ký, đăng nhập, gửi tin) để xem requests

**Các API quan trọng:**

#### `POST /api/register`

```json
// Request
{
  "username": "alice",
  "publicKey": "base64...",           // Public key (gửi lên server)
  "encryptedPrivateKey": "base64...", // Private key ĐÃ MÃ HÓA
  "privateKeyNonce": "base64...",
  "kdfSalt": "base64...",             // Salt cho PBKDF2
  "kdfParams": {
    "algorithm": "pbkdf2",
    "iterations": 600000,
    "hash": "SHA-256"
  }
}

// Response
{
  "user": {
    "_id": "6766e123...",
    "username": "alice",
    "publicKey": "base64...",
    "hasBackup": true           // Có encrypted backup
  }
}
```

> 🔐 **Lưu ý:** `password` **KHÔNG BAO GIỜ** gửi lên server!
> Server chỉ nhận `encryptedPrivateKey` (đã mã hóa bằng Master Key derived từ password)

---

#### `GET /api/user/{username}/encrypted-key`

```json
// Response - Dùng cho LOGIN (verify password)
{
  "encryptedPrivateKey": "base64...",   // Private key đã mã hóa
  "privateKeyNonce": "base64...",
  "kdfSalt": "base64...",               // Salt để derive Master Key
  "kdfParams": {...},
  "publicKey": "base64..."
}
```

**Flow khi Login:**

1. Client fetch encrypted key từ server
2. Derive Master Key từ password + salt (PBKDF2)
3. Thử decrypt `encryptedPrivateKey`
   - ✅ Decrypt thành công → Password đúng!
   - ❌ Decrypt thất bại → Password sai!

---

#### `POST /api/chat/create`

```json
// Request
{
  "participantIds": ["userId1", "userId2"]
}

// Response - QUAN TRỌNG: Có publicKey của participants
{
  "_id": "chatId...",
  "participants": [
    { "_id": "userId1", "username": "alice", "publicKey": "base64..." },
    { "_id": "userId2", "username": "bob", "publicKey": "base64..." }
  ]
}
```

> 📌 Response có `publicKey` để client derive SharedKey mà không cần API call thêm!

---

### 3. Xem WebSocket Messages

**Cách xem:**

1. `F12` → Tab **Network**
2. Filter: `WS` (WebSocket)
3. Click vào connection `socket.io`
4. Tab **Messages** để xem real-time messages

**Các events:**

| Event             | Direction       | Data                                          |
| ----------------- | --------------- | --------------------------------------------- |
| `join`            | Client → Server | `userId`                                      |
| `join_chat`       | Client → Server | `chatId`                                      |
| `send_message`    | Client → Server | `{chatId, senderId, encryptedContent, nonce}` |
| `receive_message` | Server → Client | Full message object                           |

**Ví dụ `send_message`:**

```json
{
  "chatId": "6766f...",
  "senderId": "6766e...",
  "encryptedContent": "jK9xM2nP...", // Ciphertext (không đọc được!)
  "nonce": "abc123...", // 24 bytes base64
  "messageCounter": 5
}
```

> 🔐 Server **CHỈ** thấy ciphertext, **KHÔNG THỂ** decrypt!

---

## 🔬 Deep Dive: Crypto Functions

### Derive SharedKey (nacl.box.before)

```javascript
// Cả 2 users derive được CÙNG SharedKey từ ECDH
const sharedKey = nacl.box.before(
  theirPublicKey, // 32 bytes
  mySecretKey // 32 bytes
);
// → sharedKey: 32 bytes

// Toán học đằng sau:
// User A: box.before(B.pub, A.priv) = A.priv * B.pub = A.priv * (B.priv * G)
// User B: box.before(A.pub, B.priv) = B.priv * A.pub = B.priv * (A.priv * G)
// Elliptic curve: A.priv * B.priv * G = B.priv * A.priv * G (commutative!)
```

### Encrypt Message (nacl.secretbox)

```javascript
// Nonce = 16 random bytes + 8 counter bytes = 24 bytes
const nonce = createNonce(messageCounter);

// Encrypt với symmetric key
const ciphertext = nacl.secretbox(
  messageBytes, // Plaintext
  nonce, // 24 bytes, NEVER reuse!
  sharedKey // 32 bytes
);
// → ciphertext: plaintext.length + 16 bytes (auth tag)
```

### Password → Master Key (PBKDF2)

```javascript
// Derive 32-byte key từ password
const masterKey = await crypto.subtle.deriveBits(
  {
    name: "PBKDF2",
    salt: kdfSalt, // 32 random bytes
    iterations: 600000, // High cost = slow brute force
    hash: "SHA-256",
  },
  passwordKey,
  256 // 32 bytes output
);
```

---

## 🧪 Debug Scenarios

### Scenario 1: Xem encrypted message đi qua server

1. Mở 2 browser tabs (hoặc Chrome + Firefox)
2. Đăng ký 2 users
3. User A gửi tin: "Hello secret!"
4. **Tab Server terminal:** Thấy log `📨 Message saved & broadcasted`
5. **Tab Network (User A):** Xem `send_message` websocket → `encryptedContent` là garbage

### Scenario 2: Verify password check

1. Đăng ký user với password "abc123"
2. `F12` → **Application** → **Local Storage** → Clear all
3. Login với password "wrong"
4. **Network tab:** Xem request `/encrypted-key` → có response
5. **Console:** Có log "❌ Password verification failed"

### Scenario 3: Confirm server không thể decrypt

1. Mở MongoDB Compass hoặc `mongosh`
2. Query: `db.messages.find().limit(1)`
3. Thấy `encryptedContent` là base64 không đọc được
4. **Server không có private keys → không thể decrypt!**

---

## 📊 Crypto Summary Table

| Component          | Algorithm         | Key Size | Notes              |
| ------------------ | ----------------- | -------- | ------------------ |
| Key Pair           | X25519            | 32 bytes | nacl.box.keyPair() |
| Key Agreement      | X25519 ECDH       | 32 bytes | nacl.box.before()  |
| Message Encryption | XSalsa20-Poly1305 | 32 bytes | nacl.secretbox()   |
| Password KDF       | PBKDF2-SHA256     | 32 bytes | 600K iterations    |
| Nonce              | Random + Counter  | 24 bytes | NEVER reuse!       |

---

## ❓ FAQ

**Q: Tại sao dùng nacl.box.before() thay vì random key?**

> Để không cần lưu/trao đổi SharedKey. Cả 2 users derive được cùng key từ ECDH.

**Q: Server có thể đọc tin nhắn không?**

> KHÔNG. Server chỉ có publicKeys, không có privateKeys hay sharedKeys.

**Q: Quên password thì sao?**

> Mất private key backup → không thể recover → mất chat history.

**Q: Tại sao PBKDF2 600K iterations?**

> Slow hashing = attacker brute force chậm hơn. 600K ≈ 0.5-1 giây trên browser.

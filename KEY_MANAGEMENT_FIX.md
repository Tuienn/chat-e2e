# 🔑 Key Management Fix

## Vấn đề

### Hiện tượng
API `GET /api/chat/:chatId/key/:userId` trả về lỗi **"Chưa có key cho user này"** cho user2 nhưng lại hoạt động bình thường cho user1.

### Database State
```json
{
  "encryptedKeys": [
    {
      "recipientId": "user1_id",
      "senderId": "user2_id",
      "encryptedSharedKey": "...",
      "nonce": "..."
    }
  ]
}
```

### Root Cause

**Logic cũ:**
```javascript
// Chỉ tìm key mà user là recipient
const keyData = chat.encryptedKeys.find(
  (k) => k.recipientId.toString() === userId
);
```

**Vấn đề:**
1. User2 tạo `sharedKey` (symmetric key cho encrypt/decrypt messages)
2. User2 mã hóa `sharedKey` bằng publicKey của User1
3. Lưu vào DB: `{ recipientId: user1, senderId: user2, encryptedSharedKey: ... }`
4. ❌ **User2 không có cách nào lấy lại sharedKey sau khi reload page!**

**Tại sao user2 cần lấy lại sharedKey?**
- Khi reload page, `sharedKeyRef.current` bị mất (chỉ lưu trong memory)
- User2 cần sharedKey để decrypt messages cũ
- User2 cần sharedKey để encrypt messages mới

**Tại sao không thể lấy từ `senderId`?**
- `encryptedSharedKey` đã được mã hóa bằng publicKey của **User1**
- User2 không có privateKey của User1 để decrypt
- ❌ User2 không thể recover sharedKey gốc!

---

## Giải pháp

### Approach: Lưu Key cho CẢ 2 Users

**Concept:**
Khi user tạo sharedKey, mã hóa và lưu **2 copies**:
1. Mã hóa bằng publicKey của **partner** → cho partner decrypt
2. Mã hóa bằng publicKey của **chính mình** → cho mình recover sau khi reload

### Implementation

#### Backend (`app.js`)

**1. API GET key - Support both recipient and sender:**
```javascript
app.get("/api/chat/:chatId/key/:userId", async (req, res) => {
  // Tìm key mà user là recipient (do người khác gửi)
  let keyData = chat.encryptedKeys.find(
    (k) => k.recipientId.toString() === userId
  );

  // Nếu không tìm thấy, tìm key mà user là sender (do mình tạo)
  if (!keyData) {
    keyData = chat.encryptedKeys.find(
      (k) => k.senderId.toString() === userId
    );
    
    if (keyData) {
      return res.json({
        ...keyData.toObject(),
        isSender: true, // Flag để frontend biết
      });
    }
  }

  if (!keyData) {
    return res.status(404).json({ error: "Chưa có key cho user này" });
  }

  res.json({ ...keyData.toObject(), isSender: false });
});
```

**Logic:**
- Ưu tiên tìm key mà user là recipient (normal case)
- Fallback: tìm key mà user là sender (recovery case)
- Trả về flag `isSender` để frontend xử lý đúng

#### Frontend (`App.jsx`)

**1. Create and share key - Gửi cho CẢ 2 users:**
```javascript
const createAndShareKey = async (chatId, partner) => {
  sharedKeyRef.current = generateSharedKey();

  // Mã hóa cho partner
  const partnerKey = encryptSharedKey(
    sharedKeyRef.current,
    partner.publicKey,        // Public key của partner
    myKeyPairRef.current.secretKey
  );

  // Mã hóa cho chính mình
  const myKey = encryptSharedKey(
    sharedKeyRef.current,
    myKeyPairRef.current.publicKey,  // Public key của mình
    myKeyPairRef.current.secretKey
  );

  // Gửi 2 key exchanges
  socketRef.current.emit("key_exchange", {
    chatId,
    recipientId: partner._id,
    senderId: currentUser._id,
    encryptedSharedKey: partnerKey.encryptedSharedKey,
    nonce: partnerKey.nonce,
  });

  socketRef.current.emit("key_exchange", {
    chatId,
    recipientId: currentUser._id,  // Mình là recipient
    senderId: currentUser._id,      // Mình cũng là sender
    encryptedSharedKey: myKey.encryptedSharedKey,
    nonce: myKey.nonce,
  });
};
```

**2. Load existing key - Decrypt với đúng public key:**
```javascript
const keyData = await keyRes.json();

// Lấy public key của sender
const senderRes = await fetch(`${API_URL}/user/${keyData.senderId}`);
const sender = await senderRes.json();

// Decrypt bằng:
// - sender.publicKey (public key của người gửi)
// - myKeyPairRef.current.secretKey (private key của mình)
sharedKeyRef.current = decryptSharedKey(
  keyData.encryptedSharedKey,
  keyData.nonce,
  sender.publicKey,
  myKeyPairRef.current.secretKey
);
```

---

## Database State Sau Khi Fix

```json
{
  "encryptedKeys": [
    {
      "recipientId": "user1_id",
      "senderId": "user2_id",
      "encryptedSharedKey": "encrypted_for_user1",
      "nonce": "nonce1"
    },
    {
      "recipientId": "user2_id",  // ← NEW: User2 cũng có key
      "senderId": "user2_id",
      "encryptedSharedKey": "encrypted_for_user2",  // Cùng sharedKey nhưng encrypted khác
      "nonce": "nonce2"
    }
  ]
}
```

**Giải thích:**
- Entry 1: User1 có thể decrypt bằng privateKey của mình
- Entry 2: User2 có thể decrypt bằng privateKey của mình
- Cả 2 entries decrypt ra cùng 1 `sharedKey` gốc
- SharedKey được dùng để encrypt/decrypt messages

---

## Flow Chart

```
User2 tạo chat với User1:

1. Generate sharedKey (32 random bytes)
   ↓
2. Encrypt sharedKey with User1's publicKey
   → Save to DB: { recipientId: user1, senderId: user2, encrypted1 }
   ↓
3. Encrypt sharedKey with User2's publicKey (OWN key)
   → Save to DB: { recipientId: user2, senderId: user2, encrypted2 }
   ↓
4. Both users can now:
   - Decrypt their own encrypted copy
   - Get the same sharedKey
   - Encrypt/decrypt messages
```

---

## Tại Sao Dùng nacl.box Để Encrypt SharedKey?

**nacl.box** = Asymmetric encryption (X25519 + XSalsa20 + Poly1305)

**Parameters:**
```javascript
nacl.box(
  message,           // Plaintext sharedKey (32 bytes)
  nonce,             // Random nonce (24 bytes)
  theirPublicKey,    // Public key của người nhận
  mySecretKey        // Private key của mình
)
```

**Cách hoạt động:**
1. Tạo shared secret từ `theirPublicKey` + `mySecretKey` (ECDH)
2. Dùng shared secret để encrypt message
3. Chỉ người có `theirSecretKey` mới decrypt được

**Trong context này:**
- Encrypt sharedKey cho User1: `nacl.box(sharedKey, nonce, user1.publicKey, user2.secretKey)`
- User1 decrypt: `nacl.box.open(encrypted, nonce, user2.publicKey, user1.secretKey)`

**Security:**
- Mỗi user chỉ có thể decrypt key của mình
- Server không thể decrypt (không có private keys)
- Perfect forward secrecy

---

## Migration Strategy

### Cho Users Hiện Tại

**Vấn đề:** Chats hiện tại chỉ có 1 encryptedKey entry (cho recipient)

**Giải pháp:**

#### Option 1: Force Re-create Keys (Recommended)
```javascript
// Frontend: Khi load key thất bại
if (!keyRes.ok || !canDecrypt(keyData)) {
  // Tạo key mới cho cả 2 users
  await createAndShareKey(chat._id, partner);
}
```

**Pros:**
- ✅ Clean state
- ✅ Đảm bảo cả 2 users có key

**Cons:**
- ❌ Mất decrypt được messages cũ (nếu có)

#### Option 2: Add Missing Key Entry
```javascript
// Backend migration script
for each chat:
  for each encryptedKey where recipientId !== senderId:
    // Tạo entry mới cho sender
    // (Yêu cầu sender online và có sharedKey trong memory)
```

**Pros:**
- ✅ Giữ được messages cũ

**Cons:**
- ❌ Phức tạp
- ❌ Yêu cầu sender online

### Recommended Approach

**Cho development:**
- Reset database và test lại từ đầu

**Cho production:**
- Notify users: "Please refresh and re-initiate chats"
- Old messages không decrypt được (acceptable cho early stage)

---

## Testing

### Test Case 1: New Chat Creation
```bash
# User1 tạo chat với User2
POST /api/chat/create
{
  "participantIds": ["user1_id", "user2_id"]
}

# Check DB: Phải có 2 encryptedKeys
# - recipientId: user1
# - recipientId: user2
```

### Test Case 2: Key Retrieval
```bash
# User1 lấy key
GET /api/chat/:chatId/key/user1_id
→ 200 OK { recipientId: user1_id, senderId: user2_id, ... }

# User2 lấy key
GET /api/chat/:chatId/key/user2_id
→ 200 OK { recipientId: user2_id, senderId: user2_id, ... }
```

### Test Case 3: Message Encryption/Decryption
```javascript
// User1 gửi message
encrypt("Hello", sharedKey1) → ciphertext1

// User2 decrypt
decrypt(ciphertext1, sharedKey2) → "Hello"

// Verify: sharedKey1 === sharedKey2
```

### Test Case 4: Page Reload
```bash
1. User2 tạo chat → có sharedKey
2. Reload page
3. Login lại
4. Open chat
5. GET /api/chat/:chatId/key/user2_id
6. Decrypt encryptedSharedKey
7. ✅ Có sharedKey → decrypt messages OK
```

---

## Summary

**Vấn đề:** User không thể recover sharedKey sau khi reload page

**Nguyên nhân:** Chỉ lưu encryptedKey cho recipient, sender không có cách recover

**Giải pháp:** Lưu encryptedKey cho CẢ 2 users (mỗi người mã hóa bằng public key của mình)

**Changes:**
1. ✅ Backend API hỗ trợ tìm key theo cả recipientId và senderId
2. ✅ Frontend tạo và gửi 2 key exchanges (1 cho partner, 1 cho mình)
3. ✅ Frontend decrypt đúng bằng sender's public key

**Result:** Cả 2 users đều có thể recover sharedKey sau reload → encrypt/decrypt messages bình thường!


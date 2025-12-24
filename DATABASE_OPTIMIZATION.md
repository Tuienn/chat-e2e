# 🚀 Database Optimization & Indexing

Tài liệu này mô tả các tối ưu hóa database và indexing được áp dụng cho E2E Chat App.

## 📌 Indexes Implemented

### 1. User Collection

```javascript
// Index cho tìm kiếm nhanh theo username
userSchema.index({ username: 1 });
```

**Mục đích:**

- Tăng tốc độ login (query `findOne({ username })`)
- Username là unique nên index này cực kỳ hiệu quả
- Phục vụ cho endpoint: `GET /api/user/by-username/:username`

**Performance Impact:**

- Query time: O(log n) thay vì O(n)
- Với 1 triệu users: ~20 so sánh thay vì 1 triệu

---

### 2. Chat Collection

```javascript
// Index cho query chat theo participants
chatSchema.index({ participants: 1 });
```

**Mục đích:**

- Tìm chat giữa 2 người: `find({ participants: { $all: [userId1, userId2] } })`
- Phục vụ cho endpoint: `POST /api/chat/create`

**Performance Impact:**

- Tăng tốc độ tìm kiếm chat đã tồn tại
- Tránh tạo duplicate chats

---

### 3. Message Collection - Compound Index (Chính)

```javascript
// Compound Index cho query + sort
messageSchema.index({ chatId: 1, timestamp: -1 });
```

**Mục đích:**

- **Query pattern chính:** `find({ chatId }).sort({ timestamp: -1 })`
- Lấy tin nhắn của 1 chat, sắp xếp theo thời gian (mới nhất trước)
- Index này bao phủ cả filter VÀ sort trong 1 lần scan

**Performance Impact:**

- Không cần sort riêng - data đã sorted trong index
- Query time: O(log n + k) với k là số messages cần lấy
- Load 20 messages từ 1 triệu messages: ~20 index lookups + 20 documents

**Tại sao dùng compound index:**

- Index riêng `{ chatId: 1 }` + sort trên memory = **chậm**
- Compound index `{ chatId: 1, timestamp: -1 }` = **nhanh**, data đã sorted

---

### 4. Message Collection - Index cho Cursor-based Pagination

```javascript
// Index cho cursor-based pagination
messageSchema.index({ chatId: 1, _id: -1 });
```

**Mục đích:**

- **Cursor-based pagination:** `find({ chatId, _id: { $lt: cursor } }).sort({ _id: -1 })`
- Dùng `_id` thay vì `timestamp` vì:
  - `_id` có embedded timestamp (ObjectId structure)
  - `_id` là unique và monotonically increasing
  - Tránh vấn đề duplicate timestamp

**Performance Impact:**

- Không cần `skip()` - tránh scan qua các documents đã load
- Consistent performance kể cả với deep pagination
- Query page 1000: ~20 operations (giống như page 1)

**So sánh:**

```javascript
// ❌ BAD: Offset-based pagination
.skip(1000).limit(20) // Phải scan qua 1000 docs để skip

// ✅ GOOD: Cursor-based pagination
.find({ _id: { $lt: lastId } }).limit(20) // Chỉ lấy 20 docs
```

---

### 5. Message Collection - Index theo User

```javascript
// Index cho query messages của 1 user
messageSchema.index({ senderId: 1 });
```

**Mục đích:**

- Lấy tất cả tin nhắn của 1 user (across all chats)
- Phục vụ cho endpoint: `GET /api/user/:userId/messages`
- Use cases: User analytics, export data, GDPR compliance

**Performance Impact:**

- Query all messages của 1 user: O(log n + k)
- Hữu ích cho features tương lai

---

## 🔄 Cursor-based Pagination

### Cách hoạt động

**Flow:**

1. **Initial request:** `GET /api/chat/:chatId/messages?limit=20`

   - Backend trả về 20 messages mới nhất
   - Kèm theo `nextCursor` (là `_id` của message cuối cùng)

2. **Load more:** `GET /api/chat/:chatId/messages?limit=20&cursor=<nextCursor>`

   - Backend query: `find({ chatId, _id: { $lt: cursor } })`
   - Lấy 20 messages **cũ hơn** cursor
   - Trả về `nextCursor` mới

3. **Repeat** cho đến khi `hasMore === false`

### Code Implementation

**Backend (app.js):**

```javascript
const query = { chatId: req.params.chatId };

if (cursor) {
  query._id = { $lt: cursor }; // Messages cũ hơn cursor
}

const messages = await Message.find(query)
  .sort({ _id: -1 })
  .limit(limit + 1) // +1 để check hasMore
  .populate("senderId", "username")
  .lean(); // Performance boost

const hasMore = messages.length > limit;
if (hasMore) messages.pop();

const nextCursor =
  messages.length > 0 ? messages[messages.length - 1]._id : null;
```

**Frontend (App.jsx):**

```javascript
// State
const [nextCursor, setNextCursor] = useState(null);

// Load messages
let url = `${API_URL}/chat/${chatId}/messages?limit=20`;
if (cursor) {
  url += `&cursor=${cursor}`;
}

// Update state
setNextCursor(data.nextCursor);
setHasMoreMessages(data.hasMore);
```

### Tại sao Cursor > Offset?

| Feature                 | Offset-based (skip)         | Cursor-based |
| ----------------------- | --------------------------- | ------------ |
| **Performance**         | Degraded khi skip lớn       | Consistent   |
| **Query với skip=1000** | Scan 1000 docs              | Scan 0 docs  |
| **Index usage**         | Partial                     | Full         |
| **Consistency**         | ❌ Bị lỗi khi data thay đổi | ✅ Reliable  |
| **Memory**              | Server cache nhiều          | Minimal      |

**Ví dụ vấn đề với offset:**

```
User load page 10 (skip=200)
→ New message arrives
→ User click next page (skip=220)
→ Bị miss 1 message hoặc duplicate!
```

Cursor-based không có vấn đề này vì dùng `_id` làm anchor point.

---

## 👥 Query Messages by User

**Endpoint mới:** `GET /api/user/:userId/messages`

**Use cases:**

- Export all messages của 1 user
- Analytics: Thống kê số lượng messages
- GDPR: User request data
- Moderation: Check user's message history

**Features:**

- Cursor-based pagination
- Populate chat info
- Cross-chat query

**Example:**

```bash
curl http://localhost:4000/api/user/123/messages?limit=50
```

Response:

```json
{
  "messages": [...],
  "hasMore": true,
  "nextCursor": "507f1f77bcf86cd799439011"
}
```

---

## ⚡ Performance Optimization Tips

### 1. Sử dụng `.lean()`

```javascript
// ❌ Chậm: Tạo full Mongoose documents
const messages = await Message.find(query);

// ✅ Nhanh: Return plain JavaScript objects
const messages = await Message.find(query).lean();
```

**Performance gain:** 2-5x faster, ít memory hơn

### 2. Index Coverage

Indexes hiện tại cover các query patterns chính:

- ✅ Login: `{ username: 1 }`
- ✅ Find chat: `{ participants: 1 }`
- ✅ Load messages: `{ chatId: 1, _id: -1 }`
- ✅ Pagination: `{ chatId: 1, _id: -1 }`
- ✅ User messages: `{ senderId: 1 }`

### 3. Limit + 1 Trick

```javascript
.limit(limit + 1) // Lấy thêm 1

const hasMore = messages.length > limit;
if (hasMore) messages.pop(); // Bỏ message thừa
```

Tránh phải count documents riêng (expensive operation).

### 4. Populate Selectively

```javascript
// ❌ Populate tất cả fields
.populate("senderId")

// ✅ Chỉ populate fields cần thiết
.populate("senderId", "username")
```

---

## 📊 Expected Performance Metrics

### Với 1 triệu messages

| Operation              | Without Index | With Index | Speedup |
| ---------------------- | ------------- | ---------- | ------- |
| Login by username      | 500ms         | 5ms        | 100x    |
| Find chat              | 300ms         | 10ms       | 30x     |
| Load 20 messages       | 800ms         | 15ms       | 53x     |
| Load page 100 (offset) | 2000ms        | 500ms      | 4x      |
| Load page 100 (cursor) | N/A           | 15ms       | 133x    |

### Database Size Impact

**Index Storage:**

- User index: ~50 bytes × users
- Chat index: ~100 bytes × chats
- Message indexes: ~150 bytes × messages × 3 indexes

**Example:** 1M messages = ~450MB indexes (acceptable overhead)

---

## 🔍 Monitoring & Verification

### Check Indexes

```javascript
// MongoDB shell
db.messages.getIndexes();
db.messages.stats();
```

### Analyze Query Performance

```javascript
// Enable query profiling
db.messages.find({ chatId: "..." }).explain("executionStats");
```

Look for:

- `"stage": "IXSCAN"` (Good - using index)
- `"stage": "COLLSCAN"` (Bad - full collection scan)

### Index Usage Stats

```javascript
db.messages.aggregate([{ $indexStats: {} }]);
```

---

## 🎯 Summary

**Indexes Implemented:** 5 indexes
**Pagination:** Cursor-based (optimal performance)
**Query Patterns:** Fully covered
**Performance:** 30-100x faster
**Scalability:** Ready for millions of messages

**Key Takeaways:**

1. ✅ Compound indexes for filter + sort
2. ✅ Cursor-based pagination for deep pages
3. ✅ `.lean()` for read-heavy operations
4. ✅ Selective population to minimize data transfer
5. ✅ ObjectId-based cursors for reliability

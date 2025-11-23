// server.js - DivineNex (final)
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import dotenv from "dotenv";
import { google } from "googleapis";
import admin from "firebase-admin";
import axios from "axios";
const KEYFILEPATH = './service-account.json'; // 👈 Yeh aapka downloaded service account file ka naam
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

const auth = new google.auth.GoogleAuth({
  keyFile: KEYFILEPATH,
  scopes: SCOPES,
});

const drive = google.drive({ version: 'v3', auth });

dotenv.config();

const fs = require("fs");
const { google } = require("googleapis");
const PORT = process.env.PORT || 3000;
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || "";
const CLEANUP_HOURS = Number(process.env.CLEANUP_HOURS || 24);
if (!process.env.SERVICE_ACCOUNT_JSON) {
  console.error("SERVICE_ACCOUNT_JSON not provided. Please set as env var in Render/Host.");
  process.exit(1);
}
if (!DRIVE_FOLDER_ID) {
  console.error("DRIVE_FOLDER_ID not set. Exiting.");
  process.exit(1);
}

// Parse service account JSON from env (it can be raw JSON or base64)
let saJsonRaw = process.env.SERVICE_ACCOUNT_JSON.trim();
try {
  // if base64-ish, try decode
  if (!saJsonRaw.startsWith("{") && /^[A-Za-z0-9+/=\s]+$/.test(saJsonRaw) && saJsonRaw.length > 200) {
    saJsonRaw = Buffer.from(saJsonRaw, "base64").toString("utf8");
  }
} catch (e) {
  // proceed
}
let serviceAccount;
try {
  serviceAccount = JSON.parse(saJsonRaw);
} catch (e) {
  console.error("Failed to parse SERVICE_ACCOUNT_JSON:", e.message || e);
  process.exit(1);
}

// Initialize Firebase Admin (Firestore + optional Storage)
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || undefined
});
const db = admin.firestore();

// Initialize Google Drive client (use same service account)
const auth = new google.auth.GoogleAuth({
  credentials: serviceAccount,
  scopes: ["https://www.googleapis.com/auth/drive"]
});
const drive = google.drive({ version: "v3", auth });

const app = express();
app.use(cors());
app.use(helmet());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// rate limiter
app.use(rateLimit({ windowMs: 60 * 1000, max: 120 }));

// multer (memory)
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB

// HEALTH
app.get("/health", (req, res) => res.json({ ok: true, now: Date.now() }));

// create/update guest profile
app.post("/guest", async (req, res) => {
  try {
    const { name, email, phone } = req.body || {};
    if (!name || !email || !phone) return res.status(400).json({ error: "Missing name/email/phone" });
    const guestId = email.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
    await db.collection("guests").doc(guestId).set({ name, email, phone, guestId, updatedAt: Date.now() }, { merge: true });
    return res.json({ success: true, guestId });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server_error", detail: e.message });
  }
});

// upload post (text + optional single file)
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const { guestId, title, text } = req.body || {};
    if (!guestId || !title) return res.status(400).json({ error: "guestId & title required" });
    // enforce 500 words limit
    if (text && text.split(/\s+/).length > 500) return res.status(400).json({ error: "text_too_long" });

    let fileMeta = null;
    if (req.file) {
      const filename = `${Date.now()}_${req.file.originalname}`.replace(/\s+/g, "_").slice(0, 200);
      const mediaStream = Buffer.from(req.file.buffer);
      const resp = await drive.files.create({
        requestBody: { name: filename, parents: [DRIVE_FOLDER_ID] },
        media: { mimeType: req.file.mimetype, body: mediaStream },
        fields: "id, name"
      });
      const fileId = resp.data.id;
      // set public permission (anyone with link can view)
      await drive.permissions.create({ fileId, requestBody: { role: "reader", type: "anyone" } }).catch(() => {});
      fileMeta = { id: fileId, url: `https://drive.google.com/uc?id=${fileId}`, name: resp.data.name };
    }

    const docRef = db.collection("posts").doc(); // auto id
    const payload = {
      guestId,
      title,
      text: text || "",
      file: fileMeta,
      createdAt: Date.now(),
      expiresAt: Date.now() + CLEANUP_HOURS * 3600 * 1000
    };
    await docRef.set(payload);
    // optional: add to user's own list
    await db.collection("guests").doc(guestId).set({ lastPostAt: Date.now() }, { merge: true });

    // broadcast via a lightweight placeholder (if you later add socket.io)
    // For now just respond
    return res.json({ success: true, id: docRef.id, payload });
  } catch (e) {
    console.error("upload error:", e);
    return res.status(500).json({ error: "upload_failed", detail: String(e.message) });
  }
});

// list posts (with simple pagination)
app.get("/posts", async (req, res) => {
  try {
    const qSnap = await db.collection("posts").orderBy("createdAt", "desc").limit(100).get();
    const items = [];
    qSnap.forEach(d => items.push({ id: d.id, ...d.data() }));
    return res.json({ posts: items });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "read_failed" });
  }
});

// add friend
app.post("/friend", async (req, res) => {
  try {
    const { guestId, friendId } = req.body || {};
    if (!guestId || !friendId) return res.status(400).json({ error: "missing" });
    const ref = db.collection("guests").doc(guestId);
    await ref.set({ friends: admin.firestore.FieldValue.arrayUnion(friendId) }, { merge: true });
    return res.json({ success: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "friend_failed" });
  }
});

app.post('/upload', async (req, res) => {
  try {
    const filePath = req.body.filePath; // Mobile frontend se file path milega

    const response = await drive.files.create({
      requestBody: {
        name: `upload_${Date.now()}`, 
        mimeType: 'image/jpeg', // 👈 Change if needed
      },
      media: {
        mimeType: 'image/jpeg',
        body: fs.createReadStream(filePath),
      },
    });

    res.json({ success: true, fileId: response.data.id });

  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// people search
app.get("/people", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const coll = db.collection("guests");
    if (!q) {
      const snap = await coll.limit(100).get();
      const out = []; snap.forEach(d => out.push(d.data())); return res.json({ people: out });
    }
    // simple search: name contains (not highly efficient but works)
    const snap = await coll.get();
    const out = [];
    snap.forEach(d => {
      const data = d.data();
      if ((data.name || "").toLowerCase().includes(q.toLowerCase())) out.push(data);
    });
    return res.json({ people: out.slice(0, 200) });
  } catch (e) {
    console.error(e); return res.status(500).json({ error: "search_failed" });
  }
});

// cleanup job: delete expired posts & their drive files
async function cleanupExpiredPostsOnce() {
  try {
    const now = Date.now();
    const snap = await db.collection("posts").where("expiresAt", "<=", now).get();
    const deletes = [];
    snap.forEach(docSnap => {
      const p = docSnap.data();
      if (p.file && p.file.id) {
        deletes.push(drive.files.delete({ fileId: p.file.id }).catch(err => console.warn("drive delete failed", err?.message)));
      }
      deletes.push(db.collection("posts").doc(docSnap.id).delete().catch(() => {}));
    });
    await Promise.all(deletes);
    console.log("cleanup done, removed:", deletes.length);
  } catch (e) {
    console.error("cleanup error", e);
  }
}
// run cleanup hourly
setInterval(cleanupExpiredPostsOnce, 60 * 60 * 1000);
// initial delayed run after start
setTimeout(cleanupExpiredPostsOnce, 2 * 60 * 1000);

// GDELT simple proxy (example)
app.get("/news", async (req, res) => {
  try {
    const q = req.query.q || "India";
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=ArtList&format=json`;
    const r = await axios.get(url, { timeout: 10000 });
    if (r.data && r.data.articles) return res.json({ articles: r.data.articles });
    return res.json({ articles: [] });
  } catch (e) {
    console.error("news err", e?.message || e); return res.status(500).json({ error: "news_failed" });
  }
});

app.listen(PORT, () => console.log(`DivineNex server listening on ${PORT}`));

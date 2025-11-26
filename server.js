// server.js — DivineNex (Stable Release)

import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import dotenv from "dotenv";
import { google } from "googleapis";
import admin from "firebase-admin";
import axios from "axios";
import fs from "fs";

dotenv.config();

// =============================
// CHECK ENV VARIABLES
// =============================
const PORT = process.env.PORT || 3000;
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;
const SERVICE_JSON = process.env.SERVICE_ACCOUNT_JSON;
const CLEANUP_HOURS = Number(process.env.CLEANUP_HOURS || 24);

if (!SERVICE_JSON) {
  console.error("❌ SERVICE_ACCOUNT_JSON missing!");
  process.exit(1);
}
if (!DRIVE_FOLDER_ID) {
  console.error("❌ DRIVE_FOLDER_ID missing!");
  process.exit(1);
}

// =============================
// PARSE SERVICE ACCOUNT
// =============================
let jsonRaw = SERVICE_JSON.trim();
try {
  if (!jsonRaw.startsWith("{")) {
    jsonRaw = Buffer.from(jsonRaw, "base64").toString("utf8");
  }
} catch (_) {}
let serviceAccount;
try {
  serviceAccount = JSON.parse(jsonRaw);
} catch (e) {
  console.error("❌ Invalid SERVICE_ACCOUNT_JSON:", e.message);
  process.exit(1);
}

// =============================
// INITIALIZE FIREBASE
// =============================
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// =============================
// INITIALIZE GOOGLE DRIVE
// =============================
const auth = new google.auth.GoogleAuth({
  credentials: serviceAccount,
  scopes: ["https://www.googleapis.com/auth/drive"],
});
const drive = google.drive({ version: "v3", auth });

// =============================
// EXPRESS APP
// =============================
const app = express();
app.use(cors());
app.options("*", cors());
app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =============================
// RATE LIMIT
// =============================
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 200,
}));

// =============================
// MULTER - MEMORY STORAGE
// =============================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

// =============================
// ROOT & TEST ENDPOINT
// =============================
app.get("/", (_, res) => res.json({ ok: true, msg: "Backend is live!" }));
app.get("/test", (_, res) => res.json({ test: "success", time: Date.now() }));

// =============================
// CREATE / UPDATE GUEST
// =============================
app.post("/guest", async (req, res) => {
  try {
    const { name, email, phone } = req.body;
    if (!name || !email) return res.status(400).json({ error: "missing_fields" });

    const gid = email.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
    await db.collection("guests").doc(gid).set({
      name, email, phone,
      updatedAt: Date.now(),
    }, { merge: true });

    return res.json({ success: true, guestId: gid });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "guest_failed" });
  }
});

// =============================
// UPLOAD POST (TEXT + OPTIONAL FILE)
// =============================
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const { guestId, title, text } = req.body;
    if (!guestId || !title) return res.status(400).json({ error: "required_fields" });

    let fileMeta = null;

    if (req.file) {
      const filename = `${Date.now()}_${req.file.originalname}`.replace(/\s+/g, "_");
      const media = Buffer.from(req.file.buffer);

      const uploadRes = await drive.files.create({
        requestBody: { name: filename, parents: [DRIVE_FOLDER_ID] },
        media: { mimeType: req.file.mimetype, body: media },
        fields: "id,name",
      });

      const fileId = uploadRes.data.id;

      // Make public
      await drive.permissions.create({
        fileId, requestBody: { role: "reader", type: "anyone" }
      }).catch(() => {});

      fileMeta = {
        id: fileId,
        url: `https://drive.google.com/uc?id=${fileId}`,
        name: uploadRes.data.name,
      };
    }

    const ref = db.collection("posts").doc();
    await ref.set({
      guestId, title,
      text: text || "",
      file: fileMeta,
      createdAt: Date.now(),
      expiresAt: Date.now() + CLEANUP_HOURS * 3600 * 1000,
    });

    res.json({ success: true, id: ref.id });
  } catch (e) {
    console.error("upload:", e);
    res.status(500).json({ error: "upload_failed" });
  }
});

// =============================
// GET POSTS
// =============================
app.get("/posts", async (_, res) => {
  try {
    const snap = await db.collection("posts").orderBy("createdAt", "desc").limit(100).get();
    const arr = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ posts: arr });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "posts_failed" });
  }
});

// =============================
// ADD FRIEND
// =============================
app.post("/friend", async (req, res) => {
  try {
    const { guestId, friendId } = req.body;
    if (!guestId || !friendId) return res.status(400).json({ error: "missing_ids" });

    await db.collection("guests")
      .doc(guestId)
      .set({ friends: admin.firestore.FieldValue.arrayUnion(friendId) }, { merge: true });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "friend_failed" });
  }
});

// =============================
// CLEANUP EXPIRED POSTS
// =============================
async function cleanup() {
  const now = Date.now();
  const snap = await db.collection("posts").where("expiresAt", "<=", now).get();

  const jobs = snap.docs.map(async d => {
    const p = d.data();
    if (p.file?.id) {
      await drive.files.delete({ fileId: p.file.id }).catch(() => {});
    }
    await db.collection("posts").doc(d.id).delete().catch(() => {});
  });

  await Promise.all(jobs);
}
setInterval(cleanup, 3600 * 1000);
setTimeout(cleanup, 120000);

// =============================
// NEWS API PROXY
// =============================
app.get("/news", async (req, res) => {
  try {
    const q = req.query.q || "India";
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=ArtList&format=json`;
    const r = await axios.get(url);
    res.json({ articles: r.data?.articles || [] });
  } catch {
    res.status(500).json({ error: "news_failed" });
  }
});

// =============================
app.listen(PORT, () =>
  console.log("🚀 DivineNex backend running on port", PORT)
);

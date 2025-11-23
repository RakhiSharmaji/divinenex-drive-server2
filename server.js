// server.js – DivineNex Official Backend (Google Drive + Firebase Working)

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

// Mandatory env checks
if (!process.env.SERVICE_ACCOUNT_JSON) {
  console.error("❌ SERVICE_ACCOUNT_JSON missing!");
  process.exit(1);
}
if (!process.env.DRIVE_FOLDER_ID) {
  console.error("❌ DRIVE_FOLDER_ID missing!");
  process.exit(1);
}

// Parse Firebase key
let sa = process.env.SERVICE_ACCOUNT_JSON.trim();
try {
  if (!sa.startsWith("{") && /^[A-Za-z0-9+/=]+$/.test(sa)) {
    sa = Buffer.from(sa, "base64").toString("utf8");
  }
} catch {}
const serviceAccount = JSON.parse(sa);

// Initialize Firebase
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// Setup Google Drive Auth
const auth = new google.auth.GoogleAuth({
  credentials: serviceAccount,
  scopes: ["https://www.googleapis.com/auth/drive.file"],
});
const drive = google.drive({ version: "v3", auth });

const PORT = process.env.PORT || 3000;
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;
const CLEANUP_HOURS = Number(process.env.CLEANUP_HOURS || 24);

const app = express();
app.use(cors());
app.use(helmet());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(rateLimit({ windowMs: 60000, max: 100 }));

// Multer for file uploads
const upload = multer({ storage: multer.memoryStorage() });

// Default home
app.get("/", (req, res) => {
  res.json({ divineNex: "Backend is Live!", time: Date.now() });
});

// Guest Signup / Update
app.post("/guest", async (req, res) => {
  try {
    const { name, email, phone } = req.body;
    if (!name || !email || !phone)
      return res.status(400).json({ error: "missing_fields" });

    const guestId = email.replace(/[^a-z0-9]/gi, "_").toLowerCase();
    await db.collection("guests").doc(guestId).set(
      {
        name,
        email,
        phone,
        guestId,
        updatedAt: Date.now(),
      },
      { merge: true }
    );

    res.json({ success: true, guestId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "guest_failed" });
  }
});

// Upload Post + File
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const { guestId, title, text } = req.body;
    if (!guestId || !title)
      return res.status(400).json({ error: "guestId & title required" });

    let file = null;
    if (req.file) {
      const resp = await drive.files.create({
        requestBody: {
          name: `${Date.now()}_${req.file.originalname}`.replace(/\s+/g, "_"),
          parents: [DRIVE_FOLDER_ID],
        },
        media: { mimeType: req.file.mimetype, body: req.file.buffer },
        fields: "id,name",
      });

      await drive.permissions.create({
        fileId: resp.data.id,
        requestBody: { role: "reader", type: "anyone" },
      });

      file = {
        id: resp.data.id,
        url: `https://drive.google.com/uc?id=${resp.data.id}`,
        name: resp.data.name,
      };
    }

    const post = {
      guestId,
      title,
      text: text || "",
      file,
      createdAt: Date.now(),
      expiresAt: Date.now() + CLEANUP_HOURS * 3600 * 1000,
    };

    const doc = await db.collection("posts").add(post);
    res.json({ success: true, id: doc.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "upload_failed" });
  }
});

// People Search
app.get("/people", async (req, res) => {
  try {
    const q = (req.query.q || "").toLowerCase();
    const snap = await db.collection("guests").limit(1000).get();
    const out = [];
    snap.forEach((d) => {
      const g = d.data();
      if (g.name.toLowerCase().includes(q)) out.push(g);
    });
    res.json({ people: out });
  } catch {
    res.status(500).json({ error: "search_failed" });
  }
});

// List latest posts
app.get("/posts", async (req, res) => {
  try {
    const snap = await db
      .collection("posts")
      .orderBy("createdAt", "desc")
      .limit(50)
      .get();
    const posts = [];
    snap.forEach((d) => posts.push({ id: d.id, ...d.data() }));
    res.json({ posts });
  } catch {
    res.status(500).json({ error: "read_failed" });
  }
});

// News
app.get("/news", async (req, res) => {
  try {
    const q = req.query.q || "India";
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(
      q
    )}&mode=ArtList&format=json`;
    const r = await axios.get(url);
    res.json({ articles: r.data.articles || [] });
  } catch (e) {
    res.status(500).json({ error: "news_failed" });
  }
});

// Auto delete expired posts
setInterval(async () => {
  const now = Date.now();
  const snap = await db.collection("posts").where("expiresAt", "<=", now).get();
  snap.forEach(async (d) => {
    const post = d.data();
    if (post.file?.id) await drive.files.delete({ fileId: post.file.id });
    await d.ref.delete();
  });
}, 3600 * 1000);

app.listen(PORT, () =>
  console.log(`🔥 DivineNex Server Running on Port ${PORT}`)
);

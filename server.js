import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { initializeApp } from "firebase/app";
import { getFirestore, doc, setDoc, getDoc, collection, getDocs, query, where } from "firebase/firestore";
import { google } from "googleapis";
import multer from "multer";
import dotenv from "dotenv";
import fs from "fs";
import axios from "axios";

dotenv.config();

const app = express();
app.use(cors());
app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiter
const limiter = rateLimit({ windowMs: 1000 * 60, max: 100 });
app.use(limiter);

// Firebase setup
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID
};
const appFirebase = initializeApp(firebaseConfig);
const db = getFirestore(appFirebase);

// Google Drive setup
const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
const auth = new google.auth.GoogleAuth({
  credentials: serviceAccount,
  scopes: ["https://www.googleapis.com/auth/drive.file"]
});
const drive = google.drive({ version: "v3", auth });
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;
const CLEANUP_HOURS = parseInt(process.env.CLEANUP_HOURS || "24");

// Multer setup for uploads
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Routes

// Health check
app.get("/", (req, res) => res.send("DivineNex Server Running OK"));

// Guest Profile Create/Check
app.post("/guest", async (req, res) => {
  const { name, email, phone } = req.body;
  if (!name || !email || !phone) return res.status(400).send("Missing fields");
  const guestId = email.replace(/[^a-zA-Z0-9]/g, "_");
  const docRef = doc(db, "guests", guestId);
  await setDoc(docRef, { name, email, phone, guestId }, { merge: true });
  res.json({ guestId });
});

// Upload Post / Article
app.post("/upload", upload.single("file"), async (req, res) => {
  const { guestId, title, description } = req.body;
  if (!guestId || !title) return res.status(400).send("Missing guestId or title");

  let fileUrl = null;
  if (req.file) {
    const fileMetadata = { name: req.file.originalname, parents: [DRIVE_FOLDER_ID] };
    const media = { mimeType: req.file.mimetype, body: Buffer.from(req.file.buffer) };
    const response = await drive.files.create({ requestBody: fileMetadata, media: media, fields: "id" });
    fileUrl = `https://drive.google.com/uc?id=${response.data.id}`;
  }

  const postDoc = doc(db, "posts", `${guestId}_${Date.now()}`);
  await setDoc(postDoc, { guestId, title, description, fileUrl, createdAt: Date.now() });
  res.json({ success: true, fileUrl });
});

// List Posts (latest first)
app.get("/posts", async (req, res) => {
  const postsCol = collection(db, "posts");
  const postsSnapshot = await getDocs(postsCol);
  const posts = [];
  postsSnapshot.forEach(doc => posts.push(doc.data()));
  posts.sort((a, b) => b.createdAt - a.createdAt);
  res.json(posts);
});

// Auto cleanup old posts
const cleanupPosts = async () => {
  const postsCol = collection(db, "posts");
  const snapshot = await getDocs(postsCol);
  const now = Date.now();
  snapshot.forEach(async (docSnap) => {
    const post = docSnap.data();
    if (now - post.createdAt > CLEANUP_HOURS * 3600 * 1000) {
      if (post.fileUrl) {
        const fileId = post.fileUrl.split("id=")[1];
        await drive.files.delete({ fileId }).catch(() => {});
      }
      await doc(db, "posts", docSnap.id).delete().catch(() => {});
    }
  });
};
setInterval(cleanupPosts, 60 * 60 * 1000); // hourly check

// Live news (GDELT example)
app.get("/news", async (req, res) => {
  try {
    const response = await axios.get("https://api.gdeltproject.org/api/v2/doc/doc?query=India&mode=ArtList&format=json");
    res.json(response.data.articles || []);
  } catch (err) { res.status(500).send(err.toString()); }
});

// Server start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DivineNex server running on port ${PORT}`));

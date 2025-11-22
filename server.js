/**
 * server.js
 * DivineNex — Secure Node server for Google Drive uploads + embedded frontend
 *
 * Security notes:
 *  - Do NOT commit credentials into git.
 *  - Provide service account JSON as env var SERVICE_ACCOUNT_JSON (raw JSON or base64).
 *  - Provide DRIVE_FOLDER_ID env var.
 *
 * Usage locally:
 *  export SERVICE_ACCOUNT_JSON="$(cat /path/to/key.json)"
 *  export DRIVE_FOLDER_ID="1KCIMvWil0HyRg6pgOUxCHrQwfUwkKTMI"
 *  node server.js
 */
import express from 'express';
import http from 'http';
import { Server as IOServer } from 'socket.io';
import helmet from 'helmet';
import bodyParser from 'body-parser';
import rateLimit from 'express-rate-limit';
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import stream from 'stream';

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || '';
if(!DRIVE_FOLDER_ID){
  console.error('ERROR: DRIVE_FOLDER_ID env var not set. Exiting.');
  process.exit(1);
}

const app = express();
const server = http.createServer(app);
const io = new IOServer(server, { cors: { origin: '*' } });

// Basic security
app.use(helmet());
// JSON body parser
app.use(bodyParser.json({ limit: '150kb' }));

// rate-limit for uploads
const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  message: { error: 'Too many requests, slow down.' }
});

// Temporary credential file path inside container
const CRED_PATH = path.resolve('./.sa_credentials.json');

// Write credentials file from SERVICE_ACCOUNT_JSON env var (raw or base64)
function ensureCredentialsFile(){
  const raw = process.env.SERVICE_ACCOUNT_JSON || '';
  if(!raw) {
    console.error('SERVICE_ACCOUNT_JSON not provided. Please set as env var in Render/Host.');
    process.exit(1);
  }
  // detect base64 (rough check: only base64 chars and length large)
  const base64pattern = /^[A-Za-z0-9+/=\s]+$/;
  let content = raw.trim();
  // if seems base64, try decode
  if(base64pattern.test(content) && content.length > 200 && !content.startsWith('{')) {
    try {
      const buf = Buffer.from(content, 'base64');
      content = buf.toString('utf8');
    } catch(e) {
      // keep as-is
    }
  }
  // final check: must start with {
  if(!content.startsWith('{')) {
    console.error('SERVICE_ACCOUNT_JSON does not look like JSON. Please provide valid JSON or base64-encoded JSON.');
    process.exit(1);
  }
  // write file
  try{
    fs.writeFileSync(CRED_PATH, content, { mode: 0o600 });
    process.env.GOOGLE_APPLICATION_CREDENTIALS = CRED_PATH;
    console.log('Service account credentials written to', CRED_PATH);
  }catch(e){
    console.error('Failed to write credentials file:', e);
    process.exit(1);
  }
}

// Ensure credentials prepared
ensureCredentialsFile();

// Initialize Google Drive client
const auth = new google.auth.GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/drive.file']
});
const drive = google.drive({ version: 'v3', auth });

// Helper: sanitize filename
function sanitizeFilename(name){
  return String(name || 'article').replace(/[^\w\-\. ]+/g,'').trim().slice(0,200) || 'article';
}

// Upload string content as .txt file to Drive
async function uploadTextToDrive({ title, text }){
  const filename = `${sanitizeFilename(title)}_${Date.now()}.txt`;
  const passthrough = new stream.PassThrough();
  passthrough.end(Buffer.from(text, 'utf8'));

  const resp = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [DRIVE_FOLDER_ID],
      mimeType: 'text/plain'
    },
    media: {
      mimeType: 'text/plain',
      body: passthrough
    },
    fields: 'id, name, webViewLink'
  });
  return resp.data;
}

// In-memory recent list (ephemeral)
const recent = [];

// Serve frontend (embedded simple UI)
app.get('/', (req, res) => {
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.send(EMBED_HTML);
});

// Health
app.get('/health', (req, res) => res.json({ ok: true }));

// Recent list
app.get('/recent-articles', (req, res) => res.json({ articles: recent }));

// Upload endpoint
app.post('/upload-article', uploadLimiter, async (req, res) => {
  try{
    const { title, text } = req.body || {};
    if(!title || !text) return res.status(400).json({ error: 'Title & text required' });
    if(typeof text !== 'string' || text.length > 200000) return res.status(400).json({ error: 'Text invalid or too long' });

    const meta = await uploadTextToDrive({ title, text });
    const article = {
      id: meta.id || ('local_' + Date.now()),
      title,
      snippet: text.slice(0,800),
      driveLink: meta.webViewLink || null,
      createdAt: new Date().toISOString()
    };

    recent.unshift(article);
    if(recent.length > 300) recent.pop();

    io.emit('new-article', article);
    console.log('Uploaded', article.id, article.title);
    return res.json({ success: true, article });
  }catch(err){
    console.error('upload failed', err);
    return res.status(500).json({ error: 'Upload failed', detail: String(err.message || err) });
  }
});

// Socket.IO connections
io.on('connection', (socket) => {
  console.log('socket connected', socket.id);
  socket.emit('recent-articles', recent.slice(0,50));
  socket.on('disconnect', () => console.log('socket disconnected', socket.id));
});

// Start server
server.listen(PORT, () => {
  console.log('DivineNex Drive Server running on port', PORT);
});

// Simple embedded frontend (same as previous, clean)
const EMBED_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>DivineNex Publish</title>
<style>
  body{font-family:Inter,system-ui,Arial;background:#071026;color:#e8f6ff;padding:18px;display:flex;justify-content:center}
  .wrap{width:min(980px,98vw)}
  .card{background:linear-gradient(180deg,rgba(255,255,255,0.02),rgba(255,255,255,0.01));border-radius:12px;padding:14px;margin-bottom:12px}
  h1{margin:0 0 6px 0}
  .muted{color:#9fb0c8}
  input, textarea{width:100%;padding:10px;border-radius:8px;border:none;background:rgba(255,255,255,0.02);color:#e8f6ff}
  button{padding:8px 12px;border-radius:10px;border:none;background:linear-gradient(90deg,#45c6f0,#8ef6d1);color:#012;cursor:pointer;font-weight:700}
  .list{max-height:520px;overflow:auto}
  .article{padding:8px;border-radius:8px;background:rgba(255,255,255,0.01);margin-bottom:8px}
  .small{color:#9fb0c8;font-size:0.9rem}
</style></head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>DivineNex — Publish Article</h1>
      <div class="muted">Publish anonymously (admin/moderation recommended for production)</div>
      <div style="margin-top:12px">
        <label class="small">Title</label><input id="title" placeholder="Article title" />
      </div>
      <div style="margin-top:8px">
        <label class="small">Content</label><textarea id="text" rows="8" placeholder="Write your article..."></textarea>
      </div>
      <div style="margin-top:8px;display:flex;gap:8px;justify-content:flex-end">
        <button id="publish">Publish</button>
      </div>
      <div id="msg" class="small" style="margin-top:8px"></div>
    </div>

    <div class="card">
      <h3>Live Feed</h3>
      <div class="muted">Newly published articles appear in real-time.</div>
      <div id="feed" class="list" style="margin-top:8px"></div>
      <div style="margin-top:8px"><button id="refresh">Refresh</button></div>
    </div>
  </div>

<script src="/socket.io/socket.io.js"></script>
<script>
  const socket = io();
  const feed = document.getElementById('feed');
  const msg = document.getElementById('msg');

  function addToFeed(a){ const el=document.createElement('div'); el.className='article'; el.innerHTML='<b>'+escapeHtml(a.title)+'</b><div class="small">'+(a.driveLink?('<a href="'+a.driveLink+'" target="_blank">Open on Drive</a>'):'')+' • ' + new Date(a.createdAt||Date.now()).toLocaleString() + '</div><div style="margin-top:6px;color:#9fb0c8">'+escapeHtml(a.snippet)+'</div>'; feed.insertBefore(el, feed.firstChild); }
  socket.on('recent-articles', arr => { feed.innerHTML=''; arr.forEach(a=> addToFeed(a)); });
  socket.on('new-article', a=> addToFeed(a));

  async function loadRecent(){ try{ const r=await fetch('/recent-articles'); const j=await r.json(); feed.innerHTML=''; j.articles.forEach(a=> addToFeed(a)); }catch(e){ console.error(e); } }
  document.getElementById('refresh').addEventListener('click', loadRecent);

  async function publish(){
    const title = document.getElementById('title').value.trim();
    const text = document.getElementById('text').value.trim();
    if(!title||!text){ msg.textContent='Title & text required'; return; }
    msg.textContent='Publishing...';
    try{
      const r = await fetch('/upload-article',{ method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ title, text }) });
      const j = await r.json();
      if(r.ok && j.success){ msg.textContent='Published'; document.getElementById('title').value=''; document.getElementById('text').value=''; } else { msg.textContent='Publish failed: ' + (j.error || JSON.stringify(j)); }
    }catch(e){ msg.textContent='Error: ' + e.message; }
  }
  document.getElementById('publish').addEventListener('click', publish);
  function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[m]); }
  loadRecent();
</script>
</body>
</html>`;
// server.js
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const { Storage } = require('@google-cloud/storage');
const { Firestore, FieldValue } = require('@google-cloud/firestore');

const storage = new Storage();
const db = new Firestore({ databaseId: 'music-db' });
const app = express();
const PORT = process.env.PORT || 8080;

// === Middleware ===
app.use(cors({
  origin: ['https://musicabackend.uc.r.appspot.com', 'https://musicaguegan.netlify.app'],
  credentials: true
}));
app.use(express.json());
app.use(session({
  secret: 'musica-secret-2025',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: 'auto', httpOnly: true, maxAge: 86400000 } 
}));

// === Frontend ===
const FRONTEND_DIR = path.join(__dirname, 'frontend');
app.use(express.static(FRONTEND_DIR));
app.get('/favicon.ico', (req, res) => res.status(204).send());

// === Buckets ===
const BUCKETS = {
  mp3: 'musica-mp3-bucket',
  mix: 'musica-mix-bucket'
};
const WAVE_FOLDER = 'waveforms/';

// === Caches ===
const caches = {};

// =========================================================================
// UTILITAIRES
// =========================================================================
async function getAllFiles(bucketName) {
  const now = Date.now();
  const cache = caches[bucketName] || {};
  if (cache.files && (now - cache.loadedAt < 10 * 60 * 1000)) return cache.files;

  const [files] = await storage.bucket(bucketName).getFiles();
  const fileNames = files.map(f => f.name).filter(f => f.endsWith('.mp3'));
  
  caches[bucketName] = { files: fileNames, loadedAt: now };
  return fileNames;
}

async function getSongStats(songName) {
  try {
    const doc = await db.collection('song_stats').doc(songName).get();
    return doc.exists ? doc.data() : { likeCount: 0, dislikeCount: 0 };
  } catch (e) {
    console.error(`❌ Firestore getSongStats error for ${songName}:`, e.message);
    return { likeCount: 0, dislikeCount: 0 };
  }
}

// =========================================================================
// API
// =========================================================================
app.get('/api/next-song', async (req, res) => {
  try {
    const mode = req.query.mode === 'mix' ? 'mix' : 'mp3';
    const bucketName = BUCKETS[mode];

    if (!req.session.playedSongs) req.session.playedSongs = {};
    if (!req.session.playedSongs[mode]) req.session.playedSongs[mode] = [];

    const allSongs = await getAllFiles(bucketName);
    let played = req.session.playedSongs[mode];
    let available = allSongs.filter(s => !played.includes(s));

    if (available.length === 0) {
      req.session.playedSongs[mode] = [];
      available = allSongs;
      if (available.length === 0) return res.status(404).json({ error: `Aucune chanson trouvée dans le bucket ${bucketName}` });
    }

    const song = available[Math.floor(Math.random() * available.length)];
    req.session.playedSongs[mode].push(song);

    // JSON Waveform URL
    const jsonFile = WAVE_FOLDER + song.replace('.mp3', '.json');
    const file = storage.bucket(bucketName).file(jsonFile);
    const [signedUrl] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + 60 * 60 * 1000,
      version: 'v4'
    });

    const { likeCount, dislikeCount } = await getSongStats(song);
    const color = '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0');
    const inverse = '#' + (16777215 - parseInt(color.substring(1), 16)).toString(16).padStart(6, '0');

    res.json({
      songName: song.replace('.mp3', ''),
      songFileName: song,
      waveformUrl: signedUrl,
      color,
      textColor: inverse,
      likeCount,
      dislikeCount
    });
  } catch (err) {
    console.error('❌ /api/next-song ERROR:', err.stack);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/song-feedback', async (req, res) => {
  try {
    const { songName, feedback } = req.body;
    if (!songName || !feedback) return res.status(400).json({ error: 'Données manquantes' });

    if (!req.session.votedSongs) req.session.votedSongs = {};
    if (req.session.votedSongs[songName]) return res.status(409).json({ error: 'Vous avez déjà voté.' });

    const statsRef = db.collection('song_stats').doc(songName);
    if (feedback === 'like') await statsRef.set({ likeCount: FieldValue.increment(1) }, { merge: true });
    else if (feedback === 'dislike') await statsRef.set({ dislikeCount: FieldValue.increment(1) }, { merge: true });

    req.session.votedSongs[songName] = true;
    const statsDoc = await statsRef.get();
    res.json(statsDoc.data() || { likeCount: 0, dislikeCount: 0 });
  } catch (e) {
    console.error('❌ FEEDBACK ERROR:', e.stack);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Frontend
app.get('/', (req, res) => res.sendFile(path.join(FRONTEND_DIR, 'index.html')));

app.listen(PORT, '0.0.0.0', () => console.log(`🎵 API sur http://0.0.0.0:${PORT}`));

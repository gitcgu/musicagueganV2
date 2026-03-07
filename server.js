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
  origin: [
    'https://musicabackend.uc.r.appspot.com',
    'https://musicaguegan.netlify.app'
  ],
  credentials: true
}));

app.use(express.json());
app.use(session({
  secret: 'musica-secret-2025',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: 'auto', httpOnly: true, maxAge: 86400000 }
}));

const FRONTEND_DIR = path.join(__dirname, 'frontend');
app.use(express.static(FRONTEND_DIR));
app.get('/favicon.ico', (req, res) => res.status(204).send());

// === Buckets ===
const MP3_BUCKET_NAME = 'musica-mp3-bucket';
const MIX_BUCKET_NAME = 'musica-mix-bucket';
const WAVE_BUCKET_SUFFIX = 'waveforms/';

// === Caches pour fichiers ===
const caches = {
  [MP3_BUCKET_NAME]: { files: null, loadedAt: 0 },
  [MIX_BUCKET_NAME]: { files: null, loadedAt: 0 }
};

// === Utilitaires ===
async function getAllFiles(bucketName) {
  const now = Date.now();
  const cache = caches[bucketName];
  if (cache.files && now - cache.loadedAt < 10 * 60 * 1000) return cache.files;

  const [files] = await storage.bucket(bucketName).getFiles();
  const fileNames = files.map(f => f.name).filter(f => f.endsWith('.mp3'));
  cache.files = fileNames;
  cache.loadedAt = now;
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

function getWaveformUrl(bucketName, fileName) {
  return `https://storage.googleapis.com/${bucketName}/${WAVE_BUCKET_SUFFIX}${fileName.replace('.mp3','.json')}`;
}

// === Routes API ===

// GET next-song
app.get('/api/next-song', async (req, res) => {
  try {
    const mode = req.query.mode === 'mix' ? 'mix' : 'mp3';
    const bucketName = mode === 'mix' ? MIX_BUCKET_NAME : MP3_BUCKET_NAME;

    if (!req.session.playedSongs) req.session.playedSongs = {};
    if (!req.session.playedSongs[bucketName]) req.session.playedSongs[bucketName] = [];

    const allSongs = await getAllFiles(bucketName);
    let played = req.session.playedSongs[bucketName];
    let available = allSongs.filter(s => !played.includes(s));

    if (!available.length) {
      req.session.playedSongs[bucketName] = [];
      available = allSongs;
      if (!available.length) return res.status(404).json({ error: `Aucune chanson dans le bucket ${bucketName}` });
    }

    const song = available[Math.floor(Math.random() * available.length)];
    req.session.playedSongs[bucketName].push(song);

    const file = storage.bucket(bucketName).file(song);
    const [signedUrl] = await file.getSignedUrl({ action: 'read', expires: Date.now() + 3600*1000, version: 'v4' });

    const { likeCount, dislikeCount } = await getSongStats(song);
    const waveformUrl = getWaveformUrl(bucketName, song);

    const color = '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6,'0');
    const inverse = '#' + (16777215 - parseInt(color.substring(1),16)).toString(16).padStart(6,'0');

    res.json({
      songName: song.replace('.mp3',''),
      url: signedUrl,
      fileName: song,
      waveformUrl,
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

// GET previous-song
app.get('/api/previous-song', async (req, res) => {
  try {
    const mode = req.query.mode === 'mix' ? 'mix' : 'mp3';
    const bucketName = mode === 'mix' ? MIX_BUCKET_NAME : MP3_BUCKET_NAME;

    if (!req.session.playedSongs || !req.session.playedSongs[bucketName] || req.session.playedSongs[bucketName].length < 2) {
      return res.status(400).json({ error: 'Pas de chanson précédente dans l\'historique.' });
    }

    req.session.playedSongs[bucketName].pop();
    const played = req.session.playedSongs[bucketName];
    const song = played[played.length-1];

    const file = storage.bucket(bucketName).file(song);
    const [signedUrl] = await file.getSignedUrl({ action: 'read', expires: Date.now() + 3600*1000, version: 'v4' });
    const { likeCount, dislikeCount } = await getSongStats(song);
    const waveformUrl = getWaveformUrl(bucketName, song);

    res.json({
      songName: song.replace('.mp3',''),
      url: signedUrl,
      fileName: song,
      waveformUrl,
      color: '#000000',
      textColor: '#FFFFFF',
      likeCount,
      dislikeCount
    });
  } catch (err) {
    console.error('❌ /api/previous-song ERROR:', err.stack);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST song-feedback
app.post('/api/song-feedback', async (req, res) => {
  try {
    const { songName, feedback } = req.body;
    if (!songName || !feedback) return res.status(400).json({ error: 'Données manquantes' });

    if (!req.session.votedSongs) req.session.votedSongs = {};
    if (req.session.votedSongs[songName]) return res.status(409).json({ error: 'Vote déjà enregistré.' });

    const statsRef = db.collection('song_stats').doc(songName);
    if (feedback === 'like') await statsRef.set({ likeCount: FieldValue.increment(1) }, { merge: true });
    else if (feedback === 'dislike') await statsRef.set({ dislikeCount: FieldValue.increment(1) }, { merge: true });
    else return res.status(400).json({ error: 'Feedback non valide.' });

    req.session.votedSongs[songName] = true;
    const statsDoc = await statsRef.get();
    const data = statsDoc.data() || { likeCount: 0, dislikeCount: 0 };
    res.json({ success:true, likeCount: data.likeCount || 0, dislikeCount: data.dislikeCount || 0 });
  } catch(e) {
    console.error('❌ FEEDBACK ERROR:', e.stack);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Frontend
app.get('/', (req,res) => res.sendFile(path.join(FRONTEND_DIR,'index.html')));

// Launch
const HOST = '0.0.0.0';
app.listen(PORT, HOST, () => console.log(`🎵 API sur http://${HOST}:${PORT}`));

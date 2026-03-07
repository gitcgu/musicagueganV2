const express = require('express');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const { Storage } = require('@google-cloud/storage');
const { Firestore, FieldValue } = require('@google-cloud/firestore');

const storage = new Storage();
const db = new Firestore();
const app = express();
const PORT = process.env.PORT || 8080;

const MP3_BUCKET_NAME = 'musica-mp3-bucket';
const MIX_BUCKET_NAME = 'musica-mix-bucket';
const WAVE_FOLDER = 'waveforms/';

app.use(cors({
  origin: ['https://musicabackend.uc.r.appspot.com', 'https://musicaguegan.netlify.app'], // adapte à tes origines front
  credentials: true,
}));

app.use(express.json());
app.use(session({
  secret: 'musica-secret-2025',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: 'auto', httpOnly: true, maxAge: 86400000 },
}));

const FRONTEND_DIR = path.join(__dirname, 'frontend');
app.use(express.static(FRONTEND_DIR));
app.get('/favicon.ico', (req, res) => res.status(204).send());

// Cache simple pour éviter trop de fetch GCS
const caches = {
  [MP3_BUCKET_NAME]: { files: null, loadedAt: 0 },
  [MIX_BUCKET_NAME]: { files: null, loadedAt: 0 }
};

async function getAllMp3(bucketName) {
  const now = Date.now();
  const cache = caches[bucketName];
  if (cache.files && (now - cache.loadedAt < 10 * 60 * 1000)) {
    return cache.files;
  }
  const [files] = await storage.bucket(bucketName).getFiles();
  const fileNames = files.map(f => f.name).filter(n => n.endsWith('.mp3'));
  caches[bucketName] = { files: fileNames, loadedAt: now };
  return fileNames;
}

async function getSignedUrl(bucketName, fileName) {
  const file = storage.bucket(bucketName).file(fileName);
  const [url] = await file.getSignedUrl({
    action: 'read',
    expires: Date.now() + 60 * 60 * 1000,
    version: 'v4',
  });
  return url;
}

async function getWaveformUrl(bucketName, fileName) {
  // Suppose que les JSON sont dans folder waveforms/, même nom que mp3 mais .json
  const jsonFileName = WAVE_FOLDER + fileName.replace('.mp3', '.json');
  try {
    const file = storage.bucket(bucketName).file(jsonFileName);
    const [exists] = await file.exists();
    if (!exists) return null;
    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + 60 * 60 * 1000,
      version: 'v4',
    });
    return url;
  } catch {
    return null;
  }
}

async function getSongStats(songName) {
  try {
    const doc = await db.collection('song_stats').doc(songName).get();
    if (!doc.exists) return { likeCount: 0, dislikeCount: 0 };
    return doc.data();
  } catch {
    return { likeCount: 0, dislikeCount: 0 };
  }
}

app.get('/api/next-song', async (req, res) => {
  try {
    const mode = req.query.mode === 'mix' ? 'mix' : 'mp3';
    const bucketName = mode === 'mix' ? MIX_BUCKET_NAME : MP3_BUCKET_NAME;

    if (!req.session.playedSongs) req.session.playedSongs = {};
    if (!req.session.playedSongs[bucketName]) req.session.playedSongs[bucketName] = [];

    const allSongs = await getAllMp3(bucketName);
    let played = req.session.playedSongs[bucketName];
    let available = allSongs.filter(s => !played.includes(s));

    if (available.length === 0) {
      req.session.playedSongs[bucketName] = [];
      available = allSongs;
      if (available.length === 0) return res.status(404).json({ error: `Aucune chanson dans ${bucketName}` });
    }

    const song = available[Math.floor(Math.random() * available.length)];
    req.session.playedSongs[bucketName].push(song);

    const url = await getSignedUrl(bucketName, song);
    const waveformUrl = await getWaveformUrl(bucketName, song);
    const stats = await getSongStats(song);

    const color = '#' + Math.floor(Math.random() * 0xFFFFFF).toString(16).padStart(6, '0');
    const inverse = '#' + (0xFFFFFF - parseInt(color.slice(1), 16)).toString(16).padStart(6, '0');

    res.json({
      songName: song.replace('.mp3', ''),
      fileName: song,
      url,
      waveformUrl,
      color,
      textColor: inverse,
      likeCount: stats.likeCount || 0,
      dislikeCount: stats.dislikeCount || 0,
    });
  } catch (e) {
    console.error('Erreur /api/next-song:', e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/previous-song', async (req, res) => {
  try {
    const mode = req.query.mode === 'mix' ? 'mix' : 'mp3';
    const bucketName = mode === 'mix' ? MIX_BUCKET_NAME : MP3_BUCKET_NAME;

    if (!req.session.playedSongs || !req.session.playedSongs[bucketName] || req.session.playedSongs[bucketName].length < 2) {
      return res.status(400).json({ error: 'Pas de chanson précédente' });
    }

    req.session.playedSongs[bucketName].pop(); // supprime la dernière jouée
    const song = req.session.playedSongs[bucketName][req.session.playedSongs[bucketName].length - 1];

    const url = await getSignedUrl(bucketName, song);
    const waveformUrl = await getWaveformUrl(bucketName, song);
    const stats = await getSongStats(song);

    res.json({
      songName: song.replace('.mp3', ''),
      fileName: song,
      url,
      waveformUrl,
      color: '#000000',
      textColor: '#FFFFFF',
      likeCount: stats.likeCount || 0,
      dislikeCount: stats.dislikeCount || 0,
    });
  } catch (e) {
    console.error('Erreur /api/previous-song:', e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/song-feedback', async (req, res) => {
  try {
    const { songName, feedback } = req.body;
    if (!songName || !feedback) return res.status(400).json({ error: 'Données manquantes' });

    if (!req.session.votedSongs) req.session.votedSongs = {};
    if (req.session.votedSongs[songName]) {
      return res.status(409).json({ error: 'Vote déjà enregistré.' });
    }

    const statsRef = db.collection('song_stats').doc(songName);
    if (feedback === 'like') await statsRef.set({ likeCount: FieldValue.increment(1) }, { merge: true });
    else if (feedback === 'dislike') await statsRef.set({ dislikeCount: FieldValue.increment(1) }, { merge: true });
    else return res.status(400).json({ error: 'Feedback invalide.' });

    req.session.votedSongs[songName] = true;
    const statsDoc = await statsRef.get();
    const data = statsDoc.data() || { likeCount: 0, dislikeCount: 0 };
    res.json({ success: true, likeCount: data.likeCount, dislikeCount: data.dislikeCount });
  } catch (e) {
    console.error('Erreur feedback:', e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
});

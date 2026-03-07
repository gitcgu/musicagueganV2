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

// Middleware
app.use(cors({
  origin: ['https://musicabackend.uc.r.appspot.com', 'https://musicaguegan.netlify.app'],
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

// Buckets
const MP3_BUCKET_NAME = 'musica-mp3-bucket';
const MIX_BUCKET_NAME = 'musica-mix-bucket';
const WAVEFORMS_FOLDER = 'waveforms'; // sous-dossier dans chaque bucket où sont stockés les JSON

// Caches
const caches = {
  [MP3_BUCKET_NAME]: { files: null, loadedAt: 0 },
  [MIX_BUCKET_NAME]: { files: null, loadedAt: 0 },
};

async function getAllAudioFiles(bucketName) {
  const now = Date.now();
  const cache = caches[bucketName];
  if (cache && cache.files && (now - cache.loadedAt < 10 * 60 * 1000)) {
    return cache.files;
  }

  const [files] = await storage.bucket(bucketName).getFiles();
  const audioFiles = files.map(f => f.name).filter(f => f.endsWith('.mp3'));
  caches[bucketName].files = audioFiles;
  caches[bucketName].loadedAt = now;
  return audioFiles;
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

async function getSongStats(songName) {
  try {
    const doc = await db.collection('song_stats').doc(songName).get();
    if (!doc.exists) return { likeCount: 0, dislikeCount: 0 };
    return doc.data();
  } catch (e) {
    console.error(`Firestore getSongStats error for ${songName}:`, e.message);
    return { likeCount: 0, dislikeCount: 0 };
  }
}

function waveformFileName(audioFileName) {
  return `${WAVEFORMS_FOLDER}/${audioFileName.replace(/\.mp3$/, '.json')}`;
}

async function buildSongResponse(bucketName, songFileName) {
  const songName = songFileName.replace('.mp3', '');
  const audioUrl = await getSignedUrl(bucketName, songFileName);
  let waveformUrl = null;
  try {
    waveformUrl = await getSignedUrl(bucketName, waveformFileName(songFileName));
  } catch {
    // JSON waveform peut ne pas exister, pas grave on laisse null
  }
  const { likeCount, dislikeCount } = await getSongStats(songName);
  // Couleur aléatoire et inverse
  const color = '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0');
  const inverse = '#' + (0xFFFFFF - parseInt(color.substring(1), 16)).toString(16).padStart(6, '0');

  return {
    songName,
    fileName: songFileName,
    url: audioUrl,
    waveformUrl,
    likeCount,
    dislikeCount,
    color,
    textColor: inverse,
  };
}

// API: next-song
app.get('/api/next-song', async (req, res) => {
  try {
    const mode = req.query.mode === 'mix' ? 'mix' : 'mp3';
    const bucketName = mode === 'mix' ? MIX_BUCKET_NAME : MP3_BUCKET_NAME;

    if (!req.session.playedSongs) req.session.playedSongs = {};
    if (!req.session.playedSongs[bucketName]) req.session.playedSongs[bucketName] = [];

    const allSongs = await getAllAudioFiles(bucketName);
    let played = req.session.playedSongs[bucketName];
    let available = allSongs.filter(s => !played.includes(s));

    if (available.length === 0) {
      req.session.playedSongs[bucketName] = [];
      available = allSongs;
      if (available.length === 0) {
        return res.status(404).json({ error: `Aucune chanson trouvée dans le bucket ${bucketName}` });
      }
    }

    const songFileName = available[Math.floor(Math.random() * available.length)];
    req.session.playedSongs[bucketName].push(songFileName);

    const response = await buildSongResponse(bucketName, songFileName);
    res.json(response);
  } catch (err) {
    console.error('❌ /api/next-song ERROR:', err.stack);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// API: previous-song
app.get('/api/previous-song', async (req, res) => {
  try {
    const mode = req.query.mode === 'mix' ? 'mix' : 'mp3';
    const bucketName = mode === 'mix' ? MIX_BUCKET_NAME : MP3_BUCKET_NAME;

    if (!req.session.playedSongs || !req.session.playedSongs[bucketName] || req.session.playedSongs[bucketName].length < 2) {
      return res.status(400).json({ error: 'Pas de chanson précédente dans l\'historique.' });
    }

    req.session.playedSongs[bucketName].pop();
    const songFileName = req.session.playedSongs[bucketName].slice(-1)[0];

    const response = await buildSongResponse(bucketName, songFileName);
    res.json(response);
  } catch (err) {
    console.error('❌ /api/previous-song ERROR:', err.stack);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// API: song-feedback
app.post('/api/song-feedback', async (req, res) => {
  try {
    const { songName, feedback } = req.body;
    if (!songName || !feedback) return res.status(400).json({ error: 'Données manquantes' });

    if (!req.session.votedSongs) req.session.votedSongs = {};
    if (req.session.votedSongs[songName]) {
      return res.status(409).json({ error: 'Vous avez déjà voté pour cette chanson.' });
    }

    const statsRef = db.collection('song_stats').doc(songName);
    if (feedback === 'like') await statsRef.set({ likeCount: FieldValue.increment(1) }, { merge: true });
    else if (feedback === 'dislike') await statsRef.set({ dislikeCount: FieldValue.increment(1) }, { merge: true });
    else return res.status(400).json({ error: 'Feedback non valide.' });

    req.session.votedSongs[songName] = true;
    const statsDoc = await statsRef.get();
    const data = statsDoc.data() || { likeCount: 0, dislikeCount: 0 };
    res.json({ success: true, likeCount: data.likeCount, dislikeCount: data.dislikeCount });
  } catch (e) {
    console.error('❌ FEEDBACK ERROR:', e.stack);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

// Server start
const HOST = '0.0.0.0';
app.listen(PORT, HOST, () => console.log(`🎵 API sur http://${HOST}:${PORT}`));

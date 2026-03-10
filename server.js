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

const MP3_BUCKET_NAME = 'musica-mp3-bucket';
const MIX_BUCKET_NAME = 'musica-mix-bucket';
const WAVE_FOLDER = 'waveforms/';
const POCHETTE_FILENAME = 'pochettes/pochette.jpg';

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

const caches = {
  [MP3_BUCKET_NAME]: { files: null, loadedAt: 0 },
  [MIX_BUCKET_NAME]: { files: null, loadedAt: 0 }
};

async function getAllMp3(bucketName) {
  const now = Date.now();
  const cache = caches[bucketName];
  if (cache.files && (now - cache.loadedAt < 10 * 60 * 1000)) return cache.files;
  const [files] = await storage.bucket(bucketName).getFiles();
  const fileNames = files.map(f => f.name).filter(n => n.endsWith('.mp3'));
  caches[bucketName] = { files: fileNames, loadedAt: now };
  return fileNames;
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

// ✅ SERVIR LES FICHIERS AUDIO ET WAVEFORM SANS CORS
app.get('/api/file/:type/:bucketType/:fileName', async (req, res) => {
  try {
    let { type, bucketType, fileName } = req.params;
    // Buckets: mix ou mp3
    let bucketName = bucketType === 'mix' ? MIX_BUCKET_NAME : MP3_BUCKET_NAME;

    // Décoder le nom de fichier
    let file;
    let contentType;

    if (type === 'audio') {
      file = storage.bucket(bucketName).file(decodeURIComponent(fileName));
      contentType = 'audio/mpeg';
    } else if (type === 'waveform') {
      file = storage.bucket(bucketName).file(WAVE_FOLDER + decodeURIComponent(fileName).replace('.mp3', '.json'));
      contentType = 'application/json';
    } else {
      return res.status(400).json({ error: 'Type invalide' });
    }

    // Vérifier l'existence dans le bucket choisi
    let [exists] = await file.exists();

    // Si pas trouvé, essayer l'autre bucket
    if (!exists) {
      const otherBucketName = bucketName === MIX_BUCKET_NAME ? MP3_BUCKET_NAME : MIX_BUCKET_NAME;
      bucketName = otherBucketName;
      if (type === 'audio') file = storage.bucket(bucketName).file(decodeURIComponent(fileName));
      else file = storage.bucket(bucketName).file(WAVE_FOLDER + decodeURIComponent(fileName).replace('.mp3', '.json'));

      [exists] = await file.exists();
    }

    if (!exists) {
      return res.status(404).json({ error: 'Fichier non trouvé' });
    }

    const [content] = await file.download();
    res.setHeader('Content-Type', contentType);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(content);
  } catch (e) {
    console.error('Erreur fichier:', e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

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

    const stats = await getSongStats(song);

    const color = '#' + Math.floor(Math.random() * 0xFFFFFF).toString(16).padStart(6, '0');
    const inverse = '#' + (0xFFFFFF - parseInt(color.slice(1), 16)).toString(16).padStart(6, '0');

    res.json({
      songName: song.replace('.mp3', ''),
      fileName: song,
      url: `/api/file/audio/${mode}/${encodeURIComponent(song)}`,
      waveformUrl: `/api/file/waveform/${mode}/${encodeURIComponent(song)}`,
      imageUrl: 'https://storage.googleapis.com/musica-mp3-bucket/pochettes/pochette.jpg',
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

    req.session.playedSongs[bucketName].pop();
    const song = req.session.playedSongs[bucketName][req.session.playedSongs[bucketName].length - 1];

    const stats = await getSongStats(song);

    res.json({
      songName: song.replace('.mp3', ''),
      fileName: song,
      url: `/api/file/audio/${mode}/${encodeURIComponent(song)}`,
      waveformUrl: `/api/file/waveform/${mode}/${encodeURIComponent(song)}`,
      imageUrl: 'https://storage.googleapis.com/musica-mp3-bucket/pochettes/pochette.jpg',
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
    if (req.session.votedSongs[songName]) return res.status(409).json({ error: 'Vote déjà enregistré.' });

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

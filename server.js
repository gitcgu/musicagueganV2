const express = require('express');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const { Storage } = require('@google-cloud/storage');
const { Firestore, FieldValue } = require('@google-cloud/firestore');
const fetch = require('node-fetch');

const storage = new Storage();
const db = new Firestore({ databaseId: 'music-db' });

const app = express();
const PORT = process.env.PORT || 8080;

const MP3_BUCKET_NAME = 'musica-mp3-bucket';
const MIX_BUCKET_NAME = 'musica-mix-bucket';
const WAVE_FOLDER = 'waveforms/';
const POCHETTE_FOLDER = 'pochettes/';
const POCHETTE_FILENAME = 'pochettes/pochette.jpg';
const DEFAULT_POCHETTE_URL = `https://storage.googleapis.com/${MP3_BUCKET_NAME}/${POCHETTE_FILENAME}`;

const { VertexAI } = require('@google-cloud/vertexai');
const vertexAI = new VertexAI({
  project: '836359398199',
  location: 'europe-west1',
});
const API_KEY = process.env.VERTEX_KEY;

app.use(cors({
  origin: ['http://localhost:8080', 'https://musicabackend.uc.r.appspot.com', 'https://musicaguegan.netlify.app'],
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

async function getImageUrl(songFileName, bucketName) {
  try {
    const specificPochettePath = `${POCHETTE_FOLDER}${songFileName.replace('.mp3', '.jpg')}`;
    const specificPochetteFile = storage.bucket(bucketName).file(specificPochettePath);
    const [exists] = await specificPochetteFile.exists();
    if (exists) {
      return `https://storage.googleapis.com/${bucketName}/${specificPochettePath}`;
    } else {
      return DEFAULT_POCHETTE_URL;
    }
  } catch (error) {
    console.error(`Erreur pochette ${songFileName}:`, error);
    return DEFAULT_POCHETTE_URL;
  }
}

async function getCountryFromIP(ip) {
  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=country`);
    const data = await res.json();
    return data.country || 'Unknown';
  } catch {
    return 'Unknown';
  }
}

// ✅ NOUVELLE ROUTE : Servir les waveforms JSON avec CORS
app.get('/api/waveform/:bucketType/:fileName', async (req, res) => {
  try {
    const { bucketType, fileName } = req.params;
    const bucketName = bucketType === 'mix' ? MIX_BUCKET_NAME : MP3_BUCKET_NAME;
    // const cleanFileName = decodeURIComponent(fileName).replace('.mp3', '.json');
    // const cleanFileName = decodeURIComponent(fileName) + '.json';
    const cleanFileName = decodeURIComponent(fileName).replace('.mp3', '') + '.json';
    const filePathInBucket = WAVE_FOLDER + cleanFileName;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }

    const file = storage.bucket(bucketName).file(filePathInBucket);
    const [exists] = await file.exists();

    if (!exists) {
      console.error(`❌ Waveform not found: ${filePathInBucket}`);
      return res.status(404).json({ error: 'Waveform not found' });
    }

    const [content] = await file.download();
    res.send(content);
    console.log(`✅ Waveform served: ${filePathInBucket}`);

  } catch (e) {
    console.error('❌ Erreur /api/waveform:', e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// ✅ SERVIR LES FICHIERS AUDIO
app.get('/api/file/:type/:bucketType/:fileName', async (req, res) => {
  try {
    const { type, bucketType, fileName } = req.params;
    const bucketName = bucketType === 'mix' ? MIX_BUCKET_NAME : MP3_BUCKET_NAME;
    const targetName = decodeURIComponent(fileName);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');

    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }

    let file;
    let contentType;

    if (type === 'audio') {
      file = storage.bucket(bucketName).file(targetName);
      contentType = 'audio/mpeg';
    } else if (type === 'waveform') {
      file = storage.bucket(bucketName).file(WAVE_FOLDER + targetName.replace('.mp3', '.json'));
      contentType = 'application/json';
    } else {
      return res.status(400).json({ error: 'Type invalide' });
    }

    let [exists] = await file.exists();

    if (!exists) {
      console.error(`❌ File not found: ${targetName} dans ${bucketName}`);
      return res.status(404).json({ error: 'Fichier non trouvé' });
    }

    if (type === 'audio') {
      const [metadata] = await file.getMetadata();
      const fileSize = metadata.size;
      const range = req.headers.range;

      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': contentType,
          'Access-Control-Allow-Origin': '*',
        });

        file.createReadStream({ start, end }).pipe(res);
      } else {
        res.setHeader('Content-Type', contentType);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Length', fileSize);
        file.createReadStream().pipe(res);
      }
    } else {
      const [content] = await file.download();
      res.setHeader('Content-Type', contentType);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.send(content);
    }
  } catch (e) {
    console.error('❌ Erreur /api/file:', e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

app.get('/api/next-song', async (req, res) => {
  try {
    const mode = req.query.mode === 'mix' ? 'mix' : 'mp3';
    const bucketName = mode === 'mix' ? MIX_BUCKET_NAME : MP3_BUCKET_NAME;
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const country = await getCountryFromIP(ip);
    console.log(`🌍 /api/next-song - IP: ${ip} - Mode: ${mode}`);

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

    const description = await generateSongDescription(song);
    const [stats, imageUrl] = await Promise.all([
      getSongStats(song),
      getImageUrl(song, bucketName)
    ]);

    const color = '#' + Math.floor(Math.random() * 0xFFFFFF).toString(16).padStart(6, '0');
    const inverse = '#' + (0xFFFFFF - parseInt(color.slice(1), 16)).toString(16).padStart(6, '0');

    res.json({
      songName: song.replace('.mp3', ''),
      fileName: song,
      url: `/api/file/audio/${mode}/${encodeURIComponent(song)}`,
      waveformUrl: `/api/file/waveform/${mode}/${encodeURIComponent(song)}`,
      imageUrl: imageUrl,
      description: description,
      color,
      textColor: inverse,
      likeCount: stats.likeCount || 0,
      dislikeCount: stats.dislikeCount || 0,
    });
  } catch (e) {
    console.error('❌ Erreur /api/next-song:', e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/previous-song', async (req, res) => {
  try {
    const mode = req.query.mode === 'mix' ? 'mix' : 'mp3';
    const bucketName = mode === 'mix' ? MIX_BUCKET_NAME : MP3_BUCKET_NAME;
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const country = await getCountryFromIP(ip);
    console.log(`🌍 /api/previous-song - IP: ${ip} - Mode: ${mode}`);

    if (!req.session.playedSongs || !req.session.playedSongs[bucketName] || req.session.playedSongs[bucketName].length < 2) {
      return res.status(400).json({ error: 'Pas de chanson précédente' });
    }

    req.session.playedSongs[bucketName].pop();
    const song = req.session.playedSongs[bucketName][req.session.playedSongs[bucketName].length - 1];

    const stats = await getSongStats(song);
    const imageUrl = await getImageUrl(song, bucketName);

    res.json({
      songName: song.replace('.mp3', ''),
      fileName: song,
      url: `/api/file/audio/${mode}/${encodeURIComponent(song)}`,
      waveformUrl: `/api/file/waveform/${mode}/${encodeURIComponent(song)}`,
      imageUrl: imageUrl,
      color: '#000000',
      textColor: '#FFFFFF',
      likeCount: stats.likeCount || 0,
      dislikeCount: stats.dislikeCount || 0,
    });
  } catch (e) {
    console.error('❌ Erreur /api/previous-song:', e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ✅ FIX : /api/mix-list avec waveformJsonUrl correct
app.get('/api/mix-list', async (req, res) => {
  try {
    const mixes = await getAllMp3(MIX_BUCKET_NAME);
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const country = await getCountryFromIP(ip);
    console.log(`🌍 /api/mix-list - IP: ${ip}`);

    const result = mixes.map(mix => ({
      name: mix.replace('.mp3', ''),
      fileName: mix,
      url: `/api/file/audio/mix/${encodeURIComponent(mix)}`,
      //waveformJsonUrl: `/api/waveform/mix/${encodeURIComponent(mix.replace('.mp3', ''))}`
      waveformJsonUrl: `/api/waveform/mix/${encodeURIComponent(mix)}`

    }));

    res.json(result);
  } catch (e) {
    console.error('❌ Erreur /api/mix-list:', e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

const GEMINI_ENABLED = false;

async function generateSongDescription(songName) {
  try {
    const doc = await db.collection('song_descriptions').doc(songName).get();
    if (doc.exists) {
      console.log('✅ Description du cache');
      return doc.data().text;
    }

    if (!GEMINI_ENABLED) {
      console.log('⚠️ Gemini désactivé');
      return 'Description indisponible (Gemini désactivé)';
    }

    const model = vertexAI.getGenerativeModel({ model: 'gemini-2.5-pro' });
    const response = await model.generateContent({
      contents: [{
        role: 'user',
        parts: [{
          text: `Décris brièvement "${songName.replace('.mp3', '')}" en 2 phrases`
        }]
      }]
    });

    const text = response.response.candidates[0].content.parts[0].text;
    await db.collection('song_descriptions').doc(songName).set({ text });
    console.log('✅ Description générée:', songName);
    return text;

  } catch (e) {
    console.error('❌ Erreur Gemini:', e.message);
    return 'Description non disponible';
  }
}

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
    console.error('❌ Erreur feedback:', e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

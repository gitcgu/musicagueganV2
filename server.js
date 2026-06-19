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

// --- Configuration des Buckets Cloud Storage ---
const MP3_BUCKET_NAME = 'musica-mp3-bucket';
const MIX_BUCKET_NAME = 'musica-mix-bucket';
const WAVE_FOLDER = 'waveforms/';
const POCHETTE_FOLDER = 'pochettes/';
const POCHETTE_FILENAME = 'pochettes/pochette.jpg';
const DEFAULT_POCHETTE_URL = `https://storage.googleapis.com/${MP3_BUCKET_NAME}/${POCHETTE_FILENAME}`;

// --- Configuration Vertex AI ---
const { VertexAI } = require('@google-cloud/vertexai');
const vertexAI = new VertexAI({
  project: '836359398199',
  location: 'europe-west1',
});
const API_KEY = process.env.VERTEX_KEY;

// --- Middlewares ---
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

// --- Caching pour les listes de fichiers ---
const caches = {
  [MP3_BUCKET_NAME]: { files: null, loadedAt: 0 },
  [MIX_BUCKET_NAME]: { files: null, loadedAt: 0 }
};

// Fonction utilitaire pour récupérer UNIQUEMENT les fichiers MP3 d'un bucket
async function getMp3Files(bucketName) {
  const now = Date.now();
  const cache = caches[bucketName];
  if (cache.files && (now - cache.loadedAt < 10 * 60 * 1000)) return cache.files;
  
  const [files] = await storage.bucket(bucketName).getFiles();
  const fileNames = files.map(f => f.name).filter(n => n.endsWith('.mp3'));
  caches[bucketName] = { files: fileNames, loadedAt: now };
  return fileNames;
}

// Récupérer les statistiques d'une chanson depuis Firestore
async function getSongStats(songName) {
  try {
    const doc = await db.collection('song_stats').doc(songName).get();
    if (!doc.exists) return { likeCount: 0, dislikeCount: 0 };
    return doc.data();
  } catch (e) {
    console.error(`Erreur lors de la récupération des stats pour ${songName}:`, e);
    return { likeCount: 0, dislikeCount: 0 };
  }
}

// Obtenir l'URL de l'image de pochette
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
    console.error(`Erreur lors de la recherche de la pochette pour ${songFileName}:`, error);
    return DEFAULT_POCHETTE_URL;
  }
}

// Obtenir le pays associé à une adresse IP
async function getCountryFromIP(ip) {
  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=country`);
    const data = await res.json();
    return data.country || 'Unknown';
  } catch (e) {
    console.error("Erreur lors de la récupération du pays par IP:", e);
    return 'Unknown';
  }
}

// --- ROUTE POUR SERVIR LES FICHIERS (AUDIO ET WAVEFORM JSON) ---
app.get('/api/file/:type/:bucketType/:fileName', async (req, res) => {
  try {
    const { type, bucketType, fileName } = req.params;
    const primaryBucket = bucketType === 'mix' ? MIX_BUCKET_NAME : MP3_BUCKET_NAME;
    const secondaryBucket = bucketType === 'mix' ? MP3_BUCKET_NAME : MIX_BUCKET_NAME;
    const targetName = decodeURIComponent(fileName);

    // ✅ FIX : Ajoute les headers CORS D'ABORD
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
    res.setHeader('Access-Control-Max-Age', '86400');

    // Gère les requêtes OPTIONS (CORS preflight)
    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }

    let file;
    let contentType;
    let filePathInBucket;

    if (type === 'audio') {
      filePathInBucket = targetName;
      contentType = 'audio/mpeg';
    } else if (type === 'waveform') {
      filePathInBucket = WAVE_FOLDER + targetName.replace('.mp3', '.json');
      contentType = 'application/json';
    } else {
      return res.status(400).json({ error: 'Type de fichier invalide. Utilisez "audio" ou "waveform".' });
    }

    // Essaie de trouver le fichier dans le bucket primaire
    file = storage.bucket(primaryBucket).file(filePathInBucket);
    let [exists] = await file.exists();

    // Si non trouvé, essaie dans le bucket secondaire
    if (!exists) {
      file = storage.bucket(secondaryBucket).file(filePathInBucket);
      [exists] = await file.exists();
    }

    // Si le fichier n'est trouvé dans aucun bucket
    if (!exists) {
      console.error(`❌ Fichier non trouvé: ${filePathInBucket} dans ${primaryBucket} ou ${secondaryBucket}`);
      return res.status(404).json({ error: 'Fichier non trouvé.' });
    }

    // Gère les requêtes Range pour le streaming audio
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
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Length', fileSize);
        file.createReadStream().pipe(res);
      }
    } else {
      // Pour les fichiers waveform (JSON)
      const [content] = await file.download();
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', Buffer.byteLength(content));
      res.send(content);
    }
  } catch (e) {
    console.error('Erreur dans /api/file/:type/:bucketType/:fileName:', e);
    res.status(500).json({ error: 'Erreur serveur lors de la récupération du fichier.' });
  }
});

// --- Route pour obtenir la prochaine chanson (MP3 ou Mix) ---
app.get('/api/next-song', async (req, res) => {
  try {
    const mode = req.query.mode === 'mix' ? 'mix' : 'mp3';
    const bucketName = mode === 'mix' ? MIX_BUCKET_NAME : MP3_BUCKET_NAME;
    
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const country = await getCountryFromIP(ip);
    console.log(`🌍 /api/next-song - IP: ${ip} - Pays: ${country} - Mode: ${mode}`);

    if (!req.session.playedSongs) req.session.playedSongs = {};
    if (!req.session.playedSongs[bucketName]) req.session.playedSongs[bucketName] = [];

    const allSongs = await getMp3Files(bucketName);
    let played = req.session.playedSongs[bucketName];
    let available = allSongs.filter(s => !played.includes(s));

    if (available.length === 0) {
      req.session.playedSongs[bucketName] = [];
      available = allSongs;
      if (available.length === 0) return res.status(404).json({ error: `Aucune chanson trouvée dans ${bucketName}.` });
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
    console.error('Erreur dans /api/next-song:', e);
    res.status(500).json({ error: 'Erreur serveur lors de la récupération de la prochaine chanson.' });
  }
});

// --- Route pour obtenir la chanson précédente ---
app.get('/api/previous-song', async (req, res) => {
  try {
    const mode = req.query.mode === 'mix' ? 'mix' : 'mp3';
    const bucketName = mode === 'mix' ? MIX_BUCKET_NAME : MP3_BUCKET_NAME;

    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const country = await getCountryFromIP(ip);
    console.log(`🌍 /api/previous-song - IP: ${ip} - Pays: ${country} - Mode: ${mode}`);
    
    if (!req.session.playedSongs || !req.session.playedSongs[bucketName] || req.session.playedSongs[bucketName].length < 2) {
      return res.status(400).json({ error: 'Pas de chanson précédente disponible dans l\'historique pour ce mode.' });
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
    console.error('Erreur dans /api/previous-song:', e);
    res.status(500).json({ error: 'Erreur serveur lors de la récupération de la chanson précédente.' });
  }
});


// --- Route pour servir les fichiers JSON waveform depuis GCS ---
app.get('/api/waveform/:bucketType/:fileName', async (req, res) => {
  try {
    const { bucketType, fileName } = req.params;
    const bucketName = bucketType === 'mix' ? MIX_BUCKET_NAME : MP3_BUCKET_NAME;
    const targetName = decodeURIComponent(fileName);
    const filePathInBucket = WAVE_FOLDER + targetName.replace('.mp3', '.json');

    // ✅ CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Content-Type', 'application/json');

    const file = storage.bucket(bucketName).file(filePathInBucket);
    const [exists] = await file.exists();

    if (!exists) {
      console.error(`❌ Fichier JSON non trouvé: ${filePathInBucket}`);
      return res.status(404).json({ error: 'Fichier JSON non trouvé.' });
    }

    const [content] = await file.download();
    res.setHeader('Content-Length', Buffer.byteLength(content));
    res.send(content);
    console.log(`✅ Waveform JSON served: ${filePathInBucket}`);

  } catch (e) {
    console.error('Erreur dans /api/waveform:', e);
    res.status(500).json({ error: 'Erreur serveur lors de la récupération du fichier JSON.' });
  }
});

app.get('/api/mix-list', async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const country = await getCountryFromIP(ip);
    console.log(`🌍 /api/mix-list - IP: ${ip} - Pays: ${country}`);

    const mixes = await getMp3Files(MIX_BUCKET_NAME);

    const result = mixes.map(mix => ({
      name: mix.replace('.mp3',''),
      fileName: mix,
      url: `/api/file/audio/mix/${encodeURIComponent(mix)}`,
      waveformJsonUrl: `https://storage.googleapis.com/${MIX_BUCKET_NAME}/waveforms/${mix.replace('.mp3', '.json')}`
    }));

    res.json(result);
  } catch (e) {
    console.error('Erreur dans /api/mix-list:', e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// --- Génération de descriptions avec Vertex AI ---
const GEMINI_ENABLED = false;

async function generateSongDescription(songName) {
  try {
    const doc = await db.collection('song_descriptions').doc(songName).get();
    if (doc.exists) {
      console.log('✅ Description trouvée dans le cache pour:', songName);
      return doc.data().text;
    }

    if (!GEMINI_ENABLED) {
      console.log('⚠️ La génération de descriptions par Gemini est désactivée.');
      return 'Description indisponible (Gemini désactivé)';
    }
    
    const model = vertexAI.getGenerativeModel({ model: 'gemini-2.5-pro' }); 
    const response = await model.generateContent({
      contents: [{
        role: 'user',
        parts: [{
          text: `Décris brièvement "${songName.replace('.mp3', '')}" en 2 phrases.`
        }]
      }]
    });
    
    const text = response.response?.candidates?.[0]?.content?.parts?.[0]?.text || 'Échec de la génération de description';

    if (text !== 'Échec de la génération de description') {
      await db.collection('song_descriptions').doc(songName).set({ text });
      console.log('✅ Description générée et mise en cache pour:', songName);
    } else {
      console.error('Échec de la génération de description pour:', songName);
    }

    return text;

  } catch (e) {
    console.error('❌ Erreur lors de la génération de description par Gemini:', e.message);
    return 'Description non disponible';
  }
}

// --- Route pour les feedbacks (Likes/Dislikes) ---
app.post('/api/song-feedback', async (req, res) => {
  try {
    const { songName, feedback } = req.body;
    if (!songName || !feedback) return res.status(400).json({ error: 'Données manquantes (songName, feedback)' });

    if (!req.session.votedSongs) req.session.votedSongs = {};
    if (req.session.votedSongs[songName]) return res.status(409).json({ error: 'Vote déjà enregistré pour cette chanson.' });

    const statsRef = db.collection('song_stats').doc(songName);
    if (feedback === 'like') {
      await statsRef.set({ likeCount: FieldValue.increment(1) }, { merge: true });
    } else if (feedback === 'dislike') {
      await statsRef.set({ dislikeCount: FieldValue.increment(1) }, { merge: true });
    } else {
      return res.status(400).json({ error: 'Type de feedback invalide. Utilisez "like" ou "dislike".' });
    }

    req.session.votedSongs[songName] = true;

    const statsDoc = await statsRef.get();
    const data = statsDoc.data() || { likeCount: 0, dislikeCount: 0 };
    
    res.json({ success: true, likeCount: data.likeCount, dislikeCount: data.dislikeCount });
  } catch (e) {
    console.error('Erreur dans /api/song-feedback:', e);
    res.status(500).json({ error: 'Erreur serveur lors de l\'enregistrement du feedback.' });
  }
});

// --- Point de contrôle de santé ---
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// --- Servir le fichier index.html pour la racine ---
app.get('/', (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

// --- Démarrage du serveur ---
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur Musica backend démarré sur http://0.0.0.0:${PORT}`);
});

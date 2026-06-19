const express = require('express');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const { Storage } = require('@google-cloud/storage');
const { Firestore, FieldValue } = require('@google-cloud/firestore');
const fetch = require('node-fetch'); // Assurez-vous que node-fetch est installé: npm install node-fetch

const storage = new Storage();
const db = new Firestore({ databaseId: 'music-db' }); // Assurez-vous que 'music-db' est votre ID de base de données

const app = express();
const PORT = process.env.PORT || 8080;

// --- Configuration des Buckets Cloud Storage ---
const MP3_BUCKET_NAME = 'musica-mp3-bucket';
const MIX_BUCKET_NAME = 'musica-mix-bucket';
const WAVE_FOLDER = 'waveforms/'; // Dossier où sont stockés les JSON de waveforms
const POCHETTE_FOLDER = 'pochettes/';
const POCHETTE_FILENAME = 'pochettes/pochette.jpg'; // Nom du fichier de pochette par défaut
const DEFAULT_POCHETTE_URL = `https://storage.googleapis.com/${MP3_BUCKET_NAME}/${POCHETTE_FILENAME}`;

// --- Configuration Vertex AI ---
const { VertexAI } = require('@google-cloud/vertexai');
const vertexAI = new VertexAI({
  project: '836359398199',  // Remplacez par votre Project ID GCP
  location: 'europe-west1', // Ou 'us-central1'
});
const API_KEY = process.env.VERTEX_KEY; // Assurez-vous que cette variable d'environnement est définie

// --- Middlewares ---
app.use(cors({
  origin: ['http://localhost:8080', 'https://musicabackend.uc.r.appspot.com', 'https://musicaguegan.netlify.app'], // Adaptez ces origines si nécessaire
  credentials: true,
}));
app.use(express.json());
app.use(session({
  secret: 'musica-secret-2025', // IMPORTANT: Utilisez une clé secrète forte et unique !
  resave: false,
  saveUninitialized: true,
  cookie: { secure: 'auto', httpOnly: true, maxAge: 86400000 }, // Cookie valable 24h
}));

const FRONTEND_DIR = path.join(__dirname, 'frontend'); // Assurez-vous que ce chemin est correct pour vos fichiers frontend
app.use(express.static(FRONTEND_DIR));
app.get('/favicon.ico', (req, res) => res.status(204).send()); // Ignorer les requêtes favicon

// --- Caching pour les listes de fichiers ---
const caches = {
  [MP3_BUCKET_NAME]: { files: null, loadedAt: 0 },
  [MIX_BUCKET_NAME]: { files: null, loadedAt: 0 }
};

// Fonction utilitaire pour récupérer tous les fichiers d'un bucket (général)
async function getAllFiles(bucketName) {
  const now = Date.now();
  const cache = caches[bucketName];
  // Utiliser le cache s'il a moins de 10 minutes
  if (cache.files && (now - cache.loadedAt < 10 * 60 * 1000)) return cache.files;
  
  const [files] = await storage.bucket(bucketName).getFiles();
  const fileNames = files.map(f => f.name);
  caches[bucketName] = { files: fileNames, loadedAt: now };
  return fileNames;
}

// Fonction utilitaire pour récupérer UNIQUEMENT les fichiers MP3 d'un bucket
async function getMp3Files(bucketName) {
  const now = Date.now();
  const cache = caches[bucketName];
  // Utiliser le cache s'il a moins de 10 minutes
  if (cache.files && (now - cache.loadedAt < 10 * 60 * 1000)) return cache.files;
  
  const [files] = await storage.bucket(bucketName).getFiles();
  const fileNames = files.map(f => f.name).filter(n => n.endsWith('.mp3')); // Filtre pour les .mp3
  caches[bucketName] = { files: fileNames, loadedAt: now };
  return fileNames;
}

// Récupérer les statistiques (likes/dislikes) d'une chanson depuis Firestore
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

// Obtenir l'URL de l'image de pochette (spécifique ou par défaut)
async function getImageUrl(songFileName, bucketName) {
  try {
    const specificPochettePath = `${POCHETTE_FOLDER}${songFileName.replace('.mp3', '.jpg')}`;
    const specificPochetteFile = storage.bucket(bucketName).file(specificPochettePath);
    const [exists] = await specificPochetteFile.exists();

    if (exists) {
      return `https://storage.googleapis.com/${bucketName}/${specificPochettePath}`;
    } else {
      return DEFAULT_POCHETTE_URL; // Retourne par défaut
    }
  } catch (error) {
    console.error(`Erreur lors de la recherche de la pochette pour ${songFileName}:`, error);
    return DEFAULT_POCHETTE_URL; // Retourne par défaut en cas d'erreur
  }
}

// Obtenir le pays associé à une adresse IP
async function getCountryFromIP(ip) {
  try {
    // Assurez-vous que node-fetch est installé
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
    // Détermine le bucket principal et secondaire en fonction du type (mix ou mp3)
    const primaryBucket = bucketType === 'mix' ? MIX_BUCKET_NAME : MP3_BUCKET_NAME;
    const secondaryBucket = bucketType === 'mix' ? MP3_BUCKET_NAME : MIX_BUCKET_NAME; // Bucket de secours
    const targetName = decodeURIComponent(fileName); // Décode le nom de fichier de l'URL

    let file;
    let contentType;
    let filePathInBucket; // Chemin relatif dans le bucket

    if (type === 'audio') {
      filePathInBucket = targetName; // Pour l'audio, c'est le nom de fichier direct (ex: 'song.mp3')
      contentType = 'audio/mpeg';
    } else if (type === 'waveform') {
      // Pour la waveform, cherche le fichier .json dans le dossier WAVE_FOLDER
      // On suppose que targetName passé est le nom du fichier MP3 (ex: 'song.mp3')
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
      return res.status(404).json({ error: 'Fichier non trouvé.' });
    }

    // Gère les requêtes Range pour le streaming audio
    if (type === 'audio') {
      const [metadata] = await file.getMetadata();
      const fileSize = metadata.size;
      const range = req.headers.range; // Entête Range (pour le streaming)

      if (range) { // Si requête de type Range (streaming partiel)
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;

        res.writeHead(206, { // 206 Partial Content
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': contentType,
          'Access-Control-Allow-Origin': '*', // Autoriser l'accès depuis le frontend
        });
        file.createReadStream({ start, end }).pipe(res);
      } else { // Requête complète (sans Range)
        res.setHeader('Content-Type', contentType);
        res.setHeader('Access-Control-Allow-Origin', '*'); // Autoriser l'accès depuis le frontend
        res.setHeader('Accept-Ranges', 'bytes'); // Indiquer qu'on supporte les requêtes Range
        res.setHeader('Content-Length', fileSize);
        file.createReadStream().pipe(res);
      }
    } else { // Pour les fichiers waveform (JSON)
      const [content] = await file.download(); // Télécharge le contenu JSON
      res.setHeader('Content-Type', contentType);
      res.setHeader('Access-Control-Allow-Origin', '*'); // Autoriser l'accès depuis le frontend
      res.send(content);
    }
  } catch (e) {
    console.error('Erreur dans la route /api/file/:type/:bucketType/:fileName:', e);
    res.status(500).json({ error: 'Erreur serveur lors de la récupération du fichier.' });
  }
});

// --- Route pour obtenir la prochaine chanson (MP3 ou Mix) ---
app.get('/api/next-song', async (req, res) => {
  try {
    const mode = req.query.mode === 'mix' ? 'mix' : 'mp3';
    // --- FIX : Détermine le bucketName basé sur le mode ---
    const bucketName = mode === 'mix' ? MIX_BUCKET_NAME : MP3_BUCKET_NAME;
    
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const country = await getCountryFromIP(ip);
    console.log(`🌍 /api/next-song - IP: ${ip} - Pays: ${country} - Mode: ${mode}`);

    // Initialise l'historique des chansons jouées pour ce mode si nécessaire
    if (!req.session.playedSongs) req.session.playedSongs = {};
    // --- FIX : Initialise l'array de session pour le bucketName correct ---
    if (!req.session.playedSongs[bucketName]) req.session.playedSongs[bucketName] = [];

    const allSongs = await getMp3Files(bucketName); // Récupère uniquement les fichiers .mp3
    let played = req.session.playedSongs[bucketName];
    let available = allSongs.filter(s => !played.includes(s)); // Chansons non encore jouées

    // Si toutes les chansons ont été jouées, réinitialise la liste et reprend depuis le début
    if (available.length === 0) {
      req.session.playedSongs[bucketName] = []; // Réinitialise l'historique pour ce bucket
      available = allSongs; // Utilise toutes les chansons à nouveau
      if (available.length === 0) return res.status(404).json({ error: `Aucune chanson trouvée dans ${bucketName}.` });
    }

    // Sélectionne une chanson aléatoire parmi celles disponibles
    const song = available[Math.floor(Math.random() * available.length)];
    req.session.playedSongs[bucketName].push(song); // Ajoute la chanson sélectionnée à l'historique

    // Génère la description avec Vertex AI (si activé)
    const description = await generateSongDescription(song);

    // Récupère les stats et l'URL de l'image en parallèle
    const [stats, imageUrl] = await Promise.all([
      getSongStats(song),
      getImageUrl(song, bucketName) // Passe le bon bucketName
    ]);
    
    // Génère des couleurs aléatoires (optionnel)
    const color = '#' + Math.floor(Math.random() * 0xFFFFFF).toString(16).padStart(6, '0');
    const inverse = '#' + (0xFFFFFF - parseInt(color.slice(1), 16)).toString(16).padStart(6, '0');

    res.json({
      songName: song.replace('.mp3', ''), // Nom pour affichage
      fileName: song,                      // Nom de fichier original pour le backend
      url: `/api/file/audio/${mode}/${encodeURIComponent(song)}`, // URL audio via API
      waveformUrl: `/api/file/waveform/${mode}/${encodeURIComponent(song)}`, // URL JSON waveform via API
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
    // --- FIX : Détermine le bucketName basé sur le mode ---
    const bucketName = mode === 'mix' ? MIX_BUCKET_NAME : MP3_BUCKET_NAME;

    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const country = await getCountryFromIP(ip);
    console.log(`🌍 /api/previous-song - IP: ${ip} - Pays: ${country} - Mode: ${mode}`);
    
    // Vérifie si l'historique des chansons jouées existe et est suffisant pour ce bucket
    if (!req.session.playedSongs || !req.session.playedSongs[bucketName] || req.session.playedSongs[bucketName].length < 2) {
      return res.status(400).json({ error: 'Pas de chanson précédente disponible dans l\'historique pour ce mode.' });
    }

    // Retire la chanson courante de l'historique et récupère la précédente
    req.session.playedSongs[bucketName].pop(); // Retire la dernière chanson jouée
    const song = req.session.playedSongs[bucketName][req.session.playedSongs[bucketName].length - 1]; // Récupère la nouvelle dernière chanson

    // Récupère les stats et l'URL de l'image pour la chanson précédente
    const stats = await getSongStats(song);
    const imageUrl = await getImageUrl(song, bucketName); // Utilise le bon bucketName

    res.json({
      songName: song.replace('.mp3', ''),
      fileName: song,
      url: `/api/file/audio/${mode}/${encodeURIComponent(song)}`,
      waveformUrl: `/api/file/waveform/${mode}/${encodeURIComponent(song)}`,
      imageUrl: imageUrl,
      color: '#000000', // Ou génère des couleurs aléatoires comme dans next-song
      textColor: '#FFFFFF',
      likeCount: stats.likeCount || 0,
      dislikeCount: stats.dislikeCount || 0,
    });
  } catch (e) {
    console.error('Erreur dans /api/previous-song:', e);
    res.status(500).json({ error: 'Erreur serveur lors de la récupération de la chanson précédente.' });
  }
});

// --- Route pour lister les mixes disponibles ---
app.get('/api/mix-list', async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const country = await getCountryFromIP(ip);
    console.log(`🌍 /api/mix-list - IP: ${ip} - Pays: ${country}`);

    // Récupère tous les fichiers .mp3 du bucket des mixes
    const mixes = await getMp3Files(MIX_BUCKET_NAME);

    const result = mixes.map(mix => ({
      name: mix.replace('.mp3',''), // Nom à afficher (sans extension)
      fileName: mix,                 // Nom de fichier original
      // --- FIX : Utilise votre API backend pour le streaming audio ---
      url: `/api/file/audio/mix/${encodeURIComponent(mix)}`, 
      // --- FIX : Ajoute l'URL pour le fichier JSON de waveform via API backend ---
      waveformJsonUrl: `/api/file/waveform/mix/${encodeURIComponent(mix.replace('.mp3', '.json'))}` 
    }));

    res.json(result);

  } catch (e) {
    console.error('Erreur dans /api/mix-list:', e);
    res.status(500).json({ error: 'Erreur serveur lors de la récupération de la liste des mixes.' });
  }
});

// SUPPRIMÉ : Cette route est redondante car gérée par la route générique /api/file.
// app.get('/api/file/audio/mix/:name', async (req, res) => { ... });

// --- Fonctions liées à Vertex AI et à la génération de descriptions ---
const GEMINI_ENABLED = false; // Mettez à true pour activer la génération de descriptions par Gemini

async function generateSongDescription(songName) {
  try {
    // 1. Vérifie le cache dans Firestore
    const doc = await db.collection('song_descriptions').doc(songName).get();
    if (doc.exists) {
      console.log('✅ Description trouvée dans le cache pour:', songName);
      return doc.data().text;
    }

    // 2. Si Gemini est désactivé, retourne un message placeholder
    if (!GEMINI_ENABLED) {
      console.log('⚠️ La génération de descriptions par Gemini est désactivée.');
      return 'Description indisponible (Gemini désactivé)';
    }
    
    // 3. Génère la description avec Vertex AI (Gemini 2.5 Pro)
    const model = vertexAI.getGenerativeModel({ model: 'gemini-2.5-pro' }); 
    const response = await model.generateContent({
      contents: [{
        role: 'user',
        parts: [{
          text: `Décris brièvement "${songName.replace('.mp3', '')}" en 2 phrases.`
        }]
      }]
    });
    
    // Extrait le texte de la réponse, en gérant les variations potentielles de structure
    const text = response.response?.candidates?.[0]?.content?.parts?.[0]?.text || 'Échec de la génération de description';

    // 4. Sauvegarde dans le cache si la génération a réussi
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

// Optionnel: Route pour générer toutes les descriptions en batch (à utiliser avec prudence)
// app.get('/api/generate-all-descriptions', async (req, res) => { ... });

// --- Route pour les feedbacks (Likes/Dislikes) ---
app.post('/api/song-feedback', async (req, res) => {
  try {
    const { songName, feedback } = req.body;
    if (!songName || !feedback) return res.status(400).json({ error: 'Données manquantes (songName, feedback)' });

    // Initialise votedSongs dans la session si inexistant
    if (!req.session.votedSongs) req.session.votedSongs = {};
    // Vérifie si l'utilisateur a déjà voté pour cette chanson dans cette session
    if (req.session.votedSongs[songName]) return res.status(409).json({ error: 'Vote déjà enregistré pour cette chanson.' });

    const statsRef = db.collection('song_stats').doc(songName);
    if (feedback === 'like') {
      await statsRef.set({ likeCount: FieldValue.increment(1) }, { merge: true }); // Incrémente le like
    } else if (feedback === 'dislike') {
      await statsRef.set({ dislikeCount: FieldValue.increment(1) }, { merge: true }); // Incrémente le dislike
    } else {
      return res.status(400).json({ error: 'Type de feedback invalide. Utilisez "like" ou "dislike".' });
    }

    req.session.votedSongs[songName] = true; // Marque comme voté dans la session

    // Récupère les comptes mis à jour
    const statsDoc = await statsRef.get();
    const data = statsDoc.data() || { likeCount: 0, dislikeCount: 0 }; // Défaut si le document vient d'être créé
    
    res.json({ success: true, likeCount: data.likeCount, dislikeCount: data.dislikeCount });
  } catch (e) {
    console.error('Erreur dans /api/song-feedback:', e);
    res.status(500).json({ error: 'Erreur serveur lors de l\'enregistrement du feedback.' });
  }
});

// --- Point de contrôle de santé (Health Check) ---
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// --- Servir le fichier index.html pour la racine ---
app.get('/', (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

// --- Démarrage du serveur ---
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Serveur Musica backend démarré sur http://0.0.0.0:${PORT}`);
});

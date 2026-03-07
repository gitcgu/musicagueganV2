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

// --- Middleware ---
app.use(cors({
  origin: ['https://musicabackend.uc.r.appspot.com','https://musicaguegan.netlify.app'],
  credentials: true
}));
app.use(express.json());
app.use(session({
  secret: 'musica-secret-2025',
  resave: false,
  saveUninitialized: true,
  cookie: { secure:'auto', httpOnly:true, maxAge:86400000 }
}));

const FRONTEND_DIR = path.join(__dirname,'frontend');
app.use(express.static(FRONTEND_DIR));
app.get('/favicon.ico', (req,res)=>res.status(204).send());

// --- Buckets ---
const MP3_BUCKET_NAME = 'musica-mp3-bucket';
const MIX_BUCKET_NAME = 'musica-mix-bucket';
const WAVE_FOLDER = 'waveforms/'; // JSON stocké ici

// --- Cache simple ---
const caches = {};

// --- Utilitaires ---
async function getAllMp3(bucketName) {
  const now = Date.now();
  const cache = caches[bucketName];
  if (cache && cache.files && (now - cache.loadedAt < 10*60*1000)) return cache.files;

  const [files] = await storage.bucket(bucketName).getFiles();
  const mp3Files = files.map(f=>f.name).filter(f=>f.endsWith('.mp3'));

  caches[bucketName] = { files: mp3Files, loadedAt: now };
  return mp3Files;
}

async function getSongStats(songName) {
  try {
    const doc = await db.collection('song_stats').doc(songName).get();
    if (!doc.exists) return { likeCount:0, dislikeCount:0 };
    return doc.data();
  } catch(e) {
    console.error('Firestore error', e.message);
    return { likeCount:0, dislikeCount:0 };
  }
}

// --- Routes API ---
app.get('/api/next-song', async (req,res)=>{
  try {
    const mode = req.query.mode || 'mp3';
    const bucketName = mode==='mix'?MIX_BUCKET_NAME:MP3_BUCKET_NAME;

    if (!req.session.playedSongs) req.session.playedSongs={};
    if (!req.session.playedSongs[bucketName]) req.session.playedSongs[bucketName]=[];

    const allSongs = await getAllMp3(bucketName);
    let played = req.session.playedSongs[bucketName];
    let available = allSongs.filter(s=>!played.includes(s));
    if (available.length===0){ req.session.playedSongs[bucketName]=[]; available=allSongs; }
    if (available.length===0) return res.status(404).json({error:'Aucune chanson trouvée'});

    const song = available[Math.floor(Math.random()*available.length)];
    req.session.playedSongs[bucketName].push(song);

    // URLs signées
    const audioFile = storage.bucket(bucketName).file(song);
    const [audioUrl] = await audioFile.getSignedUrl({ action:'read', expires:Date.now()+60*60*1000, version:'v4' });

    const waveformFile = storage.bucket(bucketName).file(WAVE_FOLDER + song.replace('.mp3','.json'));
    const [waveformUrl] = await waveformFile.getSignedUrl({ action:'read', expires:Date.now()+60*60*1000, version:'v4' });

    const { likeCount, dislikeCount } = await getSongStats(song);
    const color = '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6,'0');
    const inverse = '#' + (16777215 - parseInt(color.substring(1),16)).toString(16).padStart(6,'0');

    res.json({
      songName: song.replace('.mp3',''),
      songFileName: song,
      audioUrl,      // MP3 réel
      waveformUrl,   // JSON waveform
      color,
      textColor:inverse,
      likeCount,
      dislikeCount
    });

  } catch(err){
    console.error(err.stack);
    res.status(500).json({error:'Erreur serveur'});
  }
});

app.get('/api/previous-song', async (req,res)=>{
  try {
    const mode = req.query.mode || 'mp3';
    const bucketName = mode==='mix'?MIX_BUCKET_NAME:MP3_BUCKET_NAME;

    if (!req.session.playedSongs || !req.session.playedSongs[bucketName] || req.session.playedSongs[bucketName].length<2)
      return res.status(400).json({error:'Pas de chanson précédente'});

    req.session.playedSongs[bucketName].pop();
    const song = req.session.playedSongs[bucketName].slice(-1)[0];

    const audioFile = storage.bucket(bucketName).file(song);
    const [audioUrl] = await audioFile.getSignedUrl({ action:'read', expires:Date.now()+60*60*1000, version:'v4' });
    const waveformFile = storage.bucket(bucketName).file(WAVE_FOLDER + song.replace('.mp3','.json'));
    const [waveformUrl] = await waveformFile.getSignedUrl({ action:'read', expires:Date.now()+60*60*1000, version:'v4' });

    const { likeCount, dislikeCount } = await getSongStats(song);
    res.json({
      songName: song.replace('.mp3',''),
      songFileName: song,
      audioUrl,
      waveformUrl,
      color:'#000', textColor:'#FFF',
      likeCount, dislikeCount
    });

  } catch(err){ res.status(500).json({error:'Erreur serveur'}); }
});

app.post('/api/song-feedback', async (req,res)=>{
  try {
    const { songName, feedback } = req.body;
    if (!songName || !feedback) return res.status(400).json({error:'Données manquantes'});
    if (!req.session.votedSongs) req.session.votedSongs={};
    if (req.session.votedSongs[songName]) return res.status(409).json({error:'Vote déjà enregistré'});

    const statsRef = db.collection('song_stats').doc(songName);
    if (feedback==='like') await statsRef.set({likeCount: FieldValue.increment(1)}, {merge:true});
    else if (feedback==='dislike') await statsRef.set({dislikeCount: FieldValue.increment(1)}, {merge:true});
    else return res.status(400).json({error:'Feedback invalide'});

    req.session.votedSongs[songName]=true;
    const statsDoc = await statsRef.get();
    const data = statsDoc.data()||{likeCount:0, dislikeCount:0};
    res.json({success:true, likeCount:data.likeCount||0, dislikeCount:data.dislikeCount||0});
  } catch(e){ res.status(500).json({error:'Erreur serveur'}); }
});

// Frontend
app.get('/', (req,res)=> res.sendFile(path.join(FRONTEND_DIR,'index.html')));

app.listen(PORT,'0.0.0.0',()=>console.log(`API sur http://0.0.0.0:${PORT}`));

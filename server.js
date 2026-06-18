const express = require('express');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const { Storage } = require('@google-cloud/storage');
const { Firestore, FieldValue } = require('@google-cloud/firestore');
const fetch = require('node-fetch'); // Ensure 'node-fetch' is installed: npm install node-fetch

const storage = new Storage();
const db = new Firestore({ databaseId: 'music-db' }); // Replace 'music-db' if your DB ID is different

const app = express();
const PORT = process.env.PORT || 8080;

// --- Bucket Configuration ---
const MP3_BUCKET_NAME = 'musica-mp3-bucket';
const MIX_BUCKET_NAME = 'musica-mix-bucket';
const WAVE_FOLDER = 'waveforms/'; // Folder for waveform JSONs
const POCHETTE_FOLDER = 'pochettes/';
const POCHETTE_FILENAME = 'pochettes/pochette.jpg'; // Default pochette filename
const DEFAULT_POCHETTE_URL = `https://storage.googleapis.com/${MP3_BUCKET_NAME}/${POCHETTE_FILENAME}`;

// --- Vertex AI Setup ---
const { VertexAI } = require('@google-cloud/vertexai');
const vertexAI = new VertexAI({
  project: '836359398199',  // Replace with your GCP Project ID
  location: 'europe-west1', // Or 'us-central1'
});
// API Key for Vertex AI (if required by your setup, otherwise can be omitted if using ADC)
const API_KEY = process.env.VERTEX_KEY; 

// --- Middlewares ---
app.use(cors({
  origin: ['https://musicabackend.uc.r.appspot.com', 'https://musicaguegan.netlify.app'], // Adjust origins as needed
  credentials: true,
}));
app.use(express.json());
app.use(session({
  secret: 'musica-secret-2025', // IMPORTANT: Use a strong, unique, and secret key!
  resave: false,
  saveUninitialized: true,
  cookie: { secure: 'auto', httpOnly: true, maxAge: 86400000 }, // 24 hours
}));

// Serve static frontend files
const FRONTEND_DIR = path.join(__dirname, 'frontend');
app.use(express.static(FRONTEND_DIR));
app.get('/favicon.ico', (req, res) => res.status(204).send()); // Ignore favicon requests

// --- Caching for file lists ---
const caches = {
  [MP3_BUCKET_NAME]: { files: null, loadedAt: 0 },
  [MIX_BUCKET_NAME]: { files: null, loadedAt: 0 }
};

// Function to get all files from a bucket (general purpose)
async function getAllFiles(bucketName) {
  const now = Date.now();
  const cache = caches[bucketName];
  // Use cache if less than 10 minutes old
  if (cache.files && (now - cache.loadedAt < 10 * 60 * 1000)) return cache.files;
  
  const [files] = await storage.bucket(bucketName).getFiles();
  const fileNames = files.map(f => f.name);
  caches[bucketName] = { files: fileNames, loadedAt: now };
  return fileNames;
}

// Function to get ONLY MP3 files from a bucket
async function getMp3Files(bucketName) {
  const now = Date.now();
  const cache = caches[bucketName];
  // Use cache if less than 10 minutes old
  if (cache.files && (now - cache.loadedAt < 10 * 60 * 1000)) return cache.files;
  
  const [files] = await storage.bucket(bucketName).getFiles();
  const fileNames = files.map(f => f.name).filter(n => n.endsWith('.mp3')); // Filter for MP3s
  caches[bucketName] = { files: fileNames, loadedAt: now };
  return fileNames;
}

// Get song statistics (likes/dislikes) from Firestore
async function getSongStats(songName) {
  try {
    const doc = await db.collection('song_stats').doc(songName).get();
    if (!doc.exists) return { likeCount: 0, dislikeCount: 0 };
    return doc.data();
  } catch (e) {
    console.error(`Error fetching song stats for ${songName}:`, e);
    return { likeCount: 0, dislikeCount: 0 };
  }
}

// Get image URL for a song, checking for specific or default pochette
async function getImageUrl(songFileName, bucketName) {
  try {
    const specificPochettePath = `${POCHETTE_FOLDER}${songFileName.replace('.mp3', '.jpg')}`;
    const specificPochetteFile = storage.bucket(bucketName).file(specificPochettePath);
    const [exists] = await specificPochetteFile.exists();

    if (exists) {
      return `https://storage.googleapis.com/${bucketName}/${specificPochettePath}`;
    } else {
      return DEFAULT_POCHETTE_URL; // Fallback to default
    }
  } catch (error) {
    console.error(`Error finding pochette for ${songFileName}:`, error);
    return DEFAULT_POCHETTE_URL; // Return default on error
  }
}

// Get country from IP address using an external service
async function getCountryFromIP(ip) {
  try {
    // Requires node-fetch to be installed
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=country`);
    const data = await res.json();
    return data.country || 'Unknown';
  } catch (e) {
    console.error("Error fetching country from IP:", e);
    return 'Unknown';
  }
}

// --- ROUTE FOR SERVING FILES (AUDIO & WAVEFORM JSON) ---
// This route serves audio files (streaming) and waveform JSONs from Cloud Storage.
app.get('/api/file/:type/:bucketType/:fileName', async (req, res) => {
  try {
    const { type, bucketType, fileName } = req.params;
    // Determine primary and secondary buckets based on bucketType (mix or mp3)
    const primaryBucket = bucketType === 'mix' ? MIX_BUCKET_NAME : MP3_BUCKET_NAME;
    const secondaryBucket = bucketType === 'mix' ? MP3_BUCKET_NAME : MIX_BUCKET_NAME; // Fallback bucket
    const targetName = decodeURIComponent(fileName); // Decode filename from URL

    let file;
    let contentType;
    let filePathInBucket; // Path relative to bucket root

    if (type === 'audio') {
      filePathInBucket = targetName; // For audio, it's the direct filename (e.g., 'song.mp3')
      contentType = 'audio/mpeg';
    } else if (type === 'waveform') {
      // For waveform, construct path: WAVE_FOLDER + songName.json
      // Assumes targetName passed is the original MP3 filename (e.g., 'song.mp3')
      filePathInBucket = WAVE_FOLDER + targetName.replace('.mp3', '.json');
      contentType = 'application/json';
    } else {
      return res.status(400).json({ error: 'Invalid file type. Use "audio" or "waveform".' });
    }

    // Attempt to find the file in the primary bucket
    file = storage.bucket(primaryBucket).file(filePathInBucket);
    let [exists] = await file.exists();

    // If not found, try the secondary bucket
    if (!exists) {
      file = storage.bucket(secondaryBucket).file(filePathInBucket);
      [exists] = await file.exists();
    }

    // If file still not found in either bucket
    if (!exists) {
      return res.status(404).json({ error: 'File not found.' });
    }

    // Handle Range requests for audio streaming
    if (type === 'audio') {
      const [metadata] = await file.getMetadata();
      const fileSize = metadata.size;
      const range = req.headers.range;

      if (range) { // Handle partial content request (streaming)
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;

        res.writeHead(206, { // 206 Partial Content
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': contentType,
          'Access-Control-Allow-Origin': '*', // Allow frontend access
        });
        file.createReadStream({ start, end }).pipe(res);
      } else { // Handle full file request
        res.setHeader('Content-Type', contentType);
        res.setHeader('Access-Control-Allow-Origin', '*'); // Allow frontend access
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Length', fileSize);
        file.createReadStream().pipe(res);
      }
    } else { // Handle waveform JSON file
      const [content] = await file.download();
      res.setHeader('Content-Type', contentType);
      res.setHeader('Access-Control-Allow-Origin', '*'); // Allow frontend access
      res.send(content);
    }
  } catch (e) {
    console.error('Error in /api/file route:', e);
    res.status(500).json({ error: 'Server error retrieving file.' });
  }
});

// --- Endpoint to get the next song (MP3 or Mix) ---
app.get('/api/next-song', async (req, res) => {
  try {
    const mode = req.query.mode === 'mix' ? 'mix' : 'mp3';
    // ✅ CORRECTED: Determine bucketName based on mode
    const bucketName = mode === 'mix' ? MIX_BUCKET_NAME : MP3_BUCKET_NAME;
    
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const country = await getCountryFromIP(ip);
    console.log(`🌍 /api/next-song - IP: ${ip} - Pays: ${country} - Mode: ${mode}`);

    // Initialize session history if not present
    if (!req.session.playedSongs) req.session.playedSongs = {};
    // ✅ CORRECTED: Initialize session array for the correct bucketName
    if (!req.session.playedSongs[bucketName]) req.session.playedSongs[bucketName] = [];

    const allSongs = await getMp3Files(bucketName); // Use getMp3Files to ensure only MP3s
    let played = req.session.playedSongs[bucketName];
    let available = allSongs.filter(s => !played.includes(s)); // Songs not yet played

    // If all songs in the current bucket have been played, reset the list
    if (available.length === 0) {
      req.session.playedSongs[bucketName] = []; // Reset history for this bucket
      available = allSongs; // Use all songs again
      if (available.length === 0) return res.status(404).json({ error: `No songs found in ${bucketName}.` });
    }

    // Select a random available song
    const song = available[Math.floor(Math.random() * available.length)];
    req.session.playedSongs[bucketName].push(song); // Add to played list

    // Generate description using Vertex AI (if enabled)
    const description = await generateSongDescription(song);

    // Fetch stats and image URL in parallel
    const [stats, imageUrl] = await Promise.all([
      getSongStats(song),
      getImageUrl(song, bucketName) // Pass the correct bucketName
    ]);
    
    // Generate random colors (optional)
    const color = '#' + Math.floor(Math.random() * 0xFFFFFF).toString(16).padStart(6, '0');
    const inverse = '#' + (0xFFFFFF - parseInt(color.slice(1), 16)).toString(16).padStart(6, '0');

    res.json({
      songName: song.replace('.mp3', ''), // Display name without extension
      fileName: song, // Original filename for backend references
      url: `/api/file/audio/${mode}/${encodeURIComponent(song)}`, // Use API for audio
      waveformUrl: `/api/file/waveform/${mode}/${encodeURIComponent(song)}`, // API route for waveform JSON
      imageUrl: imageUrl,
      description: description,
      color,
      textColor: inverse,
      likeCount: stats.likeCount || 0,
      dislikeCount: stats.dislikeCount || 0,
    });
  } catch (e) {
    console.error('Error in /api/next-song:', e);
    res.status(500).json({ error: 'Server error retrieving next song.' });
  }
});

// --- Endpoint to get the previous song ---
app.get('/api/previous-song', async (req, res) => {
  try {
    const mode = req.query.mode === 'mix' ? 'mix' : 'mp3';
    // ✅ CORRECTED: Determine bucketName based on mode
    const bucketName = mode === 'mix' ? MIX_BUCKET_NAME : MP3_BUCKET_NAME;

    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const country = await getCountryFromIP(ip);
    console.log(`🌍 /api/previous-song - IP: ${ip} - Pays: ${country} - Mode: ${mode}`);
    
    // Ensure playedSongs and history for this bucket exist and have enough entries
    if (!req.session.playedSongs || !req.session.playedSongs[bucketName] || req.session.playedSongs[bucketName].length < 2) {
      return res.status(400).json({ error: 'No previous song available in history for this mode.' });
    }

    // Remove current song, get previous
    req.session.playedSongs[bucketName].pop(); // Remove the last played song
    const song = req.session.playedSongs[bucketName][req.session.playedSongs[bucketName].length - 1]; // Get the new last song

    // Fetch stats and image URL for the previous song
    const stats = await getSongStats(song);
    const imageUrl = await getImageUrl(song, bucketName); // Use correct bucketName

    res.json({
      songName: song.replace('.mp3', ''),
      fileName: song,
      url: `/api/file/audio/${mode}/${encodeURIComponent(song)}`,
      waveformUrl: `/api/file/waveform/${mode}/${encodeURIComponent(song)}`,
      imageUrl: imageUrl,
      color: '#000000', // Or generate random colors like next-song
      textColor: '#FFFFFF',
      likeCount: stats.likeCount || 0,
      dislikeCount: stats.dislikeCount || 0,
    });
  } catch (e) {
    console.error('Error in /api/previous-song:', e);
    res.status(500).json({ error: 'Server error retrieving previous song.' });
  }
});

// --- Endpoint to list available mixes ---
app.get('/api/mix-list', async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const country = await getCountryFromIP(ip);
    console.log(`🌍 /api/mix-list - IP: ${ip} - Pays: ${country}`);

    // Fetch all .mp3 files from MIX_BUCKET_NAME
    const mixes = await getMp3Files(MIX_BUCKET_NAME);

    const result = mixes.map(mix => ({
      name: mix.replace('.mp3',''), // Display name without extension
      fileName: mix,                 // Original filename
      // ✅ MODIFIÉ : Use your backend API for audio streaming
      url: `/api/file/audio/mix/${encodeURIComponent(mix)}`, 
      // ✅ AJOUTÉ : URL for the waveform JSON file via backend API
      waveformJsonUrl: `/api/file/waveform/mix/${encodeURIComponent(mix.replace('.mp3', '.json'))}` 
    }));

    res.json(result);

  } catch (e) {
    console.error('Error in /api/mix-list:', e);
    res.status(500).json({ error: 'Server error retrieving mix list.' });
  }
});

// REMOVED: This specific route is redundant as it's handled by the generic /api/file route.
// app.get('/api/file/audio/mix/:name', async (req, res) => { ... });

// --- Vertex AI & Description Generation ---
const GEMINI_ENABLED = false; // Set to true to enable Gemini description generation

async function generateSongDescription(songName) {
  try {
    // 1. Check cache in Firestore
    const doc = await db.collection('song_descriptions').doc(songName).get();
    if (doc.exists) {
      console.log('✅ Description found in cache for:', songName);
      return doc.data().text;
    }

    // 2. If Gemini is disabled, return a placeholder
    if (!GEMINI_ENABLED) {
      console.log('⚠️ Gemini description generation is disabled.');
      return 'Description unavailable (Gemini disabled)';
    }
    
    // 3. Generate description using Vertex AI (Gemini 2.5 Pro)
    const model = vertexAI.getGenerativeModel({ model: 'gemini-2.5-pro' }); 
    const response = await model.generateContent({
      contents: [{
        role: 'user',
        parts: [{
          text: `Décris brièvement "${songName.replace('.mp3', '')}" en 2 phrases.`
        }]
      }]
    });
    
    // Extract text, handling potential API response structure variations
    const text = response.response?.candidates?.[0]?.content?.parts?.[0]?.text || 'Failed to generate description';

    // 4. Save to cache if generation was successful
    if (text !== 'Failed to generate description') {
      await db.collection('song_descriptions').doc(songName).set({ text });
      console.log('✅ Description generated and cached for:', songName);
    } else {
      console.error('Failed to generate description for:', songName);
    }

    return text;

  } catch (e) {
    console.error('❌ Error during Gemini description generation:', e.message);
    return 'Description not available';
  }
}

// Optional: Route for batch description generation (use with caution, potentially costly)
// app.get('/api/generate-all-descriptions', async (req, res) => { ... });

// --- Feedback Endpoint ---
app.post('/api/song-feedback', async (req, res) => {
  try {
    const { songName, feedback } = req.body;
    if (!songName || !feedback) return res.status(400).json({ error: 'Missing data (songName, feedback)' });

    // Initialize votedSongs in session if it doesn't exist
    if (!req.session.votedSongs) req.session.votedSongs = {};
    // Check if user already voted for this song in this session
    if (req.session.votedSongs[songName]) return res.status(409).json({ error: 'Vote already recorded for this song.' });

    const statsRef = db.collection('song_stats').doc(songName);
    if (feedback === 'like') {
      await statsRef.set({ likeCount: FieldValue.increment(1) }, { merge: true }); // Increment like count
    } else if (feedback === 'dislike') {
      await statsRef.set({ dislikeCount: FieldValue.increment(1) }, { merge: true }); // Increment dislike count
    } else {
      return res.status(400).json({ error: 'Invalid feedback type. Use "like" or "dislike".' });
    }

    req.session.votedSongs[songName] = true; // Mark as voted in session

    // Fetch updated counts
    const statsDoc = await statsRef.get();
    const data = statsDoc.data() || { likeCount: 0, dislikeCount: 0 }; // Default if doc was just created
    
    res.json({ success: true, likeCount: data.likeCount, dislikeCount: data.dislikeCount });
  } catch (e) {
    console.error('Error in /api/song-feedback:', e);
    res.status(500).json({ error: 'Server error recording feedback.' });
  }
});

// --- Health Check Endpoint ---
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// --- Serve frontend index.html for the root path ---
app.get('/', (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

// --- Start the server ---
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server Musica backend running at http://0.0.0.0:${PORT}`);
});

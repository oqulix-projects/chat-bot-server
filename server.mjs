import dotenv from "dotenv";
import admin from "firebase-admin";
dotenv.config();
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs, { readFileSync } from "fs";
import path from "path";
import OpenAI from "openai";
import speech from "@google-cloud/speech";
// ✅ Import Google Cloud Text-to-Speech
import { TextToSpeechClient } from "@google-cloud/text-to-speech";
import { fileURLToPath } from "url";

// firebase sdk
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

// Initialize Firebase Admin (must run once)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: "oqulix-chat-bot.firebasestorage.app", // ✅ 
  });
}


const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/'); // save in uploads folder
  },
  filename: function (req, file, cb) {
    cb(null, file.originalname); // keep original file name
  }
});

const upload = multer({ storage: storage });

const uploadAudio = multer({ storage: multer.memoryStorage() });


// =============== ROUTES =================
// Health Check
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'biz-rag-backend', time: new Date().toISOString() });
});

// Upload document route
// app.post('/upload', upload.single('file'), (req, res) => {
//   if (!req.file) {
//     return res.status(400).json({ error: "No file uploaded" });
//   }

//   const filePath = req.file.path;
//   let parsedData = null;

//   try {
//     // Read uploaded file
//     const fileContent = fs.readFileSync(filePath, "utf-8");

//     // Parse if it's JSON
//     if (req.file.mimetype === "application/json" || req.file.originalname.endsWith(".json")) {
//       parsedData = JSON.parse(fileContent);
//     } else {
//       parsedData = fileContent; // fallback for txt or other files
//     }

//     res.json({
//       message: "JSON file uploaded successfully",
//       file: req.file.filename,
//       parsedData // return parsed JSON so frontend can verify
//     });

//   } catch (err) {
//     console.error("Error parsing uploaded file:", err);
//     return res.status(500).json({ error: "Failed to parse uploaded JSON" });
//   }
// });

console.log("API Key loaded:", process.env.OPENAI_API_KEY ? "✅ yes" : "❌ no");

// Ask question (OpenAI)
app.post("/ask", async (req, res) => {
  try {
    const { question, userId, language } = req.body;

    if (!question || !userId) {
      return res.status(400).json({ error: "Question and userId are required" });
    }

    // Build file path in Firebase Storage
    const filePath = `instances/${userId}.json`;

    // Download file from Firebase Storage
    const [fileBuffer] = await admin.storage().bucket().file(filePath).download();
    const fileContent = fileBuffer.toString("utf-8");

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are an assistant bot in an event who can help visitors who speaks only in ${language || 'english'} and answers questions based only on the details in the given document. Keep answers minimal unless asked for detail.`
        },
        {
          role: "user",
          content: `Document:\n${fileContent}\n\nQuestion: ${question}`
        }
      ]
    });

    const answer = response.choices[0].message.content;

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.json({ question, answer, userId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error processing request" });
  }
});



// app.post("/ask", async (req, res) => {
//   try {
//     const { question, document, language } = req.body;

//     if (!question || !document) {
//       return res.status(400).json({ error: "Question and document are required" });
//     }

//     // 🔹 Instead of calling GPT, make a fake reply
//     const fakeAnswer = "This is a sample response generated only for testing. The quick brown fox jumps over the lazy dog while testing voice playback functionality smoothly.";

//     res.setHeader('Content-Type', 'application/json; charset=utf-8');
//     res.json({ question, answer: fakeAnswer, document });
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: "Error processing request" });
//   }
// });




// Speech to text
const sttClient = process.env.GCP_SERVICE_ACCOUNT_JSON
  ? new speech.SpeechClient({
      credentials: JSON.parse(process.env.GCP_SERVICE_ACCOUNT_JSON),
      projectId: process.env.GCP_PROJECT_ID,
    })
  : new speech.SpeechClient();

app.post("/stt", uploadAudio.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No audio uploaded" });
    }

    // State from frontend: "malayalam" or "english"
    const { language } = req.body;

    // Map state → Google STT language codes
    let languageCode = "en-US"; // default
    if (language) {
  switch (language.toLowerCase()) {
    case "malayalam":
      languageCode = "ml-IN";
      break;
    case "hindi":
      languageCode = "hi-IN";
      break;
    case "arabic":
      languageCode = "ar-SA";
      break;
    case "english":
    default:
      languageCode = "en-US";
      break;
  }
}


    // Convert buffer → base64
    const audioBytes = req.file.buffer.toString("base64");

    const request = {
      audio: { content: audioBytes },
      config: {
        encoding: "WEBM_OPUS",      
        sampleRateHertz: 48000,     
        languageCode,
        enableAutomaticPunctuation: true,
      },
    };

    const [response] = await sttClient.recognize(request);
    const transcription = response.results
      .map(result => result.alternatives[0].transcript)
      .join(" ");

    res.json({ text: transcription, language: languageCode });
  } catch (err) {
    console.error("STT error:", err);
    res.status(500).json({ error: "STT failed" });
  }
});


// ===================== NEW: TTS ENDPOINT =====================
const ttsClient = process.env.GCP_SERVICE_ACCOUNT_JSON
  ? new TextToSpeechClient({
      credentials: JSON.parse(process.env.GCP_SERVICE_ACCOUNT_JSON),
      projectId: process.env.GCP_PROJECT_ID,
    })
  : new TextToSpeechClient();

app.post("/speak", async (req, res) => {
  try {
    const {
      text,
      languageCode = "en-US",
      voiceName,              // optional
      speakingRate = 1.0,
      pitch = 0.0,
      audioEncoding = "MP3"
    } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ error: "Missing 'text'" });
    }

    // If no voiceName given → pick one automatically
    let selectedVoice = voiceName;
    if (!selectedVoice) {
      selectedVoice = await getVoiceForLanguage(languageCode);
    }

    const request = {
      input: { text },
      voice: {
        languageCode,
        name: selectedVoice,
      },
      audioConfig: {
        audioEncoding,
        speakingRate,
        pitch,
      },
    };

    const [response] = await ttsClient.synthesizeSpeech(request);

    res.setHeader("Content-Type", audioEncoding === "OGG_OPUS" ? "audio/ogg" : "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");

    return res.end(response.audioContent, "binary");
  } catch (err) {
    console.error("TTS error:", err);
    res.status(500).json({ error: "Error generating speech" });
  }
});


// ===================== SERVER START =====================
// const PORT = process.env.PORT ?? 4000;
app.listen(() => {
  console.log(`🚀 Server is running`);
});
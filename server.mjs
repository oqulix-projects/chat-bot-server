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
import Anthropic from "@anthropic-ai/sdk";

import fetch from "node-fetch";

// firebase sdk
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
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



console.log("API Key loaded:", process.env.OPENAI_API_KEY ? "✅ yes" : "❌ no");

// Ask question (OpenAI)
app.post("/ask", async (req, res) => {
  try {
    const { question, userId, language, previousAnswer } = req.body;

    if (!question || !userId) {
      return res.status(400).json({ error: "Question and userId are required" });
    }

    const filePath = `instances/${userId}.json`;
    const [fileBuffer] = await admin.storage().bucket().file(filePath).download();
    const fileContent = fileBuffer.toString("utf-8");

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // ✅ IMPORTANT: set streaming headers
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Transfer-Encoding", "chunked");

    const stream = await client.chat.completions.create({
      model: "gpt-4o-mini",
      stream: true,   // 🔥 THIS ENABLES STREAMING
      messages: [
        {
          role: "system",
          content: `You are 'Oqulix Bot,' a friendly and knowledgeable virtual assistant who acts according to the data in the provided document. Your answers must be based strictly on the provided document. Respond clearly and briefly. Only speak in ${language || "english"}. Consider previous answer: ${previousAnswer}`
        },
        {
          role: "user",
          content: `Document:\n${fileContent}\n\nQuestion: ${question}`
        }
      ]
    });

    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content;
      if (token) {
        res.write(token);   // 🔥 send token immediately
      }
    }

    res.end(); // finish stream

  } catch (err) {
    console.error(err);
    res.status(500).end("Error processing request");
  }
});







// Speech to text
const sttClient = new speech.SpeechClient();

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
      languageCode = "ml-IN",
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


app.post("/speakEleven", async (req, res) => {
  try {
    const {
      text,
      languageCode = "en-US",
      voiceName = "Rachel", // Default ElevenLabs voice name
      speakingRate = .5,
      pitch = 0.0,
      audioEncoding = "MP3",
    } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ error: "Missing 'text'" });
    }

    const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
    if (!elevenLabsApiKey) {
      return res.status(500).json({ error: "Missing ElevenLabs API key" });
    }

    // Prepare voice ID or name (you can map your voiceName to a specific ID if you want)
    const voiceId = await getVoiceIdByName(voiceName, elevenLabsApiKey);
    console.log(voiceId);
    

    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        "xi-api-key": elevenLabsApiKey,
        "Content-Type": "application/json",
        "Accept": audioEncoding === "OGG_OPUS" ? "audio/ogg" : "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2", // Supports multiple languages
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          speaking_rate: speakingRate, // optional
          style: pitch, // optional, maps roughly to expressiveness
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("ElevenLabs TTS error:", error);
      return res.status(500).json({ error: "Error generating speech" });
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    res.setHeader("Content-Type", audioEncoding === "OGG_OPUS" ? "audio/ogg" : "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");

    return res.end(audioBuffer, "binary");
  } catch (err) {
    console.error("TTS error:", err);
    res.status(500).json({ error: "Error generating speech" });
  }
});

// Optional helper function
async function getVoiceIdByName(voiceName, apiKey) {
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": apiKey },
    });
    const data = await res.json();
    const voice = data.voices.find(v => v.name.toLowerCase() === voiceName.toLowerCase());
    return voice ? voice.voice_id : "21m00Tcm4TlvDq8ikWAM"; // Default to Rachel
  } catch (err) {
    console.error("Error fetching voices:", err);
    return "21m00Tcm4TlvDq8ikWAM"; // fallback voice ID
  }
}


// CLAUDE API END POINT
console.log("API Key loaded:", process.env.ANTHROPIC_API_KEY ? "✅ yes" : "❌ no");

// Ask question (Anthropic Claude)
app.post("/askClaude", async (req, res) => {
  try {
    const { question, userId, language, previousAnswer } = req.body;

    const filePath = `instances/${userId}.json`;
    const [fileBuffer] = await admin.storage().bucket().file(filePath).download();
    const fileContent = fileBuffer.toString("utf-8");

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // ✅ No streaming — just get full response
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: `You are 'Oqulix Bot,' a friendly and knowledgeable virtual assistant who acts according to the data in the provided document. Your answers must be based strictly on the provided document. Respond clearly and briefly wiht less words conveying the answer to the question only and not responding with too much information. Only speak in ${language || "english"}. Consider previous answer: ${previousAnswer}. also structure your answer with punctuations accordingly for google TTS to recognize and speak`,
      messages: [
        {
          role: "user",
          content: `Document:\n${fileContent}\n\nQuestion: ${question}`
        }
      ]
    });

    const answer = response.content[0].text;

    // ✅ Return JSON just like OpenAI did
    res.json({ answer });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error processing request" });
  }
});


// ===================== SERVER START =====================
const PORT = process.env.PORT ?? 4000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});

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
import Groq from 'groq-sdk';

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
// app.use(cors());
app.use(express.json({ limit: '5mb' }));


app.use(cors({
  origin: [
    'http://localhost:5173',
    'https://localhost:5173',
    'http://localhost:3000',
    'https://chat-bot-vert-iota.vercel.app','http://192.168.1.35:5173' // ✅ Your Vercel URL
  ],
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
}));


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
// ===================== OPTIMIZE: Index data on startup =====================

// ===================== OPTIMIZE: Index data on startup =====================

// ===================== GLOBAL SHOWROOM DETAILS =====================

// ===================== GLOBAL SHOWROOM DETAILS =====================

let productIndex = [];
let showroomDetails = {
  name: "My G",
  legal_name: "myG Digital / myG (formerly 3G Mobile World)",
  founded: 2006,
  about: "Kerala-headquartered consumer electronics retail chain operating 100+ showrooms across Kerala.",
  headquarters: "Kozhikode, Kerala, India",
  website: "https://www.myg.in",
  categories: ["Mobile phones", "Laptops & PCs", "Mobile accessories", "Televisions", "Home appliances", "Kitchen appliances"],
  ground_floor: {
    left: "Mobiles, Laptops, Mobile Accessories",
    center: "Demo desk",
    right: "Entertainment, TVs, Music"
  },
  first_floor: "Washing Machines, Refrigerators, AC, Kitchen Appliances, Chimneys, Gas Stoves",
  services: ["EMI", "Extended Warranties", "Installation", "Exchange Offers", "Tech Support"],
  bot_location: "Standing near central demo desk on ground floor"
};

let indexingComplete = false;

// Load and index products WITH showroom details
async function indexProducts() {
  try {
    console.log("📚 Loading products & showroom details from Firebase...");
    
    if (!admin.apps.length) {
      console.error("❌ Firebase not initialized!");
      return false;
    }
    
    const filePath = 'instances/9PiH0MEy0cT88deS0R9jqv3HmQF2.json';
    
    console.log(`📂 Fetching: ${filePath}`);
    const [fileBuffer] = await admin.storage().bucket().file(filePath).download();
    const fileContent = fileBuffer.toString("utf-8");
    const data = JSON.parse(fileContent);

    // ✅ Extract showroom details (check multiple places)
    if (data.showroomDetails && Object.keys(data.showroomDetails).length > 0) {
      console.log("✅ Found showroom details in JSON");
      showroomDetails = { ...showroomDetails, ...data.showroomDetails };
    } else if (data[0] && data[0].showroomDetails) {
      console.log("✅ Found showroom details in first array element");
      showroomDetails = { ...showroomDetails, ...data[0].showroomDetails };
    } else {
      console.log("ℹ️  Using default showroom details");
    }

    console.log(`📍 Showroom: ${showroomDetails.name}`);
    console.log(`📍 Location: ${showroomDetails.headquarters}`);

    // ✅ Extract products (handle both array and object with products field)
    let products = [];
    
    if (Array.isArray(data)) {
      // If data is array, filter out showroom details and use rest as products
      products = data.filter(item => !item.showroomDetails && item.Product);
    } else if (data.products && Array.isArray(data.products)) {
      // If data has products field
      products = data.products;
    } else if (data.data && Array.isArray(data.data)) {
      // If data has data field
      products = data.data;
    }

    console.log(`✅ Loaded ${products.length} products from Firebase`);

    // Create searchable index
    productIndex = products.map(product => ({
      ...product,
      searchText: `${product.Product || ''} ${product.Brand || ''} ${product['Item Name'] || ''}`.toLowerCase()
    })).filter(p => p.Product && p.Brand && p['Item Name']); // Only valid products

    console.log(`✅ Indexed ${productIndex.length} valid products`);
    
    // Show categories
    const categoryStats = {};
    productIndex.forEach(p => {
      categoryStats[p.Product] = (categoryStats[p.Product] || 0) + 1;
    });
    
    console.log(`📂 Found ${Object.keys(categoryStats).length} categories`);
    console.log(`✅ PRODUCTS & SHOWROOM DETAILS READY!\n`);
    
    indexingComplete = true;
    return true;
    
  } catch (err) {
    console.error("❌ Error indexing:", err.message);
    console.error(err);
    // Still mark as complete with defaults
    indexingComplete = true;
    return true;
  }
}

// ===================== CATEGORY ALIASES =====================

const categoryAliases = {
  'phone': 'MOBILE',
  'phones': 'MOBILE',
  'mobile': 'MOBILE',
  'smartphone': 'MOBILE',
  'iphone': 'MOBILE',
  'samsung': 'MOBILE',
  'oneplus': 'MOBILE',
  'xiaomi': 'MOBILE',
  'redmi': 'MOBILE',
  'realme': 'MOBILE',
  'vivo': 'MOBILE',
  'oppo': 'MOBILE',
  'google': 'MOBILE',
  
  'ac': ['AIR CONDITIONER', 'AC OUTDOOR'],
  'air': ['AIR CONDITIONER', 'AC OUTDOOR'],
  'cooler': ['AIR CONDITIONER', 'AC OUTDOOR'],
  'conditioner': ['AIR CONDITIONER', 'AC OUTDOOR'],
  
  'laptop': 'LAPTOP',
  'computer': 'LAPTOP',
  'dell': 'LAPTOP',
  'hp': 'LAPTOP',
  'lenovo': 'LAPTOP',
  'asus': 'LAPTOP',
  'macbook': 'LAPTOP',
  
  'tv': 'TV',
  'television': 'TV',
  'display': 'TV',
  'oled': 'TV',
  'qled': 'TV',
  
  'washing': 'WASHING MACHINES',
  'washer': 'WASHING MACHINES',
  'laundry': 'WASHING MACHINES',
  
  'fridge': 'REFRIGERATORS',
  'refrigerator': 'REFRIGERATORS',
  'cool': 'REFRIGERATORS',
  
  'watch': 'SMART WATCH',
  'smartwatch': 'SMART WATCH',
  'wearable': 'SMART WATCH',
  
  'earbuds': 'EARBUDS',
  'headphones': 'EARBUDS',
  'buds': 'EARBUDS',
  'airpods': 'EARBUDS',
  
  'speaker': 'BT SPEAKERS',
  'audio': 'BT SPEAKERS',
  'sound': 'BT SPEAKERS',
  'jbl': 'BT SPEAKERS',
  'sony': 'BT SPEAKERS',
  
  'tablet': 'TABLET',
  'ipad': 'TABLET',
  
  'microwave': 'MICROWAVE OVEN',
  'oven': 'MICROWAVE OVEN',
  
  'printer': 'PRINTER',
  'chimney': 'KITCHEN APPLIANCES',
  'stove': 'KITCHEN APPLIANCES',
  'kitchen': 'KITCHEN APPLIANCES',
};

// ===================== SEARCH FUNCTION =====================

function searchProducts(query) {
  if (!indexingComplete) {
    console.log("⚠️  Indexing still in progress, using defaults...");
  }

  if (!productIndex || productIndex.length === 0) {
    console.log("❌ No products indexed, returning empty results");
    return { products: [], showroom: showroomDetails };
  }

  const queryLower = query.toLowerCase();
  const words = queryLower.split(/\s+/).filter(w => w.length > 2);

  console.log("🔍 Searching for:", query);
  console.log("📝 Search words:", words);

  let targetCategories = new Set();
  
  words.forEach(word => {
    if (categoryAliases[word]) {
      const aliases = categoryAliases[word];
      if (Array.isArray(aliases)) {
        aliases.forEach(cat => targetCategories.add(cat));
      } else {
        targetCategories.add(aliases);
      }
      console.log(`   ✅ Alias: "${word}" → ${Array.isArray(aliases) ? aliases.join(', ') : aliases}`);
    }
  });

  const scored = productIndex.map(product => {
    let score = 0;
    const productLower = (product['Item Name'] || '').toLowerCase();
    const brandLower = (product.Brand || '').toLowerCase();
    const categoryLower = (product.Product || '').toLowerCase();

    // Category match
    if (targetCategories.size > 0) {
      if (targetCategories.has(product.Product)) {
        score += 200;
      }
    }

    // Brand match
    if (brandLower) {
      words.forEach(word => {
        if (brandLower.includes(word)) {
          score += 100;
        }
      });
    }

    // Item name match
    if (productLower) {
      words.forEach(word => {
        const count = (productLower.match(new RegExp(word, 'g')) || []).length;
        if (count > 0) {
          score += count * 30;
        }
      });
    }

    return { ...product, score };
  }).filter(p => p.score > 0);

  const results = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  console.log(`\n📦 SEARCH RESULTS (${results.length} matches):`);

  if (results.length === 0) {
    console.log("   ⚠️  No exact matches. Showing random products:\n");

    const randomProducts = [];
    const selectedCats = new Set();
    const shuffled = [...productIndex].sort(() => Math.random() - 0.5);
    
    for (const product of shuffled) {
      if (!selectedCats.has(product.Product) && randomProducts.length < 5) {
        randomProducts.push(product);
        selectedCats.add(product.Product);
      }
    }

    randomProducts.forEach((product, index) => {
      console.log(`${index + 1}. [S.No: ${product['S.No']}] ${product.Brand} - ${product['Item Name']}`);
      console.log(`   Category: ${product.Product}\n`);
    });

    return { products: randomProducts, showroom: showroomDetails };
  }

  results.forEach((product, index) => {
    console.log(`${index + 1}. [S.No: ${product['S.No']}] ${product.Brand} - ${product['Item Name']}`);
    console.log(`   Category: ${product.Product} | Score: ${product.score}`);
  });
  console.log("");

  return { products: results, showroom: showroomDetails };
}

// ===================== UPDATED: askClaude =====================

app.post("/askClaude", async (req, res) => {
  try {
    const { question, userId, language, previousAnswer } = req.body;

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("🤖 NEW REQUEST");
    console.log(`❓ Question: ${question}`);
    console.log(`🌐 Language: ${language}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    // ✅ Get BOTH products AND showroom details (with safety checks)
    const { products: relevantProducts = [], showroom = showroomDetails } = searchProducts(question);
    
    // ✅ Format showroom context with defaults
    const showroomContext = `
Showroom: ${showroom?.name || "My G"}
Location: ${showroom?.headquarters || "Kozhikode, Kerala"}
Ground Floor (from left): ${showroom?.ground_floor?.left || "Mobiles, Laptops, Accessories"} | Center: Demo desk | Right: ${showroom?.ground_floor?.right || "TVs, Entertainment"}
First Floor: ${showroom?.first_floor || "Appliances"}
Services: ${showroom?.services?.join(', ') || "EMI, Installation, Warranties"}
Bot Location: ${showroom?.bot_location || "Ground floor near demo desk"}
`;

    // Format products context
    const productContext = relevantProducts.length > 0
      ? "Available Products:\n" + relevantProducts.map(p => 
          `- ${p.Brand || 'Unknown'} ${p['Item Name'] || 'Unknown'} (${p.Product || 'Unknown'})${p.MOP ? ` - ₹${p.MOP}` : ''}`
        ).join("\n")
      : "Browse our sections for more products.";

    const fullContext = `${showroomContext}\n${productContext}`;

    console.log("📤 Sending to Claude:");
    console.log(fullContext);
    console.log("\n");

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const stream = await client.messages.stream({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: `You are "Oqulix Bot", a friendly sales assistant at My G showroom in Kozhikode, Kerala.
You stand on the ground floor near the demo desk facing the showroom.
LEFT side: Mobiles, Laptops, Mobile Accessories
RIGHT side: TVs, Entertainment, Music, Speakers
UPSTAIRS (First Floor): Washing Machines, Refrigerators, AC, Kitchen Appliances, Chimneys, Gas Stoves
You offer: EMI options, Extended Warranties, Installation Services, Exchange Offers, Tech Support
Be helpful, guide customers to the right section, mention products by brand and price when available.
Respond only in ${language || "english"}.
Use proper punctuation for natural Google TTS speech.Strictly do not use emojis in reply. Stricly keep messages very short unless necessary and provide only necessary information`,
      messages: [
        {
          role: "user",
          content: `${fullContext}\n\nCustomer Question: ${question}`
        }
      ]
    });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    let fullAnswer = "";

    stream.on('text', (text) => {
      fullAnswer += text;
      console.log("🟢 Chunk:", text);
      res.write(`data: ${JSON.stringify({ chunk: text })}\n\n`);
    });

    stream.on('end', () => {
      console.log("\n✅ Full Answer:", fullAnswer);
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
      res.write(`data: ${JSON.stringify({ done: true, answer: fullAnswer })}\n\n`);
      res.end();
    });

    stream.on('error', (err) => {
      console.error("Stream error:", err);
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error processing request" });
  }
});

// ===================== SERVER START =====================

const PORT = process.env.PORT ?? 4000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on http://0.0.0.0:${PORT}\n`);
  indexProducts(); // Non-blocking, loads in background
});


// asking groq
// app.post("/askGroq", async (req, res) => {
//   try {
//     const { question, userId, language, previousAnswer } = req.body;

//     const filePath = `instances/${userId}.json`;
//     const [fileBuffer] = await admin.storage().bucket().file(filePath).download();
//     const fileContent = fileBuffer.toString("utf-8");

//     const client = new Groq({
//       apiKey: process.env.GROQ_API_KEY
//     });

//     // ✅ Updated to latest available model
//     const response = await client.chat.completions.create({
//       model: "llama-3.3-70b-versatile",
//       max_tokens: 1024,
//       messages: [
//         {
//           role: "system",
//           content: `You are "Oqulix Bot", a friendly and knowledgeable assistant. 
// Answer strictly using only the provided document. 
// Keep responses clear, brief, and directly answer the question without extra details. 
// Respond only in ${language || "english"}. 
// Use proper punctuation for natural Google TTS speech. 
// When speaking in non-English languages, use natural conversational style and mix common English words where appropriate instead of literal dictionary translations. 
// Consider the previous answer: ${previousAnswer}.`
//         },
//         {
//           role: "user",
//           content: `Document:\n${fileContent}\n\nQuestion: ${question}`
//         }
//       ]
//     });

//     const answer = response.choices[0].message.content;

//     // ✅ Return JSON just like Claude did
//     res.json({ answer });

//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: "Error processing request" });
//   }
// });
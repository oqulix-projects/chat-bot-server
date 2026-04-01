import dotenv from "dotenv";
import admin from "firebase-admin";
dotenv.config();
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import OpenAI from "openai";
import speech from "@google-cloud/speech";
import { TextToSpeechClient } from "@google-cloud/text-to-speech";
import Anthropic from "@anthropic-ai/sdk";
import fetch from "node-fetch";

// ===================== FIREBASE SETUP =====================

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: "oqulix-chat-bot.firebasestorage.app",
  });
}

// ===================== EXPRESS SETUP =====================

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(cors({
  origin: [
    'http://localhost:5173',
    'https://localhost:5173',
    'http://localhost:3000',
    'https://chat-bot-vert-iota.vercel.app',
    'http://192.168.1.35:5173'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
}));

// ===================== MULTER SETUP =====================

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    cb(null, file.originalname);
  }
});

const upload = multer({ storage: storage });
const uploadAudio = multer({ storage: multer.memoryStorage() });

// ===================== GLOBAL STATE =====================

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

let categoryStats = {};
let indexingComplete = false;

// ===================== LOAD PRODUCTS =====================

async function indexProducts() {
  try {
    console.log("📚 Loading products from Firebase...");

    const filePath = 'instances/thondayad_future_stock-sourcetable.json';
    console.log(`📂 Fetching: ${filePath}`);

    const [fileBuffer] = await admin.storage().bucket().file(filePath).download();
    const fileContent = fileBuffer.toString("utf-8");

    // Parse JSON - remove trailing commas if any
    const cleanContent = fileContent.replace(/,\s*]/g, ']').replace(/,\s*}/g, '}');
    const data = JSON.parse(cleanContent);

    // Extract showroom details if present
    if (data.showroomDetails && Object.keys(data.showroomDetails).length > 0) {
      console.log("✅ Found showroom details in JSON");
      showroomDetails = { ...showroomDetails, ...data.showroomDetails };
    } else if (Array.isArray(data) && data[0] && data[0].showroomDetails) {
      console.log("✅ Found showroom details in first array element");
      showroomDetails = { ...showroomDetails, ...data[0].showroomDetails };
    } else {
      console.log("ℹ️  Using default showroom details");
    }

    console.log(`📍 Showroom: ${showroomDetails.name}`);
    console.log(`📍 Location: ${showroomDetails.headquarters}`);

    // Extract products
    let products = [];
    if (Array.isArray(data)) {
      products = data.filter(item => item.Product && item.Brand && item['Item Name']);
    } else if (data.products && Array.isArray(data.products)) {
      products = data.products.filter(item => item.Product && item.Brand && item['Item Name']);
    } else if (data.data && Array.isArray(data.data)) {
      products = data.data.filter(item => item.Product && item.Brand && item['Item Name']);
    }

    console.log(`✅ Loaded ${products.length} products`);

    // Create searchable index
    productIndex = products.map(product => ({
      ...product,
      searchText: `${product.Product || ''} ${product.Brand || ''} ${product['Item Name'] || ''}`.toLowerCase()
    }));

    // Calculate category statistics
    categoryStats = {};
    productIndex.forEach(p => {
      categoryStats[p.Product] = (categoryStats[p.Product] || 0) + 1;
    });

    console.log(`✅ Indexed ${productIndex.length} products`);
    console.log(`📂 Found ${Object.keys(categoryStats).length} product categories`);
    console.log(`\n📊 Top 15 Categories:`);

    const topCats = Object.entries(categoryStats)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);

    topCats.forEach(([cat, count], idx) => {
      console.log(`   ${idx + 1}. ${cat} (${count} items)`);
    });

    console.log(`\n✅ PRODUCTS READY!\n`);
    indexingComplete = true;
    return true;

  } catch (err) {
    console.error("❌ Error indexing:", err.message);
    console.error(err);
    indexingComplete = true; // Mark complete even on error so server doesn't hang
    return false;
  }
}

// ===================== CATEGORY ALIASES =====================

const categoryAliases = {
  // Mobiles
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

  // AC
  'ac': ['AIR CONDITIONER', 'AC OUTDOOR'],
  'air': ['AIR CONDITIONER', 'AC OUTDOOR'],
  'cooler': ['AIR CONDITIONER', 'AC OUTDOOR'],
  'conditioner': ['AIR CONDITIONER', 'AC OUTDOOR'],

  // Laptops
  'laptop': 'LAPTOP',
  'computer': 'LAPTOP',
  'dell': 'LAPTOP',
  'hp': 'LAPTOP',
  'lenovo': 'LAPTOP',
  'asus': 'LAPTOP',
  'macbook': 'LAPTOP',

  // TV
  'tv': 'TV',
  'television': 'TV',
  'display': 'TV',
  'oled': 'TV',
  'qled': 'TV',

  // Washing Machines
  'washing': 'WASHING MACHINES',
  'washer': 'WASHING MACHINES',
  'laundry': 'WASHING MACHINES',

  // Refrigerators
  'fridge': 'REFRIGERATORS',
  'refrigerator': 'REFRIGERATORS',
  'cool': 'REFRIGERATORS',
  'freezer': 'FREEZER',

  // Smart Watch
  'watch': 'SMART WATCH',
  'smartwatch': 'SMART WATCH',
  'wearable': 'SMART WATCH',

  // Earbuds
  'earbuds': 'EARBUDS',
  'headphones': 'EARBUDS',
  'buds': 'EARBUDS',
  'airpods': 'EARBUDS',

  // Speakers
  'speaker': 'BT SPEAKERS',
  'audio': 'BT SPEAKERS',
  'sound': 'BT SPEAKERS',
  'jbl': 'BT SPEAKERS',
  'sony': 'BT SPEAKERS',
  'soundbar': 'HOME THEATRE',
  'home theatre': 'HOME THEATRE',

  // Tablet
  'tablet': 'TABLET',
  'ipad': 'TABLET',

  // Microwave
  'microwave': 'MICROWAVE OVEN',
  'oven': 'MICROWAVE OVEN',

  // Printer
  'printer': 'PRINTER',
  'print': 'PRINTER',
  'canon': 'PRINTER',
  'epson': 'PRINTER',

  // Kitchen
  'chimney': 'KITCHEN APPLIANCES',
  'stove': 'KITCHEN APPLIANCES',
  'kitchen': 'KITCHEN APPLIANCES',

  // Dryer / Dishwasher
  'dryer': 'DRYER',
  'drying': 'DRYER',
  'dishwasher': 'DISH WASHER',
  'dish': 'DISH WASHER',
};

// ===================== SEARCH PRODUCTS =====================

function searchProducts(query) {
  if (!productIndex || productIndex.length === 0) {
    console.log("❌ No products indexed");
    return { products: [], showroom: showroomDetails };
  }

  const queryLower = query.toLowerCase();
  const words = queryLower.split(/\s+/).filter(w => w.length > 2);

  console.log("🔍 Searching:", query);
  console.log("📝 Words:", words);

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

    // Category match (highest priority)
    if (targetCategories.size > 0 && targetCategories.has(product.Product)) {
      score += 200;
    }

    // Brand match
    if (brandLower) {
      words.forEach(word => {
        if (brandLower.includes(word)) score += 100;
      });
    }

    // Item name match
    if (productLower) {
      words.forEach(word => {
        const count = (productLower.match(new RegExp(word, 'g')) || []).length;
        if (count > 0) score += count * 30;
      });
    }

    return { ...product, score };
  }).filter(p => p.score > 0);

  const results = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  console.log(`\n📦 Found ${results.length} matches\n`);

  if (results.length === 0) {
    // Return random products from different categories
    const randomProducts = [];
    const selectedCats = new Set();
    const shuffled = [...productIndex].sort(() => Math.random() - 0.5);

    for (const product of shuffled) {
      if (!selectedCats.has(product.Product) && randomProducts.length < 5) {
        randomProducts.push(product);
        selectedCats.add(product.Product);
      }
    }

    return { products: randomProducts, showroom: showroomDetails };
  }

  return { products: results, showroom: showroomDetails };
}

// ===================== ROUTES =====================

// Health Check
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'myg-bot', indexed: indexingComplete, time: new Date().toISOString() });
});

// List all product categories
app.get('/api/categories', (_req, res) => {
  if (!indexingComplete) {
    return res.status(503).json({ error: "Still indexing products" });
  }

  const categories = Object.entries(categoryStats)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));

  res.json({
    total_categories: categories.length,
    total_products: productIndex.length,
    categories: categories
  });
});

// Get products by category
app.get('/api/products/:category', (req, res) => {
  if (!indexingComplete) {
    return res.status(503).json({ error: "Still indexing products" });
  }

  const { category } = req.params;
  const products = productIndex
    .filter(p => p.Product.toLowerCase().includes(category.toLowerCase()))
    .slice(0, 20);

  res.json({
    category: category,
    count: products.length,
    products: products
  });
});

// Quick product search endpoint
app.post('/api/search', (req, res) => {
  if (!indexingComplete) {
    return res.status(503).json({ error: "Still indexing products" });
  }

  const { query } = req.body;

  if (!query || query.trim().length === 0) {
    return res.status(400).json({ error: "Query required" });
  }

  const { products, showroom } = searchProducts(query);

  res.json({
    query: query,
    count: products.length,
    products: products,
    showroom: showroom
  });
});

// ===================== OPENAI ASK ENDPOINT =====================

console.log("API Key loaded:", process.env.OPENAI_API_KEY ? "✅ yes" : "❌ no");

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

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Transfer-Encoding", "chunked");

    const stream = await client.chat.completions.create({
      model: "gpt-4o-mini",
      stream: true,
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
        res.write(token);
      }
    }

    res.end();

  } catch (err) {
    console.error(err);
    res.status(500).end("Error processing request");
  }
});

// ===================== SPEECH TO TEXT =====================

const sttClient = new speech.SpeechClient();

app.post("/stt", uploadAudio.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No audio uploaded" });
    }

    const { language } = req.body;

    let languageCode = "en-US";
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

// ===================== GOOGLE TEXT TO SPEECH =====================

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
      voiceName,
      speakingRate = 1.0,
      pitch = 0.0,
      audioEncoding = "MP3"
    } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ error: "Missing 'text'" });
    }

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

// ===================== ELEVENLABS TEXT TO SPEECH =====================

app.post("/speakEleven", async (req, res) => {
  try {
    const {
      text,
      languageCode = "en-US",
      voiceName = "Rachel",
      speakingRate = 0.5,
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

    const voiceId = await getVoiceIdByName(voiceName, elevenLabsApiKey);
    console.log("ElevenLabs voiceId:", voiceId);

    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        "xi-api-key": elevenLabsApiKey,
        "Content-Type": "application/json",
        "Accept": audioEncoding === "OGG_OPUS" ? "audio/ogg" : "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          speaking_rate: speakingRate,
          style: pitch,
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

// Helper: get ElevenLabs voice ID by name
async function getVoiceIdByName(voiceName, apiKey) {
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": apiKey },
    });
    const data = await res.json();
    const voice = data.voices.find(v => v.name.toLowerCase() === voiceName.toLowerCase());
    return voice ? voice.voice_id : "21m00Tcm4TlvDq8ikWAM"; // Default: Rachel
  } catch (err) {
    console.error("Error fetching voices:", err);
    return "21m00Tcm4TlvDq8ikWAM";
  }
}

// ===================== CLAUDE ASK ENDPOINT =====================

app.post("/askClaude", async (req, res) => {
  try {
    const { question, userId, language, previousAnswer } = req.body;

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("🤖 NEW REQUEST");
    console.log(`❓ Question: ${question}`);
    console.log(`🌐 Language: ${language}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    // Wait for indexing if still in progress
    if (!indexingComplete) {
      await new Promise(r => setTimeout(r, 1000));
      if (!indexingComplete) {
        return res.status(503).json({ error: "Still loading products. Please try again." });
      }
    }

    // Search for relevant products and showroom details
    const { products: relevantProducts = [], showroom = showroomDetails } = searchProducts(question);

    // Format showroom context
    const showroomContext = `
Showroom: ${showroom?.name || "My G"}
Location: ${showroom?.headquarters || "Kozhikode, Kerala"}
Ground Floor (from left): ${showroom?.ground_floor?.left || "Mobiles, Laptops, Accessories"} | Center: Demo desk | Right: ${showroom?.ground_floor?.right || "TVs, Entertainment"}
First Floor: ${showroom?.first_floor || "Appliances"}
Services: ${showroom?.services?.join(', ') || "EMI, Installation, Warranties"}
Bot Location: ${showroom?.bot_location || "Ground floor near demo desk"}`;

    // Format products context
    const productContext = relevantProducts.length > 0
      ? "Available Products:\n" + relevantProducts
          .slice(0, 8)
          .map(p => `- ${p.Brand || 'Unknown'} ${p['Item Name'] || 'Unknown'} (${p.Product || 'Unknown'})${p.MOP ? ` - ₹${p.MOP}` : ''}`)
          .join("\n")
      : "Browse our showroom sections for more products.";

    const fullContext = `${showroomContext}\n\n${productContext}`;

    console.log("📤 Sending to Claude:");
    console.log(fullContext);
    console.log("\n");

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const stream = await client.messages.stream({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: `You are "Oqulix Bot", a friendly sales assistant at My G showroom in Kozhikode, Kerala.
You stand on the ground floor near the central demo desk facing the showroom.
GROUND FLOOR LEFT: Mobiles, Laptops, Mobile Accessories
GROUND FLOOR RIGHT: Televisions, Entertainment, Music, Speakers
FIRST FLOOR (Upstairs): Washing Machines, Refrigerators, AC, Kitchen Appliances, Microwaves, Printers, Tablets
We offer: EMI options, Extended Warranties, Installation Services, Exchange Offers, Tech Support
Be friendly, helpful, and guide customers to the right section.
When mentioning products, include brand, features, and price if available.
Respond only in ${language || "english"}.
Use proper punctuation and natural phrasing for Google TTS speech synthesis.
Strictly do not use emojis in reply. Keep messages short unless necessary and provide only essential information.`,
      messages: [{
        role: "user",
        content: `${fullContext}\n\nCustomer Question: ${question}`
      }]
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
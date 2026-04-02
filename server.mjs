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

// Firebase setup
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: "oqulix-chat-bot.firebasestorage.app",
  });
}

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

// ===================== COMPREHENSIVE PRODUCT ALIASES =====================
// Maps user queries (English & Malayalam) to exact product categories

const PRODUCT_ALIASES = {
  // MOBILE & PHONES
  'phone': 'MOBILE',
  'phones': 'MOBILE',
  'mobile': 'MOBILE',
  'smartphone': 'MOBILE',
  'cellphone': 'MOBILE',
  'mobilephones': 'MOBILE',
  'iphone': 'MOBILE',
  'samsung': 'MOBILE',
  'xiaomi': 'MOBILE',
  'redmi': 'MOBILE',
  'realme': 'MOBILE',
  'vivo': 'MOBILE',
  'oppo': 'MOBILE',
  'oneplus': 'MOBILE',
  'motorola': 'MOBILE',
  'nokia': 'MOBILE',
  'googlephone': 'MOBILE',
  'pixel': 'MOBILE',
  // Malayalam: phones
  'ഫോൺ': 'MOBILE',
  'മോബൈല്‍': 'MOBILE',
  'സെല്ലുലാർ': 'MOBILE',

  // LAPTOPS & COMPUTERS
  'laptop': 'LAPTOP',
  'laptops': 'LAPTOP',
  'computer': 'LAPTOP',
  'computers': 'LAPTOP',
  'notebook': 'LAPTOP',
  'macbook': 'LAPTOP',
  'dell': 'LAPTOP',
  'hp': 'LAPTOP',
  'asus': 'LAPTOP',
  'lenovo': 'LAPTOP',
  'acer': 'LAPTOP',
  'workstation': 'LAPTOP',
  // Malayalam: laptops
  'ലാപ്ടോപ്': 'LAPTOP',
  'ലാപ്റ്റോപ്': 'LAPTOP',
  'കമ്പ്യൂട്ടർ': 'LAPTOP',

  // TELEVISIONS
  'tv': 'TV',
  'tvs': 'TV',
  'television': 'TV',
  'televisions': 'TV',
  'flatscreen': 'TV',
  'plasma': 'TV',
  'led': 'TV',
  'oled': 'TV',
  'qled': 'TV',
  '4k': 'TV',
  '8k': 'TV',
  'smarttv': 'TV',
  // Malayalam: TV
  'ടിവി': 'TV',
  'ടെലിവിഷൻ': 'TV',
  'സ്ക്രീൻ': 'TV',

  // WASHING MACHINES
  'washing': 'WASHING MACHINES',
  'washer': 'WASHING MACHINES',
  'washingmachine': 'WASHING MACHINES',
  'washingmachines': 'WASHING MACHINES',
  'laundry': 'WASHING MACHINES',
  'frontload': 'WASHING MACHINES',
  'topload': 'WASHING MACHINES',
  'automaticwasher': 'WASHING MACHINES',
  // Malayalam: washing machine
  'വാഷിംഗ്': 'WASHING MACHINES',
  'വാഷ്': 'WASHING MACHINES',
  'ലോഹിത': 'WASHING MACHINES',

  // REFRIGERATORS & FREEZERS
  'fridge': 'REFRIGERATORS',
  'freezer': 'REFRIGERATORS',
  'refrigerator': 'REFRIGERATORS',
  'refrigerators': 'REFRIGERATORS',
  'doublefridge': 'REFRIGERATORS',
  'singlefridge': 'REFRIGERATORS',
  'frenchfridge': 'REFRIGERATORS',
  'coolbox': 'REFRIGERATORS',
  // Malayalam: fridge/refrigerator
  'ഫ്രിജ്': 'REFRIGERATORS',
  'തണുപ്പെടുത്തി': 'REFRIGERATORS',
  'കോൾഡ്': 'REFRIGERATORS',

  // AIR CONDITIONERS
  'ac': ['AIR CONDITIONER', 'AC OUTDOOR'],
  'acs': ['AIR CONDITIONER', 'AC OUTDOOR'],
  'air': ['AIR CONDITIONER', 'AC OUTDOOR'],
  'airconditioner': ['AIR CONDITIONER', 'AC OUTDOOR'],
  'airconditioners': ['AIR CONDITIONER', 'AC OUTDOOR'],
  'ac-outdoor': 'AC OUTDOOR',
  'split-ac': 'AC OUTDOOR',
  'windowac': 'AC OUTDOOR',
  'cooler': ['AIR CONDITIONER', 'AC OUTDOOR'],
  'conditioning': ['AIR CONDITIONER', 'AC OUTDOOR'],
  // Malayalam: AC/cooler
  'എസി': ['AIR CONDITIONER', 'AC OUTDOOR'],
  'എയർ': ['AIR CONDITIONER', 'AC OUTDOOR'],
  'കൂലർ': ['AIR CONDITIONER', 'AC OUTDOOR'],
  'തണുപ്പ്': ['AIR CONDITIONER', 'AC OUTDOOR'],

  // HOME APPLIANCES
  'appliance': 'HOME APPLIANCES',
  'appliances': 'HOME APPLIANCES',
  'homeappliances': 'HOME APPLIANCES',
  'kitchenappliances': 'HOME APPLIANCES',
  'microwave': 'HOME APPLIANCES',
  'oven': 'HOME APPLIANCES',
  'mixer': 'HOME APPLIANCES',
  'grinder': 'HOME APPLIANCES',
  'blender': 'HOME APPLIANCES',
  'chimney': 'HOME APPLIANCES',
  'stove': 'HOME APPLIANCES',
  'cooktop': 'HOME APPLIANCES',
  // Malayalam: appliances
  'ഉപകരണങ്ങൾ': 'HOME APPLIANCES',
  'വീട്ടുകൂലി': 'HOME APPLIANCES',

  // SPEAKERS & AUDIO
  'speaker': 'BT SPEAKERS',
  'speakers': 'BT SPEAKERS',
  'btspeaker': 'BT SPEAKERS',
  'bluetooth': 'BT SPEAKERS',
  'soundbar': 'BT SPEAKERS',
  'audio': 'BT SPEAKERS',
  'sound': 'BT SPEAKERS',
  'hometheatre': 'HOME THEATRE',
  'surround': 'BT SPEAKERS',
  // Malayalam: speaker
  'സ്പീക്കർ': 'BT SPEAKERS',
  'സൗണ്ട്': 'BT SPEAKERS',

  // EARBUDS & HEADPHONES
  'earbuds': 'EARBUDS',
  'earphones': 'EARBUDS',
  'headphones': 'EARBUDS',
  'buds': 'EARBUDS',
  'airpods': 'EARBUDS',
  'wireless': 'EARBUDS',
  'tws': 'EARBUDS',
  'inear': 'EARBUDS',
  // Malayalam: earbuds
  'ഇയർബഡ്': 'EARBUDS',
  'ഹെഡ്ഫോൺ': 'EARBUDS',

  // SMART WATCHES
  'watch': 'SMART WATCH',
  'watches': 'SMART WATCH',
  'smartwatch': 'SMART WATCH',
  'wearable': 'SMART WATCH',
  'fitbit': 'SMART WATCH',
  'applewatchwatch': 'SMART WATCH',
  // Malayalam: watch
  'വാച്ച്': 'SMART WATCH',
  'കടക്കാണ്': 'SMART WATCH',

  // TABLETS
  'tablet': 'LAPTOP',
  'tablets': 'LAPTOP',
  'ipad': 'LAPTOP',
  'ipads': 'LAPTOP',
  // Malayalam: tablet
  'ടാബ്ലെറ്റ്': 'LAPTOP',

  // ACCESSORIES
  'accessories': 'ACC BGN',
  'accessory': 'ACC BGN',
  'charger': 'ACC BGN',
  'cable': 'ACC BGN',
  'adapter': 'ACC BGN',
  'powerbank': 'ACC BGN',
  'protector': 'ACC BGN',
  'case': 'ACC BGN',
  'cover': 'ACC BGN',
  'screenguard': 'ACC BGN',
  'tempered': 'ACC BGN',
  // Malayalam: accessories
  'അനുബന്ധങ്ങൾ': 'ACC BGN',
  'സാധാരണ': 'ACC BGN',

  // SMALL APPLIANCES
  'smallappliance': 'SMALL APPLIANCES',
  'smallappliances': 'SMALL APPLIANCES',
  'kettle': 'SMALL APPLIANCES',
  'toaster': 'SMALL APPLIANCES',
  'iron': 'SMALL APPLIANCES',
  'vacuum': 'SMALL APPLIANCES',
  'cleaner': 'SMALL APPLIANCES',

  // CROCKERY & KITCHENWARE
  'crockery': 'CROCKERY',
  'dishes': 'CROCKERY',
  'kitchenware': 'CROCKERY',
  'cookware': 'CROCKERY',
  'platesets': 'CROCKERY',
  'bowls': 'CROCKERY',
  'glasses': 'CROCKERY',

  // P&G (Personal Care & Grooming)
  'personcare': 'P&G',
  'grooming': 'P&G',
  'shampoo': 'P&G',
  'conditioner': 'P&G',
  'skincare': 'P&G',
  'toothpaste': 'P&G',
  'beauty': 'P&G',

  // PRINTERS
  'printer': 'PRINTER',
  'printers': 'PRINTER',
  'print': 'PRINTER',
  'multifunction': 'PRINTER',
  'scanner': 'PRINTER',
  'inkjet': 'PRINTER',
  'laser': 'PRINTER',

  // MONITORS & DISPLAYS
  'monitor': 'IT ACCESSORIES',
  'monitors': 'IT ACCESSORIES',
  'display': 'IT ACCESSORIES',
  'screen': 'IT ACCESSORIES',

  // HOME THEATRE
  'theatre': 'HOME THEATRE',
  'homecinema': 'HOME THEATRE',
  'cinematichome': 'HOME THEATRE',

  // STATIONERY
  'stationery': 'STATIONERY ITEMS',
  'paper': 'STATIONERY ITEMS',
  'pen': 'STATIONERY ITEMS',
};

// ===================== GLOBAL STATE =====================

let productIndex = [];
let showroomDetails = {};
let categoryIndex = {};
let indexingComplete = false;

// ===================== LOAD & INDEX PRODUCTS =====================

async function indexProducts() {
  try {
    console.log("📚 Loading products from Firebase...");
    
    const filePath = 'instances/VflBi4102DXStnEfB2zB3acxwYV2.json';
    console.log(`📂 Fetching: ${filePath}`);
    
    const [fileBuffer] = await admin.storage().bucket().file(filePath).download();
    const fileContent = fileBuffer.toString("utf-8");
    const data = JSON.parse(fileContent);

    // Extract showroom details
    showroomDetails = data.showroomDetails || {};
    const products = data.products || [];

    console.log(`✅ Loaded ${products.length} products`);

    // Create searchable index
    productIndex = products.filter(p => p.Product && p.Brand && p['Item Name']);

    // Create category index for fast lookup
    categoryIndex = {};
    productIndex.forEach(product => {
      const cat = product.Product;
      if (!categoryIndex[cat]) {
        categoryIndex[cat] = [];
      }
      categoryIndex[cat].push(product);
    });

    console.log(`✅ Indexed ${productIndex.length} valid products`);
    console.log(`📂 Found ${Object.keys(categoryIndex).length} product categories\n`);
    console.log("📊 Top 20 Categories:");
    
    const sorted = Object.entries(categoryIndex)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 20);
    
    sorted.forEach(([cat, items], idx) => {
      console.log(`   ${idx + 1}. ${cat} (${items.length} items)`);
    });

    console.log(`\n✅ PRODUCTS READY!\n`);
    indexingComplete = true;
    return true;
    
  } catch (err) {
    console.error("❌ Error indexing:", err.message);
    indexingComplete = true;
    return false;
  }
}

// ===================== INTENT DETECTION & PRODUCT SEARCH =====================

function normalizeQuery(query) {
  return query
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ');
}

function extractProductIntent(query) {
  const normalized = normalizeQuery(query);
  const words = normalized.split(/\s+/);

  console.log(`\n🔍 Query Analysis: "${query}"`);
  console.log(`📝 Normalized: "${normalized}"`);
  console.log(`🔤 Words: [${words.join(', ')}]`);

  let matchedCategories = new Set();
  let matchedBrands = [];
  let matchedAliases = [];

  // Check for product aliases
  for (const word of words) {
    if (PRODUCT_ALIASES[word]) {
      const result = PRODUCT_ALIASES[word];
      if (Array.isArray(result)) {
        result.forEach(cat => matchedCategories.add(cat));
        matchedAliases.push(`${word} → [${result.join(', ')}]`);
      } else {
        matchedCategories.add(result);
        matchedAliases.push(`${word} → ${result}`);
      }
    }
  }

  // Check for brand names
  for (const word of words) {
    const brandMatch = Object.keys(categoryIndex).find(cat => 
      categoryIndex[cat].some(p => 
        p.Brand.toLowerCase().includes(word) && word.length > 2
      )
    );
    
    if (brandMatch) {
      matchedBrands.push(word);
    }
  }

  if (matchedAliases.length > 0) {
    console.log(`   ✅ Aliases matched: ${matchedAliases.join(', ')}`);
  }

  return {
    categories: Array.from(matchedCategories),
    brands: matchedBrands,
    words: words
  };
}

function searchProducts(query) {
  if (!indexingComplete || productIndex.length === 0) {
    console.log("❌ Products not indexed yet");
    return { products: [], showroom: showroomDetails };
  }

  const { categories, brands, words } = extractProductIntent(query);

  let results = [];

  // Priority 1: Category aliases found
  if (categories.length > 0) {
    console.log(`\n✅ Searching categories: [${categories.join(', ')}]`);
    
    for (const category of categories) {
      if (categoryIndex[category]) {
        results.push(...categoryIndex[category].slice(0, 8));
      }
    }
  }

  // Priority 2: If no category matches, search by item name & brand
  if (results.length === 0) {
    console.log(`\n🔎 No exact category match, searching by item name...`);
    
    results = productIndex.filter(product => {
      const itemLower = (product['Item Name'] || '').toLowerCase();
      const brandLower = (product.Brand || '').toLowerCase();
      
      return words.some(word => 
        itemLower.includes(word) || brandLower.includes(word)
      );
    }).slice(0, 10);
  }

  // Fallback: Random products from different categories
  if (results.length === 0) {
    console.log(`\n❌ No matches found. Showing random products...`);
    
    const uniqueCats = [...Object.values(categoryIndex)];
    const shuffled = uniqueCats.sort(() => Math.random() - 0.5);
    
    for (const catProducts of shuffled.slice(0, 5)) {
      results.push(catProducts[0]);
    }
  }

  console.log(`\n📦 Found ${results.length} products\n`);
  
  return { 
    products: results.slice(0, 10),
    showroom: showroomDetails 
  };
}

// ===================== ROUTES =====================

app.get('/health', (_req, res) => {
  res.json({ ok: true, indexed: indexingComplete, products: productIndex.length, time: new Date().toISOString() });
});

// GET all categories
app.get('/api/categories', (_req, res) => {
  if (!indexingComplete) {
    return res.status(503).json({ error: "Still indexing" });
  }

  const categories = Object.entries(categoryIndex)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([name, items]) => ({ name, count: items.length }));

  res.json({ categories });
});

// GET products by category
app.get('/api/products/:category', (req, res) => {
  if (!indexingComplete) {
    return res.status(503).json({ error: "Still indexing" });
  }

  const { category } = req.params;
  const products = categoryIndex[category] || [];

  res.json({
    category,
    count: products.length,
    products: products.slice(0, 20)
  });
});

// ===================== OPENAI ASK ENDPOINT =====================

console.log("OpenAI API Key loaded:", process.env.OPENAI_API_KEY ? "✅ yes" : "❌ no");

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
    const { question, userId, language } = req.body;

    console.log("\n" + "=".repeat(70));
    console.log("🤖 NEW REQUEST");
    console.log(`❓ ${question}`);
    console.log(`🌐 ${language}`);
    console.log("=".repeat(70));

    if (!indexingComplete) {
      await new Promise(r => setTimeout(r, 1000));
      if (!indexingComplete) {
        return res.status(503).json({ error: "Still loading products" });
      }
    }

    // Detect intent and find products
    const { products: relevantProducts = [], showroom } = searchProducts(question);

    // Format context
    const showroomContext = `
Showroom Information:
- Name: ${showroom.name || 'My G'}
- Location: ${showroom.headquarters || 'Kozhikode, Kerala'}
- Ground Floor LEFT: ${showroom.ground_floor?.left || 'Mobiles, Laptops'}
- Ground Floor RIGHT: ${showroom.ground_floor?.right || 'TVs, Entertainment'}
- First Floor: ${showroom.first_floor || 'Appliances'}
- Services: ${showroom.services?.join(', ') || 'EMI, Warranty, Installation'}`;

    const productContext = relevantProducts.length > 0
      ? `Available Products:\n` + relevantProducts
          .slice(0, 8)
          .map((p, idx) => `${idx + 1}. ${p.Brand} - ${p['Item Name']} (${p.Product})${p.MOP ? ` - ₹${p.MOP}` : ''}`)
          .join("\n")
      : "No specific products found for this query. Suggest browsing showroom.";

    const fullContext = `${showroomContext}\n\n${productContext}`;

    console.log("\n📤 Sending to Claude...\n");

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const systemPrompt = language === 'malayalam' 
      ? `നിങ്ങൾ "Oqulix Bot" ആണ്, My G ഷോരൂമിന്റെ സൗജന്യ സഹായി.
കസ്റ്റമർ പ്രതിനിധി എന്ന നിലയിൽ സ്നേഹത്തോടെയും സഹായകരമായും പ്രതികരിക്കുക.
ഭാഷ മലയാളമായിരിക്കണം. പ്രോഡക്ട് വിവരങ്ങൾ നൽകുക. Do not use emojis, do not use ":" or unwanted punctuations because google tts cant read it. Keep answers much short and elaborate only if necessary`
      : `You are "Oqulix Bot", friendly sales assistant at My G showroom in Kozhikode.
Be helpful and guide customers to right products and locations.
Mention brands, prices, and features when available.
Ground floor LEFT: Mobiles, Laptops. RIGHT: TVs, Entertainment.
First floor: Appliances (AC, Washing Machines, Fridges, etc.)
Offer: EMI, Installation, Warranty, Exchange.
Respond only in English. Do not use emojis, do not use ":" or unwanted punctuations because google tts cant read it. Keep answers much short and elaborate only if necessary`;

    const stream = await client.messages.stream({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{
        role: "user",
        content: `${fullContext}\n\nCustomer: ${question}`
      }]
    });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let fullAnswer = "";

    stream.on('text', (text) => {
      fullAnswer += text;
      res.write(`data: ${JSON.stringify({ chunk: text })}\n\n`);
    });

    stream.on('end', () => {
      console.log("✅ Response sent\n");
      res.write(`data: ${JSON.stringify({ done: true, answer: fullAnswer })}\n\n`);
      res.end();
    });

    stream.on('error', (err) => {
      console.error("Error:", err);
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
  indexProducts();
});
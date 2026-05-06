// ============================================================
// CalBot v2 — โค้ชสุขภาพใน Line
// แพ็กเกจ: Free | Premium (79฿/เดือน, 758฿/ปี)
// ต่อยอดจาก ปฏิทินBoy — ปรับเป็นระบบโภชนาการ + ออกกำลังกาย
// ============================================================

if (process.env.NODE_ENV !== 'production') require('dotenv').config();

const express  = require('express');
const line     = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');
const fetch    = require('node-fetch');
const ws       = require('ws');

// ── Config ──────────────────────────────────────────────────
const lineConfig = {
  channelSecret:      process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};
const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  { realtime: { transport: ws } }
);

// ── Express ──────────────────────────────────────────────────
const app = express();

// Webhook ต้องอยู่ก่อน express.json() เสมอ
app.post('/webhook', line.middleware(lineConfig), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(() => res.json({ status: 'ok' }))
    .catch(err => { console.error(err); res.status(500).end(); });
});

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/health', (_, res) => res.json({ status: 'ok', bot: 'CalBot v2' }));

// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════
const reply = (event, messages) =>
  client.replyMessage({ replyToken: event.replyToken, messages });

const getTH = () =>
  new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));

const fmtDate = d =>
  `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

const today = () => fmtDate(getTH());

async function getImg64(msgId) {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${msgId}/content`, {
    headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
  });
  return Buffer.from(await res.arrayBuffer()).toString('base64');
}

// ── Cache อาหารและท่าออกกำลังกาย (ลด API call 70%) ─────────
const nutritionCache  = new Map();
const exerciseCache   = new Map();

// ══════════════════════════════════════════════════════════════
// USER MANAGEMENT
// ══════════════════════════════════════════════════════════════
async function getOrCreateUser(userId) {
  try {
    const { data, error } = await supabase.from('users').select('*').eq('line_user_id', userId).single();
    if (data) return data;
    if (error && error.code !== 'PGRST116') {
      console.error('❌ getOrCreateUser select error:', error.message, error.code);
    }
    // ดึงชื่อจาก Line Profile
    let displayName = null;
    try {
      const p = await (await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
        headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
      })).json();
      displayName = p.displayName || null;
    } catch(e) {
      console.error('❌ getProfile error:', e.message);
    }
    // สร้าง user ใหม่
    const { data: newUser, error: insertError } = await supabase.from('users').insert({
      line_user_id: userId, display_name: displayName,
      plan: 'free', goal: 'maintain', target_calories: 1300,
    }).select().single();
    if (insertError) {
      console.error('❌ getOrCreateUser insert error:', insertError.message, insertError.code);
      return null;
    }
    console.log('✅ Created new user:', userId);
    return newUser;
  } catch(e) {
    console.error('❌ getOrCreateUser exception:', e.message);
    return null;
  }
}

async function getUserPlan(userId) {
  const { data } = await supabase
    .from('users').select('plan, plan_expires_at').eq('line_user_id', userId).single();
  if (!data) return 'free';
  if (data.plan === 'premium' && data.plan_expires_at && new Date(data.plan_expires_at) < new Date()) {
    await supabase.from('users').update({ plan: 'free', plan_expires_at: null }).eq('line_user_id', userId);
    return 'free';
  }
  return data.plan || 'free';
}

const isPremium = plan => plan === 'premium';

// ══════════════════════════════════════════════════════════════
// NUTRITION API — Claude AI ประมาณค่า (Phase 1)
// เปลี่ยนเป็น Edamam เมื่อมี Premium 30+ คน
// ══════════════════════════════════════════════════════════════
async function fetchNutrition(foodName) {
  const key = foodName.toLowerCase().trim();
  if (nutritionCache.has(key)) return nutritionCache.get(key);
  try {
    const prompt = `คุณเป็นนักโภชนาการ ประมาณข้อมูลโภชนาการของอาหารนี้: "${foodName}"
ตอบ JSON เท่านั้น ไม่มีคำอื่น:
{"calories":0,"carbs":0,"protein":0,"fatTotal":0,"fatSaturated":0,"fatUnsaturated":0,"fatOmega3":0,"fatTrans":0,"label":"ชื่ออาหารภาษาอังกฤษ"}

กฎสำคัญ:
- calories คำนวณจาก carbs×4 + protein×4 + fatTotal×9
- ประมาณต่อ 1 หน่วยมาตรฐาน (1 จาน/1 ชิ้น/100g)
- ถ้าไม่มีข้อมูลไขมันละเอียด ให้ประมาณจากประเภทอาหาร
  (เนื้อสัตว์ไขมันสูง = fatSaturated สูง, ปลาทะเล = fatOmega3 สูง)
- ตอบตัวเลขจริงทั้งหมด ไม่ใส่ 0 ทุกตัว`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 300, messages: [{ role: 'user', content: prompt }] }),
    });
    const data = await res.json();
    const text = data.content?.[0]?.text?.trim().replace(/```json|```/g,'').trim();
    const match = text?.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const n = JSON.parse(match[0]);
    const result = {
      foodId:         'claude_estimate',
      label:          n.label || foodName,
      calories:       Math.round(n.calories || 0),
      carbs:          Math.round((n.carbs || 0) * 10) / 10,
      protein:        Math.round((n.protein || 0) * 10) / 10,
      fatTotal:       Math.round((n.fatTotal || 0) * 10) / 10,
      fatSaturated:   Math.round((n.fatSaturated || 0) * 10) / 10,
      fatUnsaturated: Math.round((n.fatUnsaturated || 0) * 10) / 10,
      fatOmega3:      Math.round((n.fatOmega3 || 0) * 10) / 10,
      fatTrans:       Math.round((n.fatTrans || 0) * 10) / 10,
      isEstimate:     true,
    };
    // Cache ไว้ 1 ชั่วโมง เพื่อประหยัด API call
    nutritionCache.set(key, result);
    setTimeout(() => nutritionCache.delete(key), 3600000);
    return result;
  } catch { return null; }
}

// ══════════════════════════════════════════════════════════════
// EXERCISE API (API Ninjas + Cache)
// ══════════════════════════════════════════════════════════════
async function fetchExercise(name) {
  const key = name.toLowerCase().trim();
  if (exerciseCache.has(key)) return exerciseCache.get(key);
  try {
    const res  = await fetch(`https://api.api-ninjas.com/v1/caloriesburned?activity=${encodeURIComponent(name)}&duration=30`, {
      headers: { 'X-Api-Key': process.env.NINJA_API_KEY || '' },
    });
    const data = await res.json();
    if (!Array.isArray(data) || !data[0]) return null;
    const result = { name: data[0].name, calPer30min: Math.round(data[0].calories_per_hour / 2) };
    exerciseCache.set(key, result);
    return result;
  } catch { return null; }
}

// ── MET fallback (ถ้าไม่มี API key) ──────────────────────────
const MET_TABLE = {
  'running': 9.8, 'jogging': 7, 'walking': 3.5, 'cycling': 7.5,
  'swimming': 8, 'yoga': 2.5, 'weight training': 5, 'hiit': 10,
  'วิ่ง': 9.8, 'เดิน': 3.5, 'ปั่น': 7.5, 'ว่าย': 8,
  'โยคะ': 2.5, 'ยกน้ำหนัก': 5, 'hiit': 10, 'เต้น': 5,
  'เดินเร็ว': 5, 'บาสเกตบอล': 7, 'ฟุตบอล': 7,
};
function estCalBurned(name, mins, weightKg = 65) {
  const met = MET_TABLE[name.toLowerCase()] || MET_TABLE[Object.keys(MET_TABLE).find(k => name.toLowerCase().includes(k))] || 5;
  return Math.round(met * weightKg * (mins / 60));
}

// ══════════════════════════════════════════════════════════════
// CLAUDE AI — Parse อาหาร
// ══════════════════════════════════════════════════════════════
// ── Parse อาหารหลายอย่างพร้อมกัน ─────────────────────────────
async function parseMultipleFoods(text) {
  const prompt = `วิเคราะห์ข้อความนี้: "${text}"
ถ้ามีอาหารหลายอย่าง (คั่นด้วย + , และ หรือขึ้นบรรทัดใหม่) ให้แยกออกเป็นรายการ
ตอบ JSON array เท่านั้น:
[{"foodNameTH":"ชื่อไทย","foodName":"English name","amountDesc":"ปริมาณ","mealType":"lunch"}]
ถ้ามีอย่างเดียวให้ตอบ array ที่มี 1 element
ตัวอย่าง:
"ข้าวผัดกระเพรา + ชาไทย + ส้มตำ" -> [{"foodNameTH":"ข้าวผัดกระเพรา","foodName":"stir fried basil pork rice","amountDesc":"1 จาน","mealType":"lunch"},{"foodNameTH":"ชาไทย","foodName":"Thai iced tea","amountDesc":"1 แก้ว","mealType":"lunch"},{"foodNameTH":"ส้มตำ","foodName":"papaya salad","amountDesc":"1 ถ้วย","mealType":"lunch"}]
"ข้าวมันไก่ 1 จาน" -> [{"foodNameTH":"ข้าวมันไก่","foodName":"Thai chicken rice","amountDesc":"1 จาน","mealType":"lunch"}]`;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 500, messages: [{ role: 'user', content: prompt }] }),
    });
    const d = await res.json();
    const t = d.content?.[0]?.text?.trim().replace(/```json|```/g,'').trim();
    const m = t?.match(/\[[\s\S]*\]/);
    return m ? JSON.parse(m[0]) : null;
  } catch { return null; }
}

// ── ตรวจว่าเป็นอาหารหลายอย่างหรือไม่ ───────────────────────────
function isMultipleFoods(text) {
  return /[+&]/.test(text) || text.split(',').length > 1;
}

async function parseFoodWithClaude(text) {
  const prompt = `วิเคราะห์ข้อความภาษาไทยหรืออังกฤษนี้: "${text}"
ตอบ JSON เท่านั้น ไม่มีคำอื่น:
{"isFood":true,"foodNameTH":"ชื่ออาหารภาษาไทย","foodName":"English name for nutrition lookup","amountDesc":"ปริมาณ","mealType":"breakfast/lunch/dinner/snack/other","isWater":false,"waterMl":null}

ตัวอย่าง:
"ข้าวผัดกระเพราหมูสับ 1 จาน" -> {"isFood":true,"foodNameTH":"ข้าวผัดกระเพราหมูสับ","foodName":"stir fried basil pork rice","amountDesc":"1 จาน","mealType":"lunch","isWater":false,"waterMl":null}
"แซลมอนย่าง 150g" -> {"isFood":true,"foodNameTH":"แซลมอนย่าง","foodName":"grilled salmon","amountDesc":"150g","mealType":"other","isWater":false,"waterMl":null}
"ชาไทยหวานน้อย" -> {"isFood":true,"foodNameTH":"ชาไทยหวานน้อย","foodName":"Thai iced tea low sugar","amountDesc":"1 แก้ว","mealType":"other","isWater":false,"waterMl":null}
"น้ำเปล่า 1 แก้ว" -> {"isFood":true,"foodNameTH":"น้ำเปล่า","foodName":"water","amountDesc":"1 แก้ว","mealType":"other","isWater":true,"waterMl":250}
"ไก่ทอด 2 ชิ้น" -> {"isFood":true,"foodNameTH":"ไก่ทอด","foodName":"fried chicken","amountDesc":"2 ชิ้น","mealType":"other","isWater":false,"waterMl":null}
"salmon 200g" -> {"isFood":true,"foodNameTH":"แซลมอน","foodName":"salmon","amountDesc":"200g","mealType":"other","isWater":false,"waterMl":null}
"สวัสดี" -> {"isFood":false}`;
  return callClaude(prompt, 250);
}

// ── Parse ออกกำลังกาย ────────────────────────────────────────
async function parseExerciseWithClaude(text) {
  const prompt = `วิเคราะห์ข้อความออกกำลังกายนี้: "${text}"
ตอบ JSON เท่านั้น:
{"isExercise":true/false,"exerciseName":"ชื่อภาษาอังกฤษ","exerciseTH":"ชื่อไทย","durationMin":30,"intensity":"low/moderate/high"}
ถ้าไม่ใช่การออกกำลังกาย {"isExercise":false}`;
  return callClaude(prompt, 150);
}

// ── วิเคราะห์คุณภาพสารอาหาร ─────────────────────────────────
async function analyzeNutrition(foodName, n, goal) {
  const prompt = `อาหาร: ${foodName}
แคลอรี่: ${n.calories} kcal | โปรตีน: ${n.protein}g | คาร์บ: ${n.carbs}g | ไขมันรวม: ${n.fatTotal}g
ไขมันเลว: ${n.fatSaturated}g | ไขมันดี: ${n.fatUnsaturated}g | Omega-3: ${n.fatOmega3}g | Trans: ${n.fatTrans}g
เป้าหมาย: ${goal === 'lose' ? 'ลดน้ำหนัก' : goal === 'gain' ? 'เพิ่มกล้ามเนื้อ' : 'รักษาน้ำหนัก'}
สรุปสั้น 1-2 ประโยค เน้นไขมันดี/เลว ไม่เกิน 60 ตัวอักษร`;
  return callClaude(prompt, 120);
}

// ── วิเคราะห์รูปอาหาร ────────────────────────────────────────
async function analyzeImageFood(imageBase64) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', max_tokens: 400,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: 'ดูรูปนี้ระบุอาหารทั้งหมดที่เห็น ตอบ JSON array เท่านั้น: [{"foodNameTH":"ชื่ออาหารภาษาไทย","foodName":"English name","amountDesc":"ปริมาณ","mealType":"lunch"}] เช่น [{"foodNameTH":"ข้าวผัดกระเพรา","foodName":"stir fried basil pork rice","amountDesc":"1 จาน","mealType":"lunch"}] ถ้าไม่ใช่อาหาร: []' }
        ]}],
      }),
    });
    const d = await res.json();
    const t = d.content?.[0]?.text?.trim().replace(/```json|```/g,'').trim();
    const m = t?.match(/\[[\s\S]*\]/);
    return m ? JSON.parse(m[0]) : [];
  } catch { return []; }
}

// ── Claude helper ─────────────────────────────────────────────
async function callClaude(prompt, maxTokens = 300) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    });
    const d = await res.json();
    const t = d.content?.[0]?.text?.trim().replace(/```json|```/g,'').trim();
    const m = t?.match(/({[\s\S]*}|\[[\s\S]*\])/);
    return m ? JSON.parse(m[0]) : t;
  } catch { return null; }
}

// ══════════════════════════════════════════════════════════════
// FOOD & EXERCISE LOGIC
// ══════════════════════════════════════════════════════════════

// ระบบสีอาหาร
function getFoodColor(n) {
  if (n.fatTrans > 1)                            return { emoji:'🔴', label:'กลุ่มกินอย่างมีสติ',   bg:'#7f1d1d', accent:'#fca5a5' };
  if (n.fatSaturated > 10)                       return { emoji:'🔴', label:'กลุ่มกินอย่างมีสติ',   bg:'#7f1d1d', accent:'#fca5a5' };
  if (n.fatOmega3 > 1 && n.calories < 400)       return { emoji:'🟢', label:'กลุ่มกินได้เต็มที่',   bg:'#064e3b', accent:'#6ee7b7' };
  if (n.calories < 200 && n.protein > 10)        return { emoji:'🟢', label:'กลุ่มกินได้เต็มที่',   bg:'#064e3b', accent:'#6ee7b7' };
  if (n.calories > 500 || n.fatSaturated > 6)    return { emoji:'🟡', label:'กลุ่มกินพอดี',         bg:'#713f12', accent:'#fcd34d' };
  return                                                { emoji:'🟢', label:'กลุ่มกินได้เต็มที่',   bg:'#064e3b', accent:'#6ee7b7' };
}

// บันทึกอาหาร
async function saveFoodLog(userId, parsed, nutrition) {
  await supabase.from('food_logs').insert({
    user_id: userId, log_date: today(),
    meal_type: parsed.mealType || 'other',
    food_name: parsed.foodName, amount_desc: parsed.amountDesc,
    calories: nutrition.calories, carbs_g: nutrition.carbs,
    protein_g: nutrition.protein, fat_total_g: nutrition.fatTotal,
    fat_saturated_g: nutrition.fatSaturated, fat_unsaturated_g: nutrition.fatUnsaturated,
    fat_omega3_g: nutrition.fatOmega3, fat_trans_g: nutrition.fatTrans,
    is_estimate: false,
  });
}

// บันทึกน้ำ
async function saveWater(userId, ml = 250) {
  await supabase.from('food_logs').insert({
    user_id: userId, log_date: today(),
    meal_type: 'other', food_name: 'น้ำเปล่า',
    is_water: true, water_ml: ml,
    calories: 0, carbs_g: 0, protein_g: 0, fat_total_g: 0,
  });
}

// บันทึกออกกำลังกาย
async function saveExercise(userId, name, nameTH, mins, cal, intensity) {
  await supabase.from('exercise_logs').insert({
    user_id: userId, log_date: today(),
    exercise_name: nameTH || name,
    duration_min: mins, calories_burned: cal, intensity,
  });
}

// ดึงสรุปวันนี้
async function getDailySummary(userId) {
  const d = today();
  const { data: foods } = await supabase.from('food_logs').select('*').eq('user_id', userId).eq('log_date', d);
  const { data: exs }   = await supabase.from('exercise_logs').select('*').eq('user_id', userId).eq('log_date', d);
  if (!foods && !exs) return null;
  const meals = (foods || []).filter(f => !f.is_water);
  return {
    calories:     meals.reduce((s, r) => s + (r.calories || 0), 0),
    protein:      meals.reduce((s, r) => s + (r.protein_g || 0), 0),
    carbs:        meals.reduce((s, r) => s + (r.carbs_g || 0), 0),
    fat:          meals.reduce((s, r) => s + (r.fat_total_g || 0), 0),
    fatSat:       meals.reduce((s, r) => s + (r.fat_saturated_g || 0), 0),
    omega3:       meals.reduce((s, r) => s + (r.fat_omega3_g || 0), 0),
    waterMl:      (foods || []).filter(f => f.is_water).reduce((s, r) => s + (r.water_ml || 0), 0),
    mealCount:    meals.length,
    exerciseCal:  (exs || []).reduce((s, r) => s + (r.calories_burned || 0), 0),
    exercises:    exs || [],
    meals,
  };
}

// ── Streak ────────────────────────────────────────────────────
async function updateStreak(userId) {
  const d = today();
  const { data: u } = await supabase.from('users').select('streak_count, streak_last_date').eq('line_user_id', userId).single();
  if (!u) return 0;
  const yesterday = fmtDate(new Date(getTH().getTime() - 86400000));
  if (u.streak_last_date === d) return u.streak_count;
  const streak = u.streak_last_date === yesterday ? (u.streak_count || 0) + 1 : 1;
  await supabase.from('users').update({ streak_count: streak, streak_last_date: d }).eq('line_user_id', userId);
  return streak;
}

// ── IF Tracker ────────────────────────────────────────────────
async function startIF(userId, hours = 16) {
  await supabase.from('users').update({ if_mode: true, if_hours: hours, if_start_time: getTH().toISOString() }).eq('line_user_id', userId);
}
async function stopIF(userId) {
  await supabase.from('users').update({ if_mode: false, if_start_time: null }).eq('line_user_id', userId);
}
async function getIFStatus(userId) {
  const { data } = await supabase.from('users').select('if_mode, if_hours, if_start_time').eq('line_user_id', userId).single();
  if (!data?.if_mode || !data.if_start_time) return null;
  const elapsed   = (getTH() - new Date(data.if_start_time)) / 3600000;
  const target    = data.if_hours || 16;
  const remaining = Math.max(0, target - elapsed);
  const endTime   = new Date(new Date(data.if_start_time).getTime() + target * 3600000);
  return { elapsed, remaining, target, endTime, done: elapsed >= target };
}

// ══════════════════════════════════════════════════════════════
// PUSH SYSTEM
// ══════════════════════════════════════════════════════════════

// ตรวจ IF ครบเวลา (ทุก 1 นาที)
async function checkIF() {
  try {
    const { data: users } = await supabase.from('users').select('*').eq('if_mode', true).not('if_start_time', 'is', null);
    for (const u of (users || [])) {
      const elapsed = (getTH() - new Date(u.if_start_time)) / 3600000;
      const target  = u.if_hours || 16;
      if (elapsed >= target && elapsed < target + (1/60)) {
        try {
          await client.pushMessage({ to: u.line_user_id, messages: [flexIFDone(target)] });
          await supabase.from('users').update({ if_mode: false, if_start_time: null }).eq('line_user_id', u.line_user_id);
          console.log(`⏱️ IF done: ${u.line_user_id}`);
        } catch(e) { console.error('IF push:', e.message); }
      }
    }
  } catch(e) { console.error('checkIF:', e); }
}

// Push สรุปรายสัปดาห์ทุกวันอาทิตย์ (Premium)
async function checkWeeklySummary() {
  try {
    const now = getTH();
    if (now.getDay() !== 0) return;
    const timeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const todayStr = today();
    const { data: users } = await supabase.from('users').select('*').eq('plan', 'premium');
    for (const u of (users || [])) {
      if (u.plan_expires_at && new Date(u.plan_expires_at) < now) continue;
      if (u.weekly_summary_sent === todayStr) continue;
      if (timeStr !== (u.weekly_summary_time || '08:00')) continue;
      const weekAgo = fmtDate(new Date(now.getTime() - 7 * 86400000));
      const { data: logs } = await supabase.from('food_logs').select('log_date, calories').eq('user_id', u.line_user_id).gte('log_date', weekAgo).lte('log_date', todayStr).eq('is_water', false);
      if (!logs?.length) continue;
      const uniqueDays = [...new Set(logs.map(l => l.log_date))].length;
      const avgCal    = Math.round(logs.reduce((s, l) => s + (l.calories || 0), 0) / uniqueDays);
      try {
        await client.pushMessage({ to: u.line_user_id, messages: [flexWeeklySummary(avgCal, uniqueDays, u.streak_count || 0)] });
        await supabase.from('users').update({ weekly_summary_sent: todayStr }).eq('line_user_id', u.line_user_id);
        console.log(`📊 Weekly: ${u.line_user_id}`);
      } catch(e) { console.error('Weekly push:', e.message); }
    }
  } catch(e) { console.error('checkWeekly:', e); }
}

setInterval(checkIF,            60_000);
setInterval(checkWeeklySummary, 60_000);

// ══════════════════════════════════════════════════════════════
// USER STATE
// ══════════════════════════════════════════════════════════════
const userState = {};

// ══════════════════════════════════════════════════════════════
// MAIN EVENT HANDLER
// ══════════════════════════════════════════════════════════════
async function handleEvent(event) {
  const userId = event.source.userId;

  if (event.type === 'follow') {
    await getOrCreateUser(userId);
    return reply(event, [flexWelcome()]);
  }
  if (event.type !== 'message') return;

  // ── รูปภาพ ──────────────────────────────────────────────────
  if (event.message.type === 'image') {
    // ตรวจสลิปชำระเงิน
    if (userState[userId]?.step === 'waitingSlip') {
      const state = userState[userId];
      delete userState[userId];
      try {
        const img64  = await getImg64(event.message.id);
        const result = await callClaude(
          `ดูรูปนี้ — เป็นสลิปโอนเงินไหม? ถ้าใช่ตอบ VALID ถ้าไม่ใช่ตอบ INVALID ราคาที่ต้องจ่าย ฿${state.price}`,
          150
        );
        const valid = typeof result === 'string' && result.includes('VALID') && !result.includes('INVALID');
        if (valid) {
          const months    = state.period === '1y' ? 12 : 1;
          const expiresAt = new Date(Date.now() + months * 30 * 24 * 3600000).toISOString();
          await supabase.from('users').update({ plan: 'premium', plan_expires_at: expiresAt }).eq('line_user_id', userId);
          return reply(event, [flexText(`🎉 อัปเกรดสำเร็จแล้วครับ!\n\n✅ Premium Plan — ${state.period === '1y' ? '1 ปี' : '1 เดือน'}\n💰 ฿${state.price.toLocaleString()}\n\nขอบคุณที่สนับสนุนนะครับ 🙏`, [
            { type: 'action', action: { type: 'message', label: '📊 สรุปวันนี้', text: 'สรุปวันนี้' } },
          ])]);
        } else {
          return reply(event, [flexText('❌ ไม่พบสลิปในรูปครับ\n\nกรุณาส่งสลิปจริงมานะครับ', [
            { type: 'action', action: { type: 'message', label: '💳 ลองใหม่', text: 'แพลน' } },
          ])]);
        }
      } catch {
        return reply(event, [flexText('⚠️ ตรวจสลิปไม่ได้ตอนนี้ครับ ทีมงานจะอัปเกรดให้ภายใน 30 นาทีนะครับ 🙏')]);
      }
    }

    // วิเคราะห์รูปอาหาร
    try {
      const img64 = await getImg64(event.message.id);
      const foods = await analyzeImageFood(img64);
      if (!foods.length) return reply(event, [flexText('🤔 ไม่เจออาหารในรูปครับ ลองถ่ายใหม่ให้ชัดขึ้นนะครับ')]);
      const user = await getOrCreateUser(userId);
      const f    = foods[0];
      const n    = await fetchNutrition(f.foodName);
      if (!n) return reply(event, [flexText(`🔍 เห็น "${f.foodName}" แต่ไม่พบข้อมูลครับ\nลองพิมพ์ชื่ออาหารแทนนะครับ`)]);
      await saveFoodLog(userId, { ...f, mealType: 'other' }, n);
      const tip    = await analyzeNutrition(f.foodName, n, user?.goal || 'maintain');
      const streak = await updateStreak(userId);
      const color  = getFoodColor(n);
      const displayName = f.foodNameTH || f.foodName;
      return reply(event, [{ ...flexCalorieResult(displayName, f.amountDesc || '1 serving', n, color, tip, streak, true),
        quickReply: { items: [
          { type: 'action', action: { type: 'message', label: '↩️ ยกเลิก', text: 'ยกเลิก' } },
          { type: 'action', action: { type: 'message', label: '📊 สรุปวัน', text: 'สรุปวันนี้' } },
        ]},
      }]);
    } catch {
      return reply(event, [flexText('❌ อ่านรูปไม่ได้ครับ ลองส่งใหม่นะครับ')]);
    }
  }

  if (event.message.type !== 'text') return;
  const msg = event.message.text.trim();

  // ── State Machine ────────────────────────────────────────────
  if (userState[userId]) {
    const st = userState[userId];

    if (st.step === 'onboarding_goal') {
      const map = { 'ลดน้ำหนัก': 'lose', 'เพิ่มกล้ามเนื้อ': 'gain', 'รักษาน้ำหนัก': 'maintain' };
      const goal = map[msg];
      if (goal) {
        await supabase.from('users').update({ goal }).eq('line_user_id', userId);
        const cal = { lose: 1200, gain: 2000, maintain: 1500 }[goal];
        userState[userId] = { step: 'onboarding_cal' };
        return reply(event, [flexText(`✅ เป้าหมาย: ${msg}\n\nแนะนำแคลอรี่ต่อวัน ${cal} kcal\nหรือพิมพ์ตัวเลขที่ต้องการเองได้เลยครับ`, [
          { type: 'action', action: { type: 'message', label: `${cal} kcal (แนะนำ)`, text: `${cal}` } },
          { type: 'action', action: { type: 'message', label: '1,300 kcal', text: '1300' } },
          { type: 'action', action: { type: 'message', label: '1,800 kcal', text: '1800' } },
        ])]);
      }
      return reply(event, [flexText('❓ เลือกเป้าหมายด้านล่างได้เลยครับ')]);
    }

    if (st.step === 'onboarding_cal') {
      const cal = parseInt(msg.replace(/[^0-9]/g, ''));
      if (cal >= 800 && cal <= 4000) {
        await supabase.from('users').update({ target_calories: cal, onboarding_done: true }).eq('line_user_id', userId);
        delete userState[userId];
        return reply(event, [flexText(`🎉 ตั้งค่าเสร็จแล้วครับ!\n\n🎯 เป้าหมาย: ${cal} kcal/วัน\n\nพิมพ์ชื่ออาหารที่กิน หรือถ่ายรูปอาหารได้เลยครับ!`, [
          { type: 'action', action: { type: 'message', label: '🍽️ บันทึกอาหาร', text: 'เมนู' } },
        ])]);
      }
      return reply(event, [flexText('❓ พิมพ์ตัวเลขแคลอรี่ เช่น 1300 ครับ')]);
    }

    if (st.step === 'waitingSlip') {
      return reply(event, [flexText('📸 ส่งรูปสลิปการโอนเงินมาได้เลยครับ')]);
    }
  }

  // ── Commands ─────────────────────────────────────────────────
  if (['สวัสดี','หวัดดี','hi','hello','เริ่ม'].includes(msg.toLowerCase()))
    return reply(event, [flexWelcome()]);

  if (msg === 'เมนู') {
    const plan = await getUserPlan(userId);
    return reply(event, [await flexMenu(userId, plan)]);
  }

  if (msg === 'สรุปวันนี้' || msg === 'สรุป') {
    const user  = await getOrCreateUser(userId);
    const daily = await getDailySummary(userId);
    return reply(event, [flexDailySummary(daily, user?.target_calories || 1300)]);
  }

  if (msg === 'ตั้งเป้าหมาย' || msg === 'เป้าหมาย') {
    userState[userId] = { step: 'onboarding_goal' };
    return reply(event, [flexText('🎯 เลือกเป้าหมายหลักได้เลยครับ', [
      { type: 'action', action: { type: 'message', label: '🔽 ลดน้ำหนัก', text: 'ลดน้ำหนัก' } },
      { type: 'action', action: { type: 'message', label: '💪 เพิ่มกล้ามเนื้อ', text: 'เพิ่มกล้ามเนื้อ' } },
      { type: 'action', action: { type: 'message', label: '⚖️ รักษาน้ำหนัก', text: 'รักษาน้ำหนัก' } },
    ])]);
  }

  // ตั้งเป้าหมายน้ำ
  if (msg.includes('ตั้งเป้าน้ำ') || msg.includes('เป้าหมายน้ำ') || msg.match(/^น้ำ.*(\d+)/)) {
    const numMatch = msg.match(/(\d+)/);
    if (numMatch) {
      const target = parseInt(numMatch[1]);
      if (target >= 500 && target <= 5000) {
        await supabase.from('users').update({ water_target: target }).eq('line_user_id', userId);
        return reply(event, [flexText(`💧 ตั้งเป้าหมายน้ำใหม่แล้วครับ!

🎯 เป้าหมาย: ${target.toLocaleString()} ml/วัน

พิมพ์ "น้ำ" เพื่อบันทึกการดื่มน้ำได้เลยครับ`, [
          { type: 'action', action: { type: 'message', label: '💧 บันทึกน้ำ', text: 'น้ำ' } },
          { type: 'action', action: { type: 'message', label: '📊 สรุปวันนี้', text: 'สรุปวันนี้' } },
        ])]);
      } else {
        return reply(event, [flexText('❓ ใส่เป้าหมายน้ำระหว่าง 500-5000 ml ครับ เช่น เป้าหมายน้ำ 2500')]);
      }
    }
  }

  // น้ำ
  if (msg === 'น้ำ' || msg === 'ดื่มน้ำ' || msg.match(/^น้ำ.*(แก้ว|ขวด)/)) {
    await saveWater(userId, 250);
    const { data: logs } = await supabase.from('food_logs').select('water_ml').eq('user_id', userId).eq('log_date', today()).eq('is_water', true);
    const total = (logs || []).reduce((s, r) => s + (r.water_ml || 0), 0);
    const dots  = '🔵'.repeat(Math.min(8, Math.floor(total/250))) + '⚪'.repeat(Math.max(0, 8 - Math.floor(total/250)));
    return reply(event, [flexText(`💧 บันทึกน้ำแล้วครับ!\n\nวันนี้รวม ${total} ml / เป้า 2,000 ml\n${dots}`, [
      { type: 'action', action: { type: 'message', label: '💧 เพิ่มอีกแก้ว', text: 'น้ำ' } },
      { type: 'action', action: { type: 'message', label: '📊 สรุปวันนี้', text: 'สรุปวันนี้' } },
    ])]);
  }

  // IF Mode
  if (msg === 'IF' || msg.toLowerCase().includes('if mode') || msg.includes('อดอาหาร')) {
    const plan = await getUserPlan(userId);
    if (!isPremium(plan)) return reply(event, [flexText('🔒 IF Tracker สำหรับ Premium เท่านั้นครับ\n\nพิมพ์ "แพลน" เพื่ออัปเกรดนะครับ', [
      { type: 'action', action: { type: 'message', label: '💳 ดูแพลน', text: 'แพลน' } },
    ])]);
    const status = await getIFStatus(userId);
    if (status) return reply(event, [flexIFTracker(status)]);
    return reply(event, [flexText('⏱️ เริ่ม IF กี่ชั่วโมงดีคะ?', [
      { type: 'action', action: { type: 'message', label: '16/8 (แนะนำ)', text: 'เริ่ม IF 16' } },
      { type: 'action', action: { type: 'message', label: '18/6', text: 'เริ่ม IF 18' } },
      { type: 'action', action: { type: 'message', label: '20/4', text: 'เริ่ม IF 20' } },
    ])]);
  }

  if (msg.startsWith('เริ่ม IF')) {
    const plan = await getUserPlan(userId);
    if (!isPremium(plan)) return reply(event, [flexText('🔒 IF Tracker สำหรับ Premium ครับ', [
      { type: 'action', action: { type: 'message', label: '💳 อัปเกรด', text: 'แพลน' } },
    ])]);
    const h = parseInt(msg.replace('เริ่ม IF','').trim()) || 16;
    await startIF(userId, h);
    const status = await getIFStatus(userId);
    return reply(event, [flexIFTracker(status)]);
  }

  if (msg === 'หยุด IF' || msg === 'stop IF') {
    await stopIF(userId);
    return reply(event, [flexText('✅ หยุด IF Mode แล้วครับ 👍\n\nพิมพ์อาหารมื้อแรกได้เลยครับ', [
      { type: 'action', action: { type: 'message', label: '📊 สรุปวันนี้', text: 'สรุปวันนี้' } },
    ])]);
  }

  // แพลน / ชำระเงิน
  if (msg === 'แพลน' || msg === 'plan') {
    const user = await getOrCreateUser(userId);
    return reply(event, [flexPlan(user?.plan || 'free', user?.plan_expires_at)]);
  }

  if (msg.startsWith('เลือกแพลน:')) {
    return reply(event, [flexChoosePeriod()]);
  }

  if (msg.startsWith('ชำระ:')) {
    const parts  = msg.split(':');
    const period = parts[1]; // 1m | 1y
    const price  = period === '1y' ? 758 : 79;
    userState[userId] = { step: 'waitingSlip', period, price };
    return reply(event, [flexPayment(period, price)]);
  }

  // ── ออกกำลังกาย ──────────────────────────────────────────────
  const exerciseKeywords = ['วิ่ง','เดิน','ปั่น','ว่าย','ยก','โยคะ','hiit','เต้น','ออกกำลัง','running','cycling','swimming','yoga','walking'];
  const hasExercise = exerciseKeywords.some(k => msg.toLowerCase().includes(k));

  if (hasExercise) {
    const parsed = await parseExerciseWithClaude(msg);
    if (parsed?.isExercise) {
      const user     = await getOrCreateUser(userId);
      const weightKg = user?.weight_kg || 65;
      const mins     = parsed.durationMin || 30;
      // ลอง Exercise API ก่อน ถ้าไม่มี key ใช้ MET
      let burn = 0;
      const apiResult = process.env.NINJA_API_KEY ? await fetchExercise(parsed.exerciseName) : null;
      if (apiResult) {
        burn = Math.round(apiResult.calPer30min * (mins / 30));
      } else {
        burn = estCalBurned(parsed.exerciseName || msg, mins, weightKg);
      }
      await saveExercise(userId, parsed.exerciseName, parsed.exerciseTH, mins, burn, parsed.intensity || 'moderate');
      const daily = await getDailySummary(userId);
      return reply(event, [flexExerciseResult(parsed.exerciseTH || parsed.exerciseName, mins, burn, daily, user?.target_calories || 1300)]);
    }
  }

  // ── ยกเลิกรายการล่าสุด ──────────────────────────────────────
  if (['ยกเลิก','ลบ','ลบล่าสุด','ยกเลิกล่าสุด','undo'].includes(msg.toLowerCase())) {
    const { data: last } = await supabase
      .from('food_logs')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    if (!last) return reply(event, [flexText('ไม่มีรายการที่จะยกเลิกครับ')]);
    await supabase.from('food_logs').delete().eq('id', last.id);
    return reply(event, [flexText(`✅ ยกเลิก "${last.food_name}" แล้วครับ
${last.calories} kcal ถูกหักออกแล้วนะครับ`, [
      { type: 'action', action: { type: 'message', label: '📊 สรุปวันนี้', text: 'สรุปวันนี้' } },
    ])]);
  }

  // ── อาหารหลายอย่างพร้อมกัน ──────────────────────────────────
  if (isMultipleFoods(msg)) {
    const foods = await parseMultipleFoods(msg);
    if (foods && foods.length > 1) {
      const user = await getOrCreateUser(userId);
      let totalCal = 0;
      const results = [];
      for (const f of foods) {
        const n = await fetchNutrition(f.foodName);
        if (n) {
          if (!f.foodNameTH) f.foodNameTH = f.foodName;
          try {
            await saveFoodLog(userId, { ...f, foodName: f.foodNameTH }, n);
            totalCal += n.calories;
            results.push(`${f.foodNameTH} — ${n.calories} kcal`);
          } catch(e) { console.error('saveFoodLog multi error:', e.message); }
        } else {
          results.push(`${f.foodNameTH} — ไม่พบข้อมูล`);
        }
      }
      await updateStreak(userId);
      const daily = await getDailySummary(userId);
      const remain = Math.max(0, (user?.target_calories || 1300) - (daily?.calories || 0));
      return reply(event, [flexMultiFoodResult(results, foods, totalCal, remain)]);
    }
  }

  // ── อาหาร ────────────────────────────────────────────────────
  const parsed = await parseFoodWithClaude(msg);
  if (!parsed || !parsed.isFood) {
    return reply(event, [flexText('💬 ไม่เข้าใจครับ\n\nพิมพ์ชื่ออาหาร เช่น "ข้าวผัดกระเพรา 1 จาน"\nหรือถ่ายรูปอาหารมาได้เลยครับ', [
      { type: 'action', action: { type: 'message', label: '📊 สรุปวันนี้', text: 'สรุปวันนี้' } },
      { type: 'action', action: { type: 'message', label: '📋 เมนู', text: 'เมนู' } },
    ])]);
  }

  if (parsed.isWater) {
    const ml = parsed.waterMl || 250;
    await saveWater(userId, ml);
    return reply(event, [flexText(`💧 บันทึกน้ำ ${ml} ml แล้วครับ!`, [
      { type: 'action', action: { type: 'message', label: '📊 สรุปวันนี้', text: 'สรุปวันนี้' } },
    ])]);
  }

  const n = await fetchNutrition(parsed.foodName);
  if (!n) {
    return reply(event, [flexText(`❓ วิเคราะห์ "${parsed.foodName}" ไม่ได้ครับ\n\nลองพิมพ์ใหม่หรือระบุให้ชัดขึ้นนะครับ`, [
      { type: 'action', action: { type: 'message', label: '📋 เมนู', text: 'เมนู' } },
    ])]);
  }

  const user   = await getOrCreateUser(userId);
  console.log('👤 user:', user ? user.line_user_id : 'NULL - getOrCreateUser failed');
  if (!parsed.foodNameTH) parsed.foodNameTH = parsed.foodName;
  try {
    await saveFoodLog(userId, { ...parsed, foodName: parsed.foodNameTH }, n);
    console.log('✅ saveFoodLog ok:', parsed.foodNameTH);
  } catch(saveErr) {
    console.error('❌ saveFoodLog error:', saveErr.message);
  }
  const tip    = await analyzeNutrition(parsed.foodNameTH || parsed.foodName, n, user?.goal || 'maintain');
  const color  = getFoodColor(n);
  const streak = await updateStreak(userId);

  return reply(event, [{ ...flexCalorieResult(parsed.foodNameTH || parsed.foodName, parsed.amountDesc, n, color, tip, streak, false),
    quickReply: { items: [
      { type: 'action', action: { type: 'message', label: '↩️ ยกเลิก', text: 'ยกเลิก' } },
      { type: 'action', action: { type: 'message', label: '📊 สรุปวัน', text: 'สรุปวันนี้' } },
      { type: 'action', action: { type: 'message', label: '➕ เพิ่มอีก', text: 'เพิ่มอาหาร' } },
    ]},
  }]);
}

// ══════════════════════════════════════════════════════════════
// FLEX MESSAGE COMPONENTS
// ══════════════════════════════════════════════════════════════

// ── Multi Food Result Card ───────────────────────────────────
function flexMultiFoodResult(results, foods, totalCal, remain) {
  const pct = Math.min(100, Math.round((totalCal / 1300) * 100));

  const rows = results.map((r, i) => {
    const parts = r.split(' — ');
    const name  = parts[0] || r;
    const cal   = parts[1] || '';
    return {
      type: 'box', layout: 'horizontal', margin: 'sm',
      paddingAll: '8px',
      backgroundColor: i % 2 === 0 ? '#f8fafc' : '#ffffff',
      cornerRadius: '6px',
      contents: [
        { type: 'text', text: `${i+1}.`, size: 'xs', color: '#94a3b8', flex: 0, weight: 'bold' },
        { type: 'text', text: name, size: 'sm', color: '#1a1a1a', flex: 3, margin: 'sm', wrap: true },
        { type: 'text', text: cal, size: 'sm', color: '#1D9E75', flex: 1, align: 'end', weight: 'bold' },
      ],
    };
  });

  return {
    type: 'flex',
    altText: `✅ บันทึก ${results.length} รายการ รวม ${totalCal} kcal`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#0f172a', paddingAll: '16px',
        contents: [
          { type: 'text', text: '✅ บันทึกสำเร็จแล้วครับ!', size: 'xs', color: '#1D9E75', weight: 'bold' },
          { type: 'text', text: `${results.length} รายการ`, size: 'xxl', weight: 'bold', color: '#ffffff', margin: 'xs' },
          { type: 'text', text: `รวม ${totalCal.toLocaleString()} kcal`, size: 'sm', color: '#94a3b8', margin: 'xs' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '14px', spacing: 'none',
        contents: [
          ...rows,
          { type: 'separator', margin: 'md' },
          {
            type: 'box', layout: 'horizontal', margin: 'md',
            contents: [
              { type: 'box', layout: 'vertical', flex: 1, contents: [
                { type: 'text', text: `${totalCal.toLocaleString()}`, size: 'xl', weight: 'bold', color: '#EF9F27' },
                { type: 'text', text: 'รวม (kcal)', size: 'xs', color: '#888888' },
              ]},
              { type: 'box', layout: 'vertical', flex: 1, contents: [
                { type: 'text', text: `${remain.toLocaleString()}`, size: 'xl', weight: 'bold', color: '#1D9E75', align: 'end' },
                { type: 'text', text: 'เหลืออีก', size: 'xs', color: '#888888', align: 'end' },
              ]},
            ],
          },
          {
            type: 'box', layout: 'vertical', backgroundColor: '#f0f0f0',
            cornerRadius: '4px', height: '6px', margin: 'sm',
            contents: [{
              type: 'box', layout: 'vertical', backgroundColor: '#1D9E75',
              cornerRadius: '4px', width: `${pct}%`, height: '6px', contents: [],
            }],
          },
          { type: 'text', text: `${pct}% ของเป้าหมายวันนี้`, size: 'xs', color: '#888888', margin: 'xs' },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'sm',
        contents: [
          { type: 'button', style: 'primary', color: '#1D9E75', height: 'sm',
            action: { type: 'message', label: '📊 ดูสรุปวันนี้', text: 'สรุปวันนี้' } },
          { type: 'button', style: 'secondary', height: 'sm',
            action: { type: 'message', label: '↩️ ยกเลิกรายการล่าสุด', text: 'ยกเลิก' } },
        ],
      },
    },
  };
}

function flexText(text, quickReplyItems = null) {
  const lines = text.split('\n'); const title = lines[0]; const body = lines.slice(1).join('\n').trim();
  let color = '#1D9E75';
  if (title.startsWith('❌')) color = '#ef4444';
  else if (title.startsWith('⚠️')) color = '#f59e0b';
  else if (title.startsWith('🔒')) color = '#8b5cf6';
  else if (title.startsWith('💬') || title.startsWith('❓')) color = '#378ADD';
  const msg = {
    type: 'flex', altText: title.replace(/[✅❌⚠️🔒💬❓🎉💧⏱️🎯📊💪🏃🔍📸]/g,'').trim() || text.slice(0,40),
    contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'sm',
      contents: [
        { type: 'text', text: title, size: 'md', weight: 'bold', color, wrap: true },
        ...(body ? [{ type: 'text', text: body, size: 'sm', color: '#475569', wrap: true, margin: 'sm' }] : []),
      ],
    }},
  };
  if (quickReplyItems) return { ...msg, quickReply: { items: quickReplyItems } };
  return msg;
}

// ── Welcome ──────────────────────────────────────────────────
function flexWelcome() {
  return { type: 'flex', altText: 'สวัสดีครับ! CalBot โค้ชสุขภาพ',
    contents: { type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#0f172a', paddingAll: '20px', contents: [
        { type: 'text', text: '🥗 CalBot', size: 'xs', color: '#94a3b8' },
        { type: 'text', text: 'สวัสดีครับ!', size: 'xxl', weight: 'bold', color: '#ffffff', margin: 'xs' },
        { type: 'text', text: 'โค้ชสุขภาพส่วนตัวใน Line', size: 'sm', color: '#1D9E75', margin: 'xs' },
        { type: 'box', layout: 'horizontal', margin: 'md', spacing: 'sm', contents: [
          { type: 'box', layout: 'vertical', backgroundColor: '#1D9E75', cornerRadius: '20px', paddingAll: '6px', paddingStart: '10px', paddingEnd: '10px', contents: [{ type: 'text', text: 'ฟรีตลอด', size: 'xs', color: '#ffffff', weight: 'bold' }] },
          { type: 'box', layout: 'vertical', backgroundColor: '#0F6E56', cornerRadius: '20px', paddingAll: '6px', paddingStart: '10px', paddingEnd: '10px', contents: [{ type: 'text', text: 'AI โค้ช', size: 'xs', color: '#ffffff', weight: 'bold' }] },
        ]},
      ]},
      body: { type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'sm', contents: [
        { type: 'text', text: 'พิมพ์หรือถ่ายรูปอาหารได้เลยครับ', size: 'sm', weight: 'bold', color: '#111111' },
        { type: 'box', layout: 'vertical', backgroundColor: '#f9fafb', cornerRadius: '10px', paddingAll: '12px', margin: 'sm', contents: [
          { type: 'text', text: '"ข้าวผัดกระเพรา 1 จาน"', size: 'sm', color: '#6b7280' },
          { type: 'text', text: '"แซลมอนย่าง 150g"', size: 'sm', color: '#6b7280', margin: 'xs' },
          { type: 'text', text: '"วิ่ง 30 นาที"', size: 'sm', color: '#6b7280', margin: 'xs' },
          { type: 'text', text: '📷 หรือถ่ายรูปอาหารส่งมาได้เลยครับ', size: 'sm', color: '#1D9E75', margin: 'xs' },
        ]},
      ]},
      footer: { type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'sm', contents: [
        { type: 'button', style: 'primary', color: '#1D9E75', height: 'sm', action: { type: 'message', label: '🎯 ตั้งเป้าหมายก่อนเลย', text: 'ตั้งเป้าหมาย' } },
        { type: 'button', style: 'secondary', height: 'sm', action: { type: 'message', label: '📋 เมนูทั้งหมด', text: 'เมนู' } },
      ]},
    },
  };
}

// ── Calorie Result ────────────────────────────────────────────
function flexCalorieResult(name, amount, n, color, tip, streak, isImage) {
  const fatItems = [];
  if (n.fatOmega3 > 0.5)     fatItems.push({ label: '🟢 Omega-3 (ดีมาก)', val: `${n.fatOmega3}g`, color: '#1D9E75' });
  if (n.fatUnsaturated > 0.5) fatItems.push({ label: '🔵 ไขมันดี',         val: `${n.fatUnsaturated}g`, color: '#378ADD' });
  if (n.fatSaturated > 0.5)   fatItems.push({ label: '🔴 ไขมันเลว',        val: `${n.fatSaturated}g`, color: '#E24B4A' });
  if (n.fatTrans > 0.2)       fatItems.push({ label: '🟠 Trans fat',        val: `${n.fatTrans}g`, color: '#F97316' });

  const streakMsg = streak > 0 && streak % 7 === 0
    ? [{ type: 'box', layout: 'vertical', backgroundColor: '#EEEDFE', cornerRadius: '6px', paddingAll: '8px', margin: 'sm',
        contents: [{ type: 'text', text: `🏆 Streak ${streak} วันติดต่อกัน! ยอดเยี่ยมมากครับ!`, size: 'xs', color: '#3C3489', wrap: true }] }]
    : [];

  return { type: 'flex', altText: `${color.emoji} ${name} — ${n.calories} kcal`,
    contents: { type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: color.bg, paddingAll: '14px', contents: [
        { type: 'text', text: `${color.emoji} ${color.label}${isImage ? ' (จากรูป)' : ''}`, size: 'xs', color: color.accent, weight: 'bold' },
        { type: 'text', text: name, size: 'md', weight: 'bold', color: '#ffffff', margin: 'xs', wrap: true },
        ...(amount ? [{ type: 'text', text: `${amount}${n.isEstimate ? ' · ค่าโดยประมาณ*' : ''}`, size: 'xs', color: '#94a3b8' }] : []),
      ]},
      body: { type: 'box', layout: 'vertical', paddingAll: '14px', spacing: 'xs', contents: [
        { type: 'box', layout: 'horizontal', contents: [
          { type: 'text', text: String(n.calories), size: 'xxl', weight: 'bold', color: '#111111', flex: 0 },
          { type: 'text', text: ' kcal', size: 'sm', color: '#888888', flex: 0 },
        ]},
        // ── Nutrient Bars ──
        { type: 'box', layout: 'horizontal', margin: 'sm', contents: [
          { type: 'text', text: 'คาร์บ', size: 'xs', color: '#378ADD', flex: 2 },
          { type: 'box', layout: 'vertical', flex: 6, justifyContent: 'center', contents: [
            { type: 'box', layout: 'vertical', backgroundColor: '#e8f4fd', cornerRadius: '3px', height: '8px', contents: [
              { type: 'box', layout: 'vertical', backgroundColor: '#378ADD', cornerRadius: '3px', width: `${Math.min(100, Math.round(n.carbs/3))}%`, height: '8px', contents: [] },
            ]},
          ]},
          { type: 'text', text: `${n.carbs}g`, size: 'xs', color: '#378ADD', flex: 2, align: 'end', weight: 'bold' },
        ]},
        { type: 'box', layout: 'horizontal', margin: 'xs', contents: [
          { type: 'text', text: 'โปรตีน', size: 'xs', color: '#1D9E75', flex: 2 },
          { type: 'box', layout: 'vertical', flex: 6, justifyContent: 'center', contents: [
            { type: 'box', layout: 'vertical', backgroundColor: '#e6f7f0', cornerRadius: '3px', height: '8px', contents: [
              { type: 'box', layout: 'vertical', backgroundColor: '#1D9E75', cornerRadius: '3px', width: `${Math.min(100, Math.round(n.protein/0.6))}%`, height: '8px', contents: [] },
            ]},
          ]},
          { type: 'text', text: `${n.protein}g`, size: 'xs', color: '#1D9E75', flex: 2, align: 'end', weight: 'bold' },
        ]},
        { type: 'box', layout: 'horizontal', margin: 'xs', contents: [
          { type: 'text', text: 'ไขมัน', size: 'xs', color: '#EF9F27', flex: 2 },
          { type: 'box', layout: 'vertical', flex: 6, justifyContent: 'center', contents: [
            { type: 'box', layout: 'vertical', backgroundColor: '#fef3e2', cornerRadius: '3px', height: '8px', contents: [
              { type: 'box', layout: 'vertical', backgroundColor: '#EF9F27', cornerRadius: '3px', width: `${Math.min(100, Math.round(n.fatTotal/0.65))}%`, height: '8px', contents: [] },
            ]},
          ]},
          { type: 'text', text: `${n.fatTotal}g`, size: 'xs', color: '#EF9F27', flex: 2, align: 'end', weight: 'bold' },
        ]},
        ...(fatItems.length ? [
          { type: 'separator', margin: 'sm' },
          { type: 'text', text: 'รายละเอียดไขมัน', size: 'xs', color: '#94a3b8', margin: 'sm', weight: 'bold' },
          ...fatItems.map(f => ({ type: 'box', layout: 'horizontal', margin: 'xs', contents: [
            { type: 'text', text: f.label, size: 'xs', color: f.color, flex: 3 },
            { type: 'text', text: f.val,   size: 'xs', color: f.color, flex: 1, align: 'end', weight: 'bold' },
          ]})),
        ] : []),
        ...(tip ? [
          { type: 'box', layout: 'vertical', backgroundColor: '#f0fdf4', cornerRadius: '6px', paddingAll: '8px', margin: 'sm',
            contents: [{ type: 'text', text: `💡 ${tip}`, size: 'xs', color: '#065f46', wrap: true }] },
        ] : []),
        ...streakMsg,
        ...(n.isEstimate ? [{ type: 'text', text: '* ค่าโดยประมาณจาก AI ± 10–20%', size: 'xxs', color: '#94a3b8', margin: 'sm' }] : []),
      ]},
      footer: { type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'sm', contents: [
        { type: 'button', style: 'primary', color: '#1D9E75', height: 'sm', action: { type: 'message', label: '📊 ดูสรุปวันนี้', text: 'สรุปวันนี้' } },
        { type: 'button', style: 'secondary', height: 'sm', action: { type: 'message', label: '➕ เพิ่มอาหาร', text: 'เพิ่มอาหาร' } },
      ]},
    },
  };
}

// ── Exercise Result ───────────────────────────────────────────
function flexExerciseResult(name, mins, burn, daily, target) {
  const foodCal = daily?.calories || 0;
  const exCal   = daily?.exerciseCal || 0;
  const net     = foodCal - exCal;
  const pct     = Math.min(100, Math.round(net / target * 100));
  return { type: 'flex', altText: `🏃 ${name} ${mins} นาที — เผาผลาญ ${burn} kcal`,
    contents: { type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#064e3b', paddingAll: '14px', contents: [
        { type: 'text', text: '🏃 บันทึกออกกำลังกาย', size: 'xs', color: '#6ee7b7' },
        { type: 'text', text: `${name} ${mins} นาที`, size: 'md', weight: 'bold', color: '#ffffff', margin: 'xs' },
      ]},
      body: { type: 'box', layout: 'vertical', paddingAll: '14px', spacing: 'sm', contents: [
        { type: 'box', layout: 'horizontal', contents: [
          { type: 'text', text: `-${burn}`, size: 'xxl', weight: 'bold', color: '#E24B4A', flex: 0 },
          { type: 'text', text: ' kcal เผาผลาญ', size: 'sm', color: '#888888', flex: 0 },
        ]},
        { type: 'box', layout: 'horizontal', margin: 'sm', spacing: 'sm', contents: [
          { type: 'box', layout: 'vertical', flex: 1, backgroundColor: '#f9fafb', cornerRadius: '8px', paddingAll: '8px', contents: [
            { type: 'text', text: `${mins} นาที`, size: 'md', weight: 'bold', color: '#111111', align: 'center' },
            { type: 'text', text: 'ระยะเวลา', size: 'xs', color: '#888888', align: 'center' },
          ]},
          { type: 'box', layout: 'vertical', flex: 1, backgroundColor: '#f9fafb', cornerRadius: '8px', paddingAll: '8px', contents: [
            { type: 'text', text: `${Math.round(burn/mins*10)/10}`, size: 'md', weight: 'bold', color: '#111111', align: 'center' },
            { type: 'text', text: 'kcal/นาที', size: 'xs', color: '#888888', align: 'center' },
          ]},
        ]},
        { type: 'separator', margin: 'sm' },
        { type: 'text', text: 'แคลอรี่เน็ตวันนี้', size: 'xs', color: '#888888', margin: 'sm' },
        { type: 'box', layout: 'horizontal', contents: [
          { type: 'text', text: `กิน ${foodCal} − ออกกำลังกาย ${exCal}`, size: 'xs', color: '#888888', flex: 2 },
          { type: 'text', text: `= ${net} kcal`, size: 'xs', color: '#1D9E75', flex: 1, align: 'end', weight: 'bold' },
        ]},
        { type: 'box', layout: 'vertical', backgroundColor: '#f0f0f0', cornerRadius: '4px', height: '6px', margin: 'xs',
          contents: [{ type: 'box', layout: 'vertical', backgroundColor: '#1D9E75', cornerRadius: '4px', width: `${pct}%`, height: '6px', contents: [] }] },
        { type: 'box', layout: 'vertical', backgroundColor: '#f0fdf4', cornerRadius: '6px', paddingAll: '8px', margin: 'sm',
          contents: [{ type: 'text', text: '💪 ยอดเยี่ยมมากครับ! มื้อถัดไปเพิ่มโปรตีนได้อีกนะครับ', size: 'xs', color: '#065f46', wrap: true }] },
      ]},
      footer: { type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'sm', contents: [
        { type: 'button', style: 'primary', color: '#1D9E75', height: 'sm', action: { type: 'message', label: '📊 ดูสรุปวันนี้', text: 'สรุปวันนี้' } },
        { type: 'button', style: 'secondary', height: 'sm', action: { type: 'message', label: '🏋️ เพิ่มกิจกรรม', text: 'ออกกำลังกาย' } },
      ]},
    },
  };
}

// ── Daily Summary ─────────────────────────────────────────────
function flexDailySummary(daily, targetCal) {
  const now = getTH();
  const days = ['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์'];
  const mons = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  const dateLabel = `${days[now.getDay()]}ที่ ${now.getDate()} ${mons[now.getMonth()]}`;

  if (!daily || daily.mealCount === 0) return { type: 'flex', altText: 'สรุปวันนี้',
    contents: { type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#0f172a', paddingAll: '16px', contents: [
        { type: 'text', text: '📊 สรุปวันนี้', size: 'xs', color: '#94a3b8' },
        { type: 'text', text: dateLabel, size: 'lg', weight: 'bold', color: '#1D9E75' },
      ]},
      body: { type: 'box', layout: 'vertical', paddingAll: '16px', contents: [
        { type: 'text', text: 'ยังไม่มีบันทึกอาหารวันนี้ครับ 😊', size: 'sm', color: '#6b7280', align: 'center' },
      ]},
      footer: { type: 'box', layout: 'vertical', paddingAll: '12px', contents: [
        { type: 'button', style: 'primary', color: '#1D9E75', height: 'sm', action: { type: 'message', label: '🍽️ บันทึกอาหาร', text: 'เมนู' } },
      ]},
    },
  };

  const net    = daily.calories - (daily.exerciseCal || 0);
  const remain = Math.max(0, targetCal - net);
  const pct    = Math.min(100, Math.round(net / targetCal * 100));
  const waterTarget2 = 2000;
  const waterPct = Math.min(100, Math.round((daily.waterMl || 0) / waterTarget2 * 100));

  const aiTip = pct < 50 ? 'ยังเหลือแคลอรี่อีกเยอะ อย่าลืมกินให้ครบนะครับ'
              : pct < 85 ? 'วันนี้ดีมากครับ! ควบคุมได้ดี'
              : 'แคลอรี่เกือบครบแล้ว มื้อต่อไปเลือกเบาๆ นะครับ';

  return { type: 'flex', altText: `สรุปวันนี้ ${daily.calories} kcal`,
    contents: { type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#0f172a', paddingAll: '16px', contents: [
        { type: 'text', text: '📊 สรุปวันนี้', size: 'xs', color: '#94a3b8' },
        { type: 'text', text: dateLabel, size: 'lg', weight: 'bold', color: '#1D9E75' },
        { type: 'text', text: `${daily.mealCount} มื้อ`, size: 'xs', color: '#64748b' },
      ]},
      body: { type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'sm', contents: [
        { type: 'box', layout: 'horizontal', contents: [
          { type: 'box', layout: 'vertical', flex: 1, contents: [
            { type: 'text', text: String(daily.calories), size: 'xxl', weight: 'bold', color: '#EF9F27' },
            { type: 'text', text: 'กิน (kcal)', size: 'xs', color: '#888888' },
          ]},
          ...(daily.exerciseCal > 0 ? [{ type: 'box', layout: 'vertical', flex: 1, contents: [
            { type: 'text', text: `-${daily.exerciseCal}`, size: 'xl', weight: 'bold', color: '#E24B4A', align: 'center' },
            { type: 'text', text: 'เผาผลาญ', size: 'xs', color: '#888888', align: 'center' },
          ]}] : []),
          { type: 'box', layout: 'vertical', flex: 1, contents: [
            { type: 'text', text: String(remain), size: 'xxl', weight: 'bold', color: '#1D9E75', align: 'end' },
            { type: 'text', text: 'เหลือ', size: 'xs', color: '#888888', align: 'end' },
          ]},
        ]},
        { type: 'box', layout: 'vertical', backgroundColor: '#f0f0f0', cornerRadius: '4px', height: '8px', margin: 'sm',
          contents: [{ type: 'box', layout: 'vertical', backgroundColor: '#1D9E75', cornerRadius: '4px', width: `${pct}%`, height: '8px', contents: [] }] },
        { type: 'text', text: `${pct}% ของเป้าหมาย ${targetCal} kcal`, size: 'xs', color: '#888888' },
        { type: 'box', layout: 'horizontal', margin: 'md', spacing: 'sm', contents: [
          { type: 'box', layout: 'vertical', flex: 1, backgroundColor: '#E1F5EE', cornerRadius: '8px', paddingAll: '8px', contents: [
            { type: 'text', text: `${Math.round(daily.protein)}g`, size: 'md', weight: 'bold', color: '#085041', align: 'center' },
            { type: 'text', text: 'โปรตีน', size: 'xs', color: '#0F6E56', align: 'center' },
          ]},
          { type: 'box', layout: 'vertical', flex: 1, backgroundColor: '#FAEEDA', cornerRadius: '8px', paddingAll: '8px', contents: [
            { type: 'text', text: `${Math.round(daily.carbs)}g`, size: 'md', weight: 'bold', color: '#633806', align: 'center' },
            { type: 'text', text: 'คาร์บ', size: 'xs', color: '#854F0B', align: 'center' },
          ]},
          { type: 'box', layout: 'vertical', flex: 1, backgroundColor: '#FCEBEB', cornerRadius: '8px', paddingAll: '8px', contents: [
            { type: 'text', text: `${Math.round(daily.fat)}g`, size: 'md', weight: 'bold', color: '#791F1F', align: 'center' },
            { type: 'text', text: 'ไขมัน', size: 'xs', color: '#A32D2D', align: 'center' },
          ]},
        ]},
        { type: 'box', layout: 'horizontal', margin: 'sm', contents: [
          { type: 'text', text: '💧', size: 'sm', flex: 0 },
          { type: 'text', text: `น้ำ ${daily.waterMl || 0} ml / 2,000 ml (${waterPct}%)`, size: 'xs', color: '#378ADD', flex: 1, margin: 'sm' },
        ]},
        { type: 'box', layout: 'vertical', backgroundColor: '#f0fdf4', cornerRadius: '6px', paddingAll: '8px', margin: 'sm',
          contents: [{ type: 'text', text: aiTip, size: 'xs', color: '#065f46', wrap: true }] },
      ]},
      footer: { type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'sm', contents: [
        { type: 'button', style: 'primary', color: '#1D9E75', height: 'sm', action: { type: 'message', label: '➕ เพิ่มมื้อถัดไป', text: 'เพิ่มอาหาร' } },
        { type: 'button', style: 'secondary', height: 'sm', action: { type: 'message', label: '📋 เมนู', text: 'เมนู' } },
      ]},
    },
  };
}

// ── IF Tracker ────────────────────────────────────────────────
function flexIFTracker(st) {
  const { elapsed, remaining, target, endTime, done } = st;
  const pct   = Math.min(100, Math.round(elapsed / target * 100));
  const endTm = `${String(endTime.getHours()).padStart(2,'0')}:${String(endTime.getMinutes()).padStart(2,'0')}`;
  return { type: 'flex', altText: done ? `🎉 IF ${target} ชั่วโมงครบแล้ว!` : `⏱️ IF — เหลือ ${remaining.toFixed(1)} ชม.`,
    contents: { type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#0f172a', paddingAll: '14px', contents: [
        { type: 'text', text: `⏱️ IF Tracker ${target}/${24-target}`, size: 'xs', color: '#94a3b8' },
        { type: 'text', text: done ? '🎉 ครบแล้วครับ!' : 'กำลังอดอาหารครับ', size: 'lg', weight: 'bold', color: '#1D9E75' },
      ]},
      body: { type: 'box', layout: 'vertical', paddingAll: '14px', spacing: 'sm', contents: [
        { type: 'box', layout: 'horizontal', contents: [
          { type: 'box', layout: 'vertical', flex: 1, contents: [
            { type: 'text', text: `${elapsed.toFixed(1)} ชม.`, size: 'xl', weight: 'bold', color: '#1D9E75' },
            { type: 'text', text: 'ผ่านไปแล้ว', size: 'xs', color: '#888888' },
          ]},
          { type: 'box', layout: 'vertical', flex: 1, contents: [
            { type: 'text', text: `${remaining.toFixed(1)} ชม.`, size: 'xl', weight: 'bold', color: '#EF9F27', align: 'end' },
            { type: 'text', text: 'เหลืออีก', size: 'xs', color: '#888888', align: 'end' },
          ]},
        ]},
        { type: 'box', layout: 'vertical', backgroundColor: '#f0f0f0', cornerRadius: '4px', height: '8px', margin: 'sm',
          contents: [{ type: 'box', layout: 'vertical', backgroundColor: '#1D9E75', cornerRadius: '4px', width: `${pct}%`, height: '8px', contents: [] }] },
        { type: 'text', text: `${pct}% · เปิดกินได้ ${endTm} น.`, size: 'xs', color: '#888888' },
        { type: 'box', layout: 'vertical', backgroundColor: '#f0fdf4', cornerRadius: '8px', paddingAll: '10px', margin: 'md', contents: [
          { type: 'text', text: '🥚 มื้อแรกแนะนำ', size: 'xs', weight: 'bold', color: '#085041' },
          { type: 'text', text: 'ไข่ต้ม + น้ำเต้าหู้ ย่อยง่าย ไม่กระชากน้ำตาลครับ', size: 'xs', color: '#0F6E56', margin: 'xs', wrap: true },
        ]},
      ]},
      footer: { type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'sm', contents: [
        ...(done ? [{ type: 'button', style: 'primary', color: '#1D9E75', height: 'sm', action: { type: 'message', label: '🍽️ บันทึกมื้อแรก', text: 'หยุด IF' } }]
               : [{ type: 'button', style: 'secondary', height: 'sm', action: { type: 'message', label: '⏹️ หยุด IF Mode', text: 'หยุด IF' } }]),
      ]},
    },
  };
}

// ── IF Complete Push ──────────────────────────────────────────
function flexIFDone(hours) {
  return { type: 'flex', altText: `🎉 IF ${hours} ชั่วโมงครบแล้วครับ!`,
    contents: { type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#064e3b', paddingAll: '16px', contents: [
        { type: 'text', text: '⏱️ CalBot', size: 'xs', color: '#6ee7b7' },
        { type: 'text', text: `🎉 IF ${hours} ชั่วโมงครบแล้ว!`, size: 'lg', weight: 'bold', color: '#ffffff', margin: 'xs' },
      ]},
      body: { type: 'box', layout: 'vertical', paddingAll: '16px', contents: [
        { type: 'text', text: 'ยอดเยี่ยมมากครับ! ถึงเวลากินมื้อแรกได้แล้วนะครับ 🥗', size: 'sm', color: '#374151', wrap: true },
      ]},
      footer: { type: 'box', layout: 'vertical', paddingAll: '12px', contents: [
        { type: 'button', style: 'primary', color: '#1D9E75', height: 'sm', action: { type: 'message', label: '🍽️ บันทึกมื้อแรก', text: 'หยุด IF' } },
      ]},
    },
  };
}

// ── Weekly Summary Push ───────────────────────────────────────
function flexWeeklySummary(avgCal, daysLogged, streak) {
  const now = getTH();
  const weekAgo = new Date(now.getTime() - 7 * 86400000);
  const mons = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  const range = `${weekAgo.getDate()}–${now.getDate()} ${mons[now.getMonth()]}`;
  const dots  = Array.from({ length: 7 }, (_, i) => ({
    type: 'box', layout: 'vertical', width: '12px', height: '12px', cornerRadius: '6px',
    backgroundColor: i < daysLogged ? '#1D9E75' : '#e5e7eb', contents: [],
  }));
  const tip = daysLogged >= 6 ? 'สัปดาห์นี้ดีมากครับ! บันทึกเกือบครบทุกวัน'
            : daysLogged >= 4 ? 'ทำได้ดีครับ สัปดาห์หน้าลองครบทุกวันดูนะครับ'
            : 'ความสม่ำเสมอคือกุญแจสำคัญครับ ไปต่อได้เลย!';
  return { type: 'flex', altText: `📊 Weekly Summary ${range}`,
    contents: { type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#0f172a', paddingAll: '16px', contents: [
        { type: 'text', text: '📊 Weekly Summary', size: 'xs', color: '#94a3b8' },
        { type: 'text', text: range, size: 'lg', weight: 'bold', color: '#1D9E75' },
      ]},
      body: { type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'sm', contents: [
        { type: 'box', layout: 'horizontal', contents: [
          { type: 'box', layout: 'vertical', flex: 1, contents: [
            { type: 'text', text: String(avgCal), size: 'xl', weight: 'bold', color: '#1a1a1a' },
            { type: 'text', text: 'เฉลี่ย kcal/วัน', size: 'xs', color: '#888888' },
          ]},
          { type: 'box', layout: 'vertical', flex: 1, contents: [
            { type: 'text', text: `${daysLogged}/7`, size: 'xl', weight: 'bold', color: '#1D9E75', align: 'center' },
            { type: 'text', text: 'วันที่บันทึก', size: 'xs', color: '#888888', align: 'center' },
          ]},
          { type: 'box', layout: 'vertical', flex: 1, contents: [
            { type: 'text', text: String(streak), size: 'xl', weight: 'bold', color: '#EF9F27', align: 'end' },
            { type: 'text', text: 'Streak (วัน)', size: 'xs', color: '#888888', align: 'end' },
          ]},
        ]},
        { type: 'box', layout: 'horizontal', margin: 'md', spacing: 'xs', contents: dots },
        { type: 'box', layout: 'vertical', backgroundColor: '#f9fafb', cornerRadius: '8px', paddingAll: '10px', margin: 'sm',
          contents: [{ type: 'text', text: tip, size: 'xs', color: '#374151', wrap: true }] },
      ]},
      footer: { type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'sm', contents: [
        { type: 'button', style: 'primary', color: '#1D9E75', height: 'sm', action: { type: 'message', label: '📊 สรุปวันนี้', text: 'สรุปวันนี้' } },
        { type: 'button', style: 'secondary', height: 'sm', action: { type: 'message', label: '📋 เมนู', text: 'เมนู' } },
      ]},
    },
  };
}

// ── Menu ──────────────────────────────────────────────────────
async function flexMenu(userId, plan) {
  const planLabel = plan === 'premium' ? 'PREMIUM' : 'FREE';
  const planColor = plan === 'premium' ? '#1D9E75' : '#94a3b8';
  const prem      = isPremium(plan);

  const row = (icon, title, sub, action, locked = false) => ({
    type: 'box', layout: 'horizontal',
    backgroundColor: locked ? '#f1f5f9' : '#f9fafb',
    cornerRadius: '10px', paddingAll: '11px', margin: 'xs', action: locked ? undefined : { type: 'message', label: title, text: action },
    contents: [
      { type: 'text', text: icon, size: 'md', flex: 0 },
      { type: 'box', layout: 'vertical', flex: 1, paddingStart: '10px', contents: [
        { type: 'text', text: title, size: 'sm', weight: 'bold', color: locked ? '#94a3b8' : '#0f172a' },
        { type: 'text', text: sub,   size: 'xxs', color: locked ? '#94a3b8' : '#64748b', margin: 'xs' },
      ]},
      locked
        ? { type: 'box', layout: 'vertical', flex: 0, cornerRadius: '20px', paddingAll: '3px', paddingStart: '6px', paddingEnd: '6px', backgroundColor: '#dbeafe', contents: [{ type: 'text', text: '🔒', size: 'xxs', color: '#2563eb' }] }
        : { type: 'text', text: '›', size: 'lg', color: '#cbd5e1', flex: 0 },
    ],
  });

  return { type: 'flex', altText: 'CalBot เมนูหลัก',
    contents: { type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#0f172a', paddingAll: '16px', contents: [
        { type: 'text', text: '🥗 CalBot', size: 'xs', color: '#94a3b8' },
        { type: 'text', text: 'เมนูหลัก', size: 'xl', weight: 'bold', color: '#ffffff', margin: 'xs' },
        { type: 'text', text: `● ${planLabel}`, size: 'xxs', color: planColor, weight: 'bold', margin: 'sm' },
      ]},
      body: { type: 'box', layout: 'vertical', paddingAll: '12px', contents: [
        row('🍽️', 'บันทึกอาหาร',       'พิมพ์หรือถ่ายรูปอาหาร',         'เพิ่มอาหาร'),
        row('📊', 'สรุปวันนี้',          'แคลอรี่ + สารอาหาร + เน็ต',     'สรุปวันนี้'),
        row('🏃', 'ออกกำลังกาย',        'บันทึกและหักแคลอรี่เผาผลาญ',    'ออกกำลังกาย'),
        row('💧', 'บันทึกน้ำ',           'นับการดื่มน้ำรายวัน',            'น้ำ'),
        row('⏱️', 'IF Tracker',         prem ? '16/8 · 18/6 · 20/4' : 'Premium',       prem ? 'IF' : '', !prem),
        row('🎯', 'ตั้งเป้าหมาย',       'ลด/เพิ่ม/รักษาน้ำหนัก',         'ตั้งเป้าหมาย'),
        { type: 'separator', margin: 'sm' },
        row('💳', 'แพลนของฉัน',        `${planLabel} · ${plan === 'premium' ? '79฿/เดือน' : 'ฟรีตลอด'}`, 'แพลน'),
      ]},
      footer: { type: 'box', layout: 'vertical', paddingAll: '12px', contents: [
        { type: 'button', style: 'primary', color: '#1D9E75', height: 'sm', action: { type: 'message', label: '🍽️ บันทึกอาหารใหม่', text: 'เพิ่มอาหาร' } },
      ]},
    },
  };
}

// ── Plan (Free | Premium เท่านั้น) ───────────────────────────
function flexPlan(plan, expiresAt) {
  const isPrem = plan === 'premium';
  const exp    = expiresAt ? new Date(expiresAt).toLocaleDateString('th-TH') : null;
  return { type: 'flex', altText: `แพลนของฉัน: ${isPrem ? 'Premium' : 'Free'}`,
    contents: { type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#0f172a', paddingAll: '16px', contents: [
        { type: 'text', text: '💳 แพลนของฉัน', size: 'xs', color: '#94a3b8' },
        { type: 'text', text: isPrem ? 'Premium' : 'Free', size: 'xxl', weight: 'bold', color: isPrem ? '#1D9E75' : '#94a3b8', margin: 'xs' },
        { type: 'text', text: isPrem ? '79 ฿/เดือน' : 'ฟรีตลอด', size: 'sm', color: '#64748b' },
        ...(exp ? [{ type: 'text', text: `✅ หมดอายุ: ${exp}`, size: 'xs', color: '#1D9E75', margin: 'xs' }] : []),
      ]},
      body: { type: 'box', layout: 'vertical', paddingAll: '14px', spacing: 'sm', contents: [
        { type: 'separator' },
        { type: 'box', layout: 'horizontal', margin: 'sm', contents: [
          { type: 'text', text: 'Premium รายเดือน', size: 'sm', color: '#1D9E75', weight: 'bold', flex: 2 },
          { type: 'text', text: '79 ฿', size: 'sm', color: '#374151', flex: 1, align: 'end' },
        ]},
        { type: 'box', layout: 'horizontal', contents: [
          { type: 'text', text: 'Premium รายปี', size: 'sm', color: '#1D9E75', weight: 'bold', flex: 2 },
          { type: 'text', text: '758 ฿', size: 'sm', color: '#1D9E75', flex: 1, align: 'end', weight: 'bold' },
        ]},
        { type: 'text', text: '✨ รายปีประหยัด 2 เดือน!', size: 'xs', color: '#0F6E56', margin: 'xs' },
        { type: 'separator', margin: 'sm' },
        { type: 'text', text: 'Premium ปลดล็อค:', size: 'sm', color: '#374151', weight: 'bold', margin: 'sm' },
        { type: 'text', text: '⏱️ IF Tracker · 📊 Push สรุปสัปดาห์ · 📤 Card แชร์ IG Story', size: 'xs', color: '#64748b', wrap: true },
      ]},
      footer: { type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'sm', contents: [
        ...(!isPrem ? [{ type: 'button', style: 'primary', color: '#1D9E75', height: 'sm', action: { type: 'message', label: '⬆️ อัปเกรด Premium', text: 'เลือกแพลน:premium' } }] : []),
        { type: 'button', style: 'secondary', height: 'sm', action: { type: 'message', label: '📋 เมนู', text: 'เมนู' } },
      ]},
    },
  };
}

// ── Choose Period ─────────────────────────────────────────────
function flexChoosePeriod() {
  return { type: 'flex', altText: 'เลือกระยะเวลา Premium',
    contents: { type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#0f172a', paddingAll: '16px', contents: [
        { type: 'text', text: '💚 Premium Plan', size: 'sm', weight: 'bold', color: '#1D9E75' },
        { type: 'text', text: 'เลือกระยะเวลาสมัครครับ', size: 'xs', color: '#94a3b8', margin: 'xs' },
      ]},
      body: { type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'md', contents: [
        { type: 'box', layout: 'horizontal', backgroundColor: '#f8fafc', cornerRadius: '12px', paddingAll: '14px',
          action: { type: 'message', text: 'ชำระ:1m' },
          contents: [
            { type: 'box', layout: 'vertical', flex: 1, contents: [
              { type: 'text', text: '1 เดือน', size: 'md', weight: 'bold', color: '#0f172a' },
              { type: 'text', text: 'รายเดือน', size: 'xs', color: '#94a3b8', margin: 'xs' },
            ]},
            { type: 'text', text: '79 ฿', size: 'xl', weight: 'bold', color: '#1D9E75', align: 'end' },
          ],
        },
        { type: 'box', layout: 'horizontal', backgroundColor: '#f0fdf4', cornerRadius: '12px', paddingAll: '14px',
          action: { type: 'message', text: 'ชำระ:1y' },
          contents: [
            { type: 'box', layout: 'vertical', flex: 1, contents: [
              { type: 'text', text: '1 ปี', size: 'md', weight: 'bold', color: '#0f172a' },
              { type: 'text', text: '✨ ประหยัด 190 ฿ (2 เดือนฟรี)', size: 'xs', color: '#1D9E75', margin: 'xs' },
            ]},
            { type: 'text', text: '758 ฿', size: 'xl', weight: 'bold', color: '#1D9E75', align: 'end' },
          ],
        },
      ]},
    },
  };
}

// ── Payment ───────────────────────────────────────────────────
function flexPayment(period, price) {
  const label = period === '1y' ? '1 ปี' : '1 เดือน';
  return { type: 'flex', altText: `ชำระเงิน Premium ${label}`,
    contents: { type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#0f172a', paddingAll: '16px', contents: [
        { type: 'text', text: '💳 ชำระเงิน', size: 'xs', color: '#94a3b8' },
        { type: 'text', text: `Premium — ${label}`, size: 'lg', weight: 'bold', color: '#ffffff', margin: 'xs' },
        { type: 'text', text: `${price.toLocaleString()} ฿`, size: 'xxl', weight: 'bold', color: '#1D9E75', margin: 'xs' },
      ]},
      body: { type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'sm', contents: [
        { type: 'text', text: 'โอนเงินมาที่ครับ', size: 'sm', color: '#64748b' },
        { type: 'separator', margin: 'sm' },
        { type: 'box', layout: 'horizontal', margin: 'sm', contents: [
          { type: 'text', text: 'ธนาคาร',   size: 'sm', color: '#94a3b8', flex: 1 },
          { type: 'text', text: 'กสิกรไทย (KBank)', size: 'sm', color: '#0f172a', flex: 2, align: 'end' },
        ]},
        { type: 'box', layout: 'horizontal', contents: [
          { type: 'text', text: 'เลขบัญชี', size: 'sm', color: '#94a3b8', flex: 1 },
          { type: 'text', text: 'XXX-X-XXXXX-X', size: 'sm', color: '#0f172a', flex: 2, align: 'end', weight: 'bold' },
        ]},
        { type: 'separator', margin: 'md' },
        { type: 'text', text: '📸 โอนแล้วส่งสลิปมาที่นี่ได้เลยครับ จะอัปเกรดให้ทันที!', size: 'xs', color: '#374151', wrap: true, margin: 'sm' },
      ]},
    },
  };
}

// ══════════════════════════════════════════════════════════════
// START SERVER
// ══════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ CalBot v2 รันที่ port ${PORT}`));

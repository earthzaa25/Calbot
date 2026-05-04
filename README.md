# 🥗 CalBot v2 — โค้ชสุขภาพส่วนตัวใน Line

แพ็กเกจ: **Free** | **Premium (79฿/เดือน, 758฿/ปี)**  
ไม่มี Pro/B2B — เน้น Consumer เต็มรูปแบบ

---

## 🚀 ขั้นตอนติดตั้ง (ทำครั้งเดียว)

### 1. สมัคร Line OA (ฟรี)
1. ไปที่ https://developers.line.biz/ → สร้าง Provider
2. New Channel → **Messaging API**
3. ชื่อ: CalBot
4. คัดลอก **Channel Secret** และ **Channel Access Token**

### 2. สมัคร Supabase (ฟรี)
1. ไปที่ https://supabase.com/ → New Project
2. SQL Editor → วาง `schema.sql` ทั้งหมด → Run
3. คัดลอก **Project URL** และ **anon key**

### 3. สมัคร Edamam Nutrition API (ฟรี 400 req/เดือน)
1. ไปที่ https://developer.edamam.com/
2. Food Database API → Get Started (Free)
3. คัดลอก **App ID** และ **App Key**

### 4. สมัคร API Ninjas Exercise (ฟรี 50,000 req/เดือน)
1. ไปที่ https://api-ninjas.com/
2. Sign Up Free → My Account → API Key
3. คัดลอก **API Key**

### 5. สมัคร Anthropic API (Claude)
1. ไปที่ https://console.anthropic.com/
2. API Keys → Create Key
3. คัดลอก key

### 6. ตั้งค่า .env
```bash
cp .env.example .env
# แก้ไขค่าจริงทุกบรรทัด
```

### 7. ติดตั้งและรัน
```bash
npm install
npm start
```

### 8. Deploy บน Railway (แนะนำ)
1. https://railway.app/ → New Project → GitHub Repo
2. Add Environment Variables ทุกตัว
3. คัดลอก URL เช่น `https://calbot-xxx.railway.app`

### 9. ตั้งค่า Webhook ใน Line
1. Line Developer Console → Messaging API Settings
2. Webhook URL: `https://your-domain.railway.app/webhook`
3. เปิด **Use webhook**
4. ปิด Auto-reply และ Greeting messages

### 10. ตั้ง Rich Menu (ไม่ต้องเขียนโค้ด!)
ใน Line Official Account Manager → Rich Menu → สร้างใหม่

| ช่อง | Label | Action Text |
|------|-------|-------------|
| 1 | 🍽️ บันทึกอาหาร | `เพิ่มอาหาร` |
| 2 | 📊 สรุปวันนี้   | `สรุปวันนี้` |
| 3 | 🏃 ออกกำลังกาย  | `ออกกำลังกาย` |
| 4 | 💧 น้ำ          | `น้ำ` |
| 5 | ⏱️ IF Mode      | `IF` |
| 6 | 📋 เมนู         | `เมนู` |

---

## 📱 คำสั่งทั้งหมด

| พิมพ์ | ผลลัพธ์ |
|-------|---------|
| ชื่ออาหาร เช่น `ข้าวผัดกระเพรา` | แคลอรี่ + ไขมันดี/เลว |
| 📷 ส่งรูปอาหาร | วิเคราะห์จากรูป |
| `วิ่ง 30 นาที` | บันทึกออกกำลังกาย |
| `สรุปวันนี้` | สรุปแคลอรี่เน็ต + สารอาหาร |
| `น้ำ` | บันทึกน้ำ 250ml |
| `IF` | ดู IF Tracker (Premium) |
| `เริ่ม IF 16` | เริ่ม IF 16/8 (Premium) |
| `หยุด IF` | หยุด IF Mode |
| `ตั้งเป้าหมาย` | ตั้งเป้าแคลอรี่ส่วนตัว |
| `เมนู` | เมนูทั้งหมด |
| `แพลน` | ดู/อัปเกรดแพ็กเกจ |

---

## 💰 แพ็กเกจ

| | Free | Premium |
|---|---|---|
| คำนวณแคลอรี่ + ไขมัน | ✅ ไม่จำกัด | ✅ ไม่จำกัด |
| วิเคราะห์รูปอาหาร | ✅ | ✅ |
| ออกกำลังกาย + เน็ตแคลอรี่ | ✅ | ✅ |
| บันทึกน้ำ | ✅ | ✅ |
| ระบบสี 🟢🟡🔴 | ✅ | ✅ |
| ตั้งเป้าหมายส่วนตัว | ✅ | ✅ |
| IF Tracker | ❌ | ✅ |
| Push สรุปสัปดาห์ (อาทิตย์) | ❌ | ✅ |
| **ราคา** | **ฟรีตลอด** | **79฿/เดือน · 758฿/ปี** |

---

## 🏗️ โครงสร้างไฟล์

```
calbot_v2/
├── index.js          # ไฟล์หลัก Webhook + Logic + Flex Messages
├── schema.sql        # Supabase Database Schema
├── package.json
├── .env.example
└── README.md
```

---

## 🔧 Tech Stack

| ส่วน | เทคโนโลยี | ราคา |
|------|-----------|------|
| Chatbot | Line Messaging API | ฟรี |
| Nutrition | Edamam Food Database API | ฟรี–500฿ |
| Exercise | API Ninjas Exercise API | ฟรี |
| AI | Claude claude-sonnet-4-6 | ~300–800฿/เดือน |
| Database | Supabase PostgreSQL | ฟรี–800฿ |
| Hosting | Railway / Render | ~300–500฿/เดือน |

**ต้นทุนเริ่มต้น: ~650 ฿/เดือน** (Line OA Unverified)

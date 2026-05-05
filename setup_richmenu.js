// ============================================================
// setup_richmenu.js — สร้าง Rich Menu CalBot ผ่าน Line API
// รันครั้งเดียว: node setup_richmenu.js
// ต้องมี LINE_CHANNEL_ACCESS_TOKEN ใน .env
// ============================================================

if (process.env.NODE_ENV !== 'production') require('dotenv').config();
const fetch = require('node-fetch');
const fs    = require('fs');
const path  = require('path');

const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const BASE  = 'https://api.line.me/v2/bot';

const headers = {
  'Authorization': `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
};

// ── Rich Menu Size: 2500x1686 (Full) ────────────────────────
// Layout ตามรูปอ้างอิง:
// [  A Banner  ][  B1 สรุป  ][ B2 เพิ่ม ][  D จัดการ  ][ E ออกกำลัง ]
// [C1บันทึกอาหาร][C2เมนูแนะนำ][C3ค้นหาแคล][  (D ต่อ)   ][  (E ต่อ)   ]
// [F1 แจ้งดื่ม  ][ F2 AI สรุป ][F3บันทึกซ้ำ][F4 แผนยาว  ][ F5 เมนูทั้ง]
//
// Grid pixel map (width=2500, height=1686):
// cols: 0, 720, 1140, 1560, 2030 → 2500
// rows: 0, 560, 1123 → 1686

const COL = [0, 720, 1140, 1560, 2030, 2500];
const ROW = [0, 560, 1123, 1686];

// Helper สร้าง area
const area = (c1, r1, c2, r2) => ({
  x: COL[c1], y: ROW[r1],
  width:  COL[c2] - COL[c1],
  height: ROW[r2] - ROW[r1],
});

const richMenuBody = {
  size: { width: 2500, height: 1686 },
  selected: true,
  name: 'CalBot Main Menu',
  chatBarText: '📋 เมนู CalBot',
  areas: [
    // A: Banner — กด "สวัสดี" เพื่อดู welcome
    {
      bounds: area(0, 0, 1, 1),
      action: { type: 'message', text: 'สวัสดี' },
    },
    // B1: สรุปวันนี้
    {
      bounds: area(1, 0, 2, 1),
      action: { type: 'message', text: 'สรุปวันนี้' },
    },
    // B2: เพิ่มบันทึก
    {
      bounds: area(2, 0, 3, 1),
      action: { type: 'message', text: 'เพิ่มอาหาร' },
    },
    // D: จัดการแผน (สูง 2 แถว row 0-2)
    {
      bounds: area(3, 0, 4, 2),
      action: { type: 'message', text: 'ตั้งเป้าหมาย' },
    },
    // E: ออกกำลังกาย (สูง 2 แถว row 0-2)
    {
      bounds: area(4, 0, 5, 2),
      action: { type: 'message', text: 'ออกกำลังกาย' },
    },
    // C1: บันทึกอาหาร
    {
      bounds: area(0, 1, 1, 2),
      action: { type: 'message', text: 'เพิ่มอาหาร' },
    },
    // C2: เมนูแนะนำ
    {
      bounds: area(1, 1, 2, 2),
      action: { type: 'message', text: 'เมนู' },
    },
    // C3: ค้นหาแคลอรี่
    {
      bounds: area(2, 1, 3, 2),
      action: { type: 'message', text: 'ค้นหาแคลอรี่' },
    },
    // F1: แจ้งดื่มน้ำ
    {
      bounds: area(0, 2, 1, 3),
      action: { type: 'message', text: 'น้ำ' },
    },
    // F2: AI สรุปสัปดาห์
    {
      bounds: area(1, 2, 2, 3),
      action: { type: 'message', text: 'สรุปสัปดาห์' },
    },
    // F3: บันทึกซ้ำ
    {
      bounds: area(2, 2, 3, 3),
      action: { type: 'message', text: 'บันทึกซ้ำ' },
    },
    // F4: แผนระยะยาว
    {
      bounds: area(3, 2, 4, 3),
      action: { type: 'message', text: 'แพลน' },
    },
    // F5: เมนูทั้งหมด
    {
      bounds: area(4, 2, 5, 3),
      action: { type: 'message', text: 'เมนู' },
    },
  ],
};

// ── Functions ────────────────────────────────────────────────
async function createRichMenu() {
  const res  = await fetch(`${BASE}/richmenu`, {
    method: 'POST', headers,
    body: JSON.stringify(richMenuBody),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`createRichMenu: ${JSON.stringify(data)}`);
  console.log('✅ Rich Menu created:', data.richMenuId);
  return data.richMenuId;
}

async function uploadImage(richMenuId, imagePath) {
  const imageBuffer = fs.readFileSync(imagePath);
  const ext = path.extname(imagePath).toLowerCase();
  const contentType = ext === '.jpg' || ext === '.jpeg'
    ? 'image/jpeg' : 'image/png';

  const res = await fetch(
    `https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': contentType,
      },
      body: imageBuffer,
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`uploadImage: ${text}`);
  }
  console.log('✅ Image uploaded');
}

async function setDefaultRichMenu(richMenuId) {
  const res = await fetch(
    `${BASE}/user/all/richmenu/${richMenuId}`,
    { method: 'POST', headers: { 'Authorization': `Bearer ${TOKEN}` } }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`setDefault: ${text}`);
  }
  console.log('✅ Set as default Rich Menu for all users');
}

async function deleteOldRichMenus() {
  const res  = await fetch(`${BASE}/richmenu/list`, { headers });
  const data = await res.json();
  const menus = data.richmenus || [];
  console.log(`🗑️  Found ${menus.length} existing rich menu(s)`);
  for (const menu of menus) {
    const del = await fetch(`${BASE}/richmenu/${menu.richMenuId}`, {
      method: 'DELETE', headers,
    });
    if (del.ok) console.log(`🗑️  Deleted: ${menu.richMenuId}`);
  }
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
  console.log('\n🥗 CalBot Rich Menu Setup\n' + '─'.repeat(40));

  if (!TOKEN) {
    console.error('❌ ไม่พบ LINE_CHANNEL_ACCESS_TOKEN ใน .env');
    process.exit(1);
  }

  // หาไฟล์รูป Rich Menu
  const imagePaths = [
    './calbot_richmenu.jpg',
    './calbot_richmenu.png',
    './richmenu.jpg',
    './richmenu.png',
  ];
  const imagePath = imagePaths.find(p => fs.existsSync(p));
  if (!imagePath) {
    console.error('❌ ไม่พบไฟล์รูป Rich Menu');
    console.error('   วางไฟล์ calbot_richmenu.png ไว้ในโฟลเดอร์เดียวกันค่ะ');
    process.exit(1);
  }
  console.log('📁 ใช้รูป:', imagePath);

  try {
    // 1. ลบ Rich Menu เก่า
    await deleteOldRichMenus();

    // 2. สร้าง Rich Menu ใหม่
    const richMenuId = await createRichMenu();

    // 3. อัปโหลดรูป
    await uploadImage(richMenuId, imagePath);

    // 4. Set เป็น default สำหรับทุก user
    await setDefaultRichMenu(richMenuId);

    console.log('\n🎉 Rich Menu พร้อมแล้วค่ะ!');
    console.log(`   Rich Menu ID: ${richMenuId}`);
    console.log('   ลอง Add Line OA แล้วดู Rich Menu ได้เลยค่ะ\n');
  } catch (err) {
    console.error('\n❌ Error:', err.message);
    process.exit(1);
  }
}

main();

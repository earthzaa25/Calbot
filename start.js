// start.js — รัน Rich Menu setup ครั้งแรก แล้วเริ่มบอท
// Railway จะรัน "node start.js" ผ่าน package.json

const { execSync, spawn } = require('child_process');
const fs = require('fs');

async function setupRichMenu() {
  // เช็คว่ามีไฟล์ setup_richmenu.js และรูปภาพ
  if (!fs.existsSync('./setup_richmenu.js')) {
    console.log('⚠️  ไม่พบ setup_richmenu.js ข้ามขั้นตอน Rich Menu');
    return;
  }
  if (!fs.existsSync('./calbot_richmenu.png')) {
    console.log('⚠️  ไม่พบ calbot_richmenu.png ข้ามขั้นตอน Rich Menu');
    return;
  }

  // เช็คว่าเคย setup แล้วหรือยัง (ใช้ flag file)
  if (fs.existsSync('./.richmenu_done')) {
    console.log('✅ Rich Menu setup แล้วค่ะ (ข้ามขั้นตอน)');
    return;
  }

  console.log('🥗 กำลังตั้งค่า Rich Menu...');
  try {
    execSync('node setup_richmenu.js', { stdio: 'inherit' });
    // สร้าง flag file เพื่อไม่ต้อง setup ใหม่ทุกครั้ง
    fs.writeFileSync('./.richmenu_done', new Date().toISOString());
    console.log('✅ Rich Menu setup สำเร็จค่ะ!');
  } catch (err) {
    console.error('⚠️  Rich Menu setup ล้มเหลว แต่บอทยังทำงานได้ค่ะ:', err.message);
  }
}

async function main() {
  await setupRichMenu();

  console.log('\n🚀 เริ่มต้น CalBot...\n');

  // เริ่ม index.js
  const bot = spawn('node', ['index.js'], { stdio: 'inherit' });

  bot.on('error', (err) => {
    console.error('❌ เริ่ม bot ไม่ได้:', err.message);
    process.exit(1);
  });

  bot.on('exit', (code) => {
    console.log(`Bot หยุดทำงาน code: ${code}`);
    process.exit(code);
  });

  // ส่ง signal ไปยัง bot เมื่อ process หยุด
  process.on('SIGTERM', () => bot.kill('SIGTERM'));
  process.on('SIGINT',  () => bot.kill('SIGINT'));
}

main();

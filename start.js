// start.js — รัน Rich Menu setup แล้วเริ่มบอท
const { execSync, spawn } = require('child_process');
const fs = require('fs');

async function setupRichMenu() {
  if (!fs.existsSync('./setup_richmenu.js')) {
    console.log('⚠️  ไม่พบ setup_richmenu.js ข้ามขั้นตอน Rich Menu');
    return;
  }

  // หารูป Rich Menu
  const imgPaths = ['./calbot_richmenu.jpg','./calbot_richmenu.png'];
  const imgPath  = imgPaths.find(p => fs.existsSync(p));
  if (!imgPath) {
    console.log('⚠️  ไม่พบรูป Rich Menu ข้ามขั้นตอน');
    return;
  }

  // เช็ค flag — ถ้ามีอยู่และรูปไม่เปลี่ยนก็ข้าม
  const flagFile = './.richmenu_done';
  const imgMtime = fs.statSync(imgPath).mtimeMs;
  if (fs.existsSync(flagFile)) {
    const flag = JSON.parse(fs.readFileSync(flagFile, 'utf8'));
    if (flag.imgMtime === imgMtime) {
      console.log('✅ Rich Menu ตั้งค่าแล้วค่ะ (ข้ามขั้นตอน)');
      return;
    }
  }

  console.log('🥗 กำลังตั้งค่า Rich Menu...');
  try {
    execSync('node setup_richmenu.js', { stdio: 'inherit' });
    fs.writeFileSync(flagFile, JSON.stringify({ done: new Date().toISOString(), imgMtime }));
    console.log('✅ Rich Menu setup สำเร็จค่ะ!');
  } catch (err) {
    console.error('⚠️  Rich Menu setup ล้มเหลว แต่บอทยังทำงานได้ค่ะ:', err.message);
  }
}

async function main() {
  await setupRichMenu();
  console.log('\n🚀 เริ่มต้น CalBot...\n');

  const bot = spawn('node', ['index.js'], { stdio: 'inherit' });
  bot.on('error', (err) => { console.error('❌', err.message); process.exit(1); });
  bot.on('exit', (code) => { process.exit(code); });
  process.on('SIGTERM', () => bot.kill('SIGTERM'));
  process.on('SIGINT',  () => bot.kill('SIGINT'));
}

main();

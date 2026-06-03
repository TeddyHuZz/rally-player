const { spawn } = require('child_process');

function runSingleVideoSearch(query) {
  const args = [
    `ytsearch1:${query}`,
    '--dump-json',
    '--flat-playlist'
  ];

  const env = { ...process.env };
  if (process.platform === 'darwin') {
    const homebrewPath = '/opt/homebrew/bin:/usr/local/bin';
    env.PATH = env.PATH ? `${homebrewPath}:${env.PATH}` : homebrewPath;
  }

  return new Promise((resolve) => {
    const child = spawn('yt-dlp', args, { env });
    let stdoutData = '';

    child.stdout.on('data', (data) => {
      stdoutData += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0 || !stdoutData.trim()) {
        resolve(null);
        return;
      }

      try {
        const lines = stdoutData.split('\n').filter(l => l.trim() !== '');
        if (lines.length > 0) {
          const meta = JSON.parse(lines[0]);
          resolve(meta.id || null);
        } else {
          resolve(null);
        }
      } catch (err) {
        resolve(null);
      }
    });
  });
}

async function testFindMatchVideo() {
  const tournament = "Indonesia Open 2026";
  const discipline = "Men's Singles";
  const player1 = "Shi Yuqi (CHN) [Court Stream]";
  const player2 = "Jonatan Christie (INA)";
  const isLive = true;

  const cleanTournament = tournament.replace(/202\d/, '').trim();
  const query = `BWF ${cleanTournament} ${discipline} ${player1} vs ${player2} ${isLive ? 'live' : 'highlights'}`;

  console.log('Query:', query);
  const result = await runSingleVideoSearch(query);
  console.log('Resolved Video ID:', result);
}

testFindMatchVideo();

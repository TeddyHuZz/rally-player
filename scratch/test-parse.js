const axios = require('axios');
const cheerio = require('cheerio');

async function test() {
  try {
    const url = 'https://en.wikipedia.org/api/rest_v1/page/html/2026_BWF_World_Tour';
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'RallyPlayerBadmintonStudio/1.0 (contact: wenfei@example.com)'
      }
    });
    const $ = cheerio.load(response.data);
    
    // Monthly tables are tables under monthly sections (January to December)
    // Wikipedia months sections are h3 elements with ids like "January", "February", etc.
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    
    for (const month of months) {
      console.log(`=== Section: ${month} ===`);
      // Find the h3 section for the month
      const section = $(`h3#mwBAA, h3:contains("${month}")`); // find by id or text
      // Let's find tables that come after a monthly h3
      const table = $(`h3:contains("${month}")`).nextAll('table.wikitable').first();
      if (!table.length) {
        // Try h3 containing month name
        const h3 = $('h3').filter((i, el) => $(el).text().includes(month));
        const tbl = h3.nextAll('table.wikitable').first();
        if (tbl.length) {
          parseTable($, tbl, month);
        }
        continue;
      }
      parseTable($, table, month);
    }
  } catch (err) {
    console.error(err);
  }
}

function parseTable($, table, month) {
  const rows = table.find('tr');
  console.log(`Found table with ${rows.length} rows`);
  
  let currentTournament = null;
  let disciplineIndex = 0;
  const disciplines = ["Men's Singles", "Women's Singles", "Men's Doubles", "Women's Doubles", "Mixed Doubles"];
  
  rows.each((i, row) => {
    if (i === 0) return; // Header row
    const cells = $(row).find('td');
    if (cells.length === 0) return;
    
    // Check if this row starts a new tournament
    const hasTournamentDetails = cells.length >= 4;
    
    if (hasTournamentDetails) {
      // First td is Date
      const dateText = $(cells[0]).text().trim();
      // Second td is Tournament details
      const tournamentCell = $(cells[1]);
      const tournamentName = tournamentCell.find('b a').first().text().trim() || tournamentCell.find('b').first().text().trim();
      
      if (!tournamentName) return;
      
      // Parse details list
      const detailsList = tournamentCell.find('ul li');
      let host = '';
      let venue = '';
      let level = '';
      let prize = '';
      
      detailsList.each((j, li) => {
        const text = $(li).text().trim();
        if (text.startsWith('Host:')) host = text.replace('Host:', '').trim();
        if (text.startsWith('Venue:')) venue = text.replace('Venue:', '').trim();
        if (text.startsWith('Level:')) level = text.replace('Level:', '').trim();
        if (text.startsWith('Prize:')) prize = text.replace('Prize:', '').trim();
      });
      
      currentTournament = {
        name: tournamentName,
        dates: `${dateText} 2026`,
        location: host || city || 'International',
        category: level || 'World Tour',
        prizeMoney: prize || '$100,000',
        winners: []
      };
      
      disciplineIndex = 0;
      
      // First row also contains the winner for the first discipline (Men's Singles)
      const championCellIdx = 2;
      const runnerUpCellIdx = 3;
      
      const championText = $(cells[championCellIdx]).text().trim();
      const runnerUpText = $(cells[runnerUpCellIdx]).text().trim();
      
      if (championText) {
        currentTournament.winners.push({
          discipline: disciplines[disciplineIndex],
          player: championText,
          opponent: runnerUpText || 'Unknown',
          score: 'N/A'
        });
      }
      
      console.log(`Tournament: ${tournamentName} | Dates: ${dateText} | Level: ${level}`);
      console.log(`  Winner MS: ${championText} vs ${runnerUpText}`);
      
    } else if (currentTournament) {
      // Subsequent row: only has Champions and Runners-up cells (usually 2 cells)
      disciplineIndex++;
      const championText = $(cells[0]).text().trim();
      const runnerUpText = $(cells[1]).text().trim();
      
      if (championText && disciplineIndex < disciplines.length) {
        currentTournament.winners.push({
          discipline: disciplines[disciplineIndex],
          player: championText,
          opponent: runnerUpText || 'Unknown',
          score: 'N/A'
        });
      }
      console.log(`  Winner ${disciplines[disciplineIndex]}: ${championText} vs ${runnerUpText}`);
    }
  });
}

test();

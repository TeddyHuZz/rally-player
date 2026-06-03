import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { spawn } from 'child_process';
import axios from 'axios';
import * as cheerio from 'cheerio';

@Injectable()
export class StreamService implements OnModuleInit {
  private readonly logger = new Logger(StreamService.name);
  
  // In-memory cache for different feeds (keys are search terms or defaults)
  private readonly feedCache = new Map<string, { feed: any[]; expiresAt: number }>();

  // In-memory cache for public proxy lists by country code
  private readonly cachedProxies = new Map<string, string[]>();
  private readonly activeProxyIndex = new Map<string, number>();

  async getProxyForCountry(country: string): Promise<string | null> {
    const code = country.toUpperCase();
    if (code === 'DIRECT') return null;

    let proxies = this.cachedProxies.get(code);
    if (!proxies || proxies.length === 0) {
      try {
        this.logger.log(`Fetching public elite proxies for country ${code}...`);
        const url = `https://proxylist.geonode.com/api/proxy-list?limit=15&page=1&sort_by=lastChecked&sort_type=desc&protocols=http,https&country=${code}`;
        const response = await axios.get(url, { timeout: 5000 });
        if (response.data && Array.isArray(response.data.data)) {
          proxies = response.data.data
            .filter((p: any) => p.ip && p.port)
            .map((p: any) => `http://${p.ip}:${p.port}`);
          
          this.cachedProxies.set(code, proxies);
          this.activeProxyIndex.set(code, 0);
          this.logger.log(`Successfully cached ${proxies.length} proxies for ${code}.`);
        }
      } catch (err) {
        this.logger.error(`Failed to fetch proxies for ${code}: ${err.message}`);
        return null;
      }
    }

    if (proxies && proxies.length > 0) {
      const index = this.activeProxyIndex.get(code) || 0;
      const proxy = proxies[index % proxies.length];
      this.logger.log(`Using proxy for ${code}: ${proxy} (index ${index})`);
      return proxy;
    }
    return null;
  }

  rotateProxy(country: string) {
    const code = country.toUpperCase();
    const index = this.activeProxyIndex.get(code) || 0;
    this.activeProxyIndex.set(code, index + 1);
    this.logger.log(`Rotated proxy index for ${code} to ${index + 1}`);
  }

  async getDirectStreamUrl(videoId: string, countryCode?: string): Promise<{ url: string; proxyUsed?: string } | null> {
    const runYtdlp = (proxyUrl: string | null): Promise<string | null> => {
      return new Promise((resolve) => {
        const args = [
          '-g',
          '-f', 'best[ext=mp4]/best',
          `https://www.youtube.com/watch?v=${videoId}`
        ];
        if (proxyUrl) {
          args.push('--proxy', proxyUrl);
        }

        const env = { ...process.env };
        if (process.platform === 'darwin') {
          const homebrewPath = '/opt/homebrew/bin:/usr/local/bin';
          env.PATH = env.PATH ? `${homebrewPath}:${env.PATH}` : homebrewPath;
        }

        const child = spawn('yt-dlp', args, { env });
        let stdoutData = '';
        let stderrData = '';

        child.stdout?.on('data', (data) => {
          stdoutData += data.toString();
        });
        child.stderr?.on('data', (data) => {
          stderrData += data.toString();
        });

        child.on('close', (code) => {
          if (code !== 0 || !stdoutData.trim()) {
            this.logger.warn(`yt-dlp stream extraction failed (code ${code}): ${stderrData.trim().substring(0, 150)}`);
            resolve(null);
          } else {
            resolve(stdoutData.trim().split('\n')[0]);
          }
        });
      });
    };

    let proxy = null;
    if (countryCode && countryCode !== 'DIRECT') {
      proxy = await this.getProxyForCountry(countryCode);
    }

    let streamUrl = await runYtdlp(proxy);

    // If proxy failed, rotate and try once more
    if (!streamUrl && proxy && countryCode) {
      this.logger.warn(`Proxy ${proxy} failed for video stream extraction, rotating proxy...`);
      this.rotateProxy(countryCode);
      proxy = await this.getProxyForCountry(countryCode);
      streamUrl = await runYtdlp(proxy);
    }

    // Fallback to direct connection if proxy still fails
    if (!streamUrl && countryCode && countryCode !== 'DIRECT') {
      this.logger.warn(`Bypassing proxy and trying direct extraction for video ${videoId}...`);
      streamUrl = await runYtdlp(null);
      proxy = null;
    }

    if (streamUrl) {
      return { url: streamUrl, proxyUsed: proxy || undefined };
    }
    return null;
  }

  onModuleInit() {
    this.logger.log('Pre-warming live badminton feed...');
    
    // Asynchronously pre-warm the default feed
    this.getBadmintonFeed().then(() => {
      this.logger.log('Default live badminton feed successfully cached.');
    }).catch(err => {
      this.logger.error(`Startup pre-warming encountered an error: ${err.message}`);
    });
  }

  /**
   * Returns a dynamic list of badminton match videos.
   * If a searchQuery is specified, it runs a custom query.
   * Uses an in-memory cache to ensure instantaneous loadings.
   */
  async getBadmintonFeed(searchQuery?: string, page = 1): Promise<any[]> {
    const cacheKey = `${searchQuery ? searchQuery.trim().toLowerCase() : '__default_bwf_feed__'}_page_${page}`;
    const cached = this.feedCache.get(cacheKey);
    
    if (cached && cached.expiresAt > Date.now()) {
      this.logger.log(`Returning CACHED badminton feed for key: ${cacheKey}`);
      return cached.feed;
    }

    this.logger.log(`Fetching fresh badminton feed for search key: ${cacheKey}...`);
    try {
      const isDefault = !searchQuery;
      const isLiveTournaments = searchQuery === '__live_tournaments__';
      
      let feed: any[] = [];
      
      if (isDefault) {
        // Fetch from official BWF TV channel and Badminton Insight (tactical/slow-motion analytical channel) in parallel
        const [bwfFeed, insightFeed] = await Promise.all([
          this.runBadmintonSearch('https://www.youtube.com/@BWF/videos', true, page, 6),
          this.runBadmintonSearch('https://www.youtube.com/@BadmintonInsight/videos', true, page, 6)
        ]);

        // Interleave the results chronologically (alternating channels)
        const maxLength = Math.max(bwfFeed.length, insightFeed.length);
        for (let i = 0; i < maxLength; i++) {
          if (i < bwfFeed.length) feed.push(bwfFeed[i]);
          if (i < insightFeed.length) feed.push(insightFeed[i]);
        }
      } else {
        let queryStr = '';
        let isChannelVideos = false;
        
        if (isLiveTournaments) {
          queryStr = 'https://www.youtube.com/@BWF/streams';
          isChannelVideos = true;
        } else {
          queryStr = `${searchQuery.trim()} badminton`;
          isChannelVideos = false;
        }
        
        feed = await this.runBadmintonSearch(queryStr, isChannelVideos, page);
      }
      
      // Cache custom queries for 15 mins, live tournaments for 5 mins, default feed for 1 hour
      let expireDuration = 60 * 60 * 1000;
      if (isLiveTournaments) {
        expireDuration = 5 * 60 * 1000;
      } else if (searchQuery) {
        expireDuration = 15 * 60 * 1000;
      }

      this.feedCache.set(cacheKey, {
        feed: feed,
        expiresAt: Date.now() + expireDuration,
      });
      
      return feed;
    } catch (err) {
      this.logger.error(`Failed to fetch badminton feed for ${cacheKey}: ${err.message}. Using fallback feed.`);
      return this.getFallbackFeed(page);
    }
  }

  private runBadmintonSearch(queryStr: string, isChannelVideos = false, page = 1, customPageSize?: number): Promise<any[]> {
    const pageSize = customPageSize || 12;
    const start = (page - 1) * pageSize + 1;
    const end = page * pageSize;

    const args = [
      queryStr,
      '--playlist-start', start.toString(),
      '--playlist-end', end.toString(),
      '--dump-json',
      '--flat-playlist'
    ];

    if (!isChannelVideos) {
      args[0] = `ytsearch${end}:${queryStr}`;
    }

    const env = { ...process.env };
    if (process.platform === 'darwin') {
      const homebrewPath = '/opt/homebrew/bin:/usr/local/bin';
      env.PATH = env.PATH ? `${homebrewPath}:${env.PATH}` : homebrewPath;
    }

    return new Promise((resolve, reject) => {
      const child = spawn('yt-dlp', args, { env });
      let stdoutData = '';
      let stderrData = '';

      child.stdout?.on('data', (data) => {
        stdoutData += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderrData += data.toString();
      });

      child.on('close', async (code) => {
        if (code !== 0) {
          reject(new Error(`yt-dlp search failed with code ${code}: ${stderrData}`));
          return;
        }

        try {
          const lines = stdoutData.split('\n').filter(l => l.trim() !== '');
          const videosPromises = lines.map(async (line) => {
            const meta = JSON.parse(line);
            
            // Extract the best thumbnail available (highest resolution)
            let thumbnail = 'https://images.unsplash.com/photo-1626224583764-f87db24ac4ea?q=80&w=350&auto=format&fit=crop';
            if (meta.thumbnails && meta.thumbnails.length > 0) {
              const sortedThumbs = [...meta.thumbnails].sort((a: any, b: any) => (b.width || 0) - (a.width || 0));
              const bestThumb = sortedThumbs[0];
              thumbnail = bestThumb.url;
            }

            const videoId = meta.id;
            let durationStr = meta.duration_string;
            let status = 'COMPLETED';

            if (!durationStr && (meta.duration === null || meta.duration === undefined)) {
              status = await this.checkLiveStatus(videoId);
              durationStr = status;
            }

            let uploader = meta.uploader || meta.channel || meta.playlist_uploader || meta.playlist_channel;
            if (!uploader) {
              if (isChannelVideos && queryStr) {
                if (queryStr.includes('@BadmintonInsight')) {
                  uploader = 'Badminton Insight';
                } else if (queryStr.includes('@BWF')) {
                  uploader = 'BWF TV';
                }
              }
            }
            if (!uploader) {
              uploader = 'BWF TV';
            }

            return {
              title: meta.title || 'Badminton Match',
              url: meta.url || meta.webpage_url,
              category: uploader,
              duration: durationStr || '15:00',
              status: status,
              description: meta.description ? meta.description.substring(0, 120).trim() + '...' : 'Live badminton action and tactical rallies.',
              thumbnail: thumbnail
            };
          });

          const videos = await Promise.all(videosPromises);

          // Sort LIVE first, then UPCOMING, then COMPLETED replays
          videos.sort((a, b) => {
            const score = (v: any) => v.status === 'LIVE' ? 0 : (v.status === 'UPCOMING' ? 1 : 2);
            return score(a) - score(b);
          });

          resolve(videos);
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  private async checkLiveStatus(videoId: string): Promise<'LIVE' | 'UPCOMING' | 'COMPLETED'> {
    try {
      const url = `https://www.youtube.com/watch?v=${videoId}`;
      const response = await axios.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 5000
      });
      const html = response.data;
      if (typeof html === 'string' && html.includes('scheduledStartTime')) {
        return 'UPCOMING';
      }
      return 'LIVE';
    } catch (err) {
      return 'LIVE'; // Fallback to LIVE if check fails
    }
  }

  private getFallbackFeed(page = 1) {
    const allFallback = [
      {
        title: "Viktor Axelsen vs Lee Zii Jia - Epic Rally Masterclass",
        url: "https://www.youtube.com/watch?v=SV5dItnaNlo",
        category: "Men's Singles",
        duration: "08:09",
        description: "Legendary long rallies, high-intensity footwork, and slow-motion rotation analysis.",
        thumbnail: "https://images.unsplash.com/photo-1626224583764-f87db24ac4ea?q=80&w=350&auto=format&fit=crop"
      },
      {
        title: "BWF All England 2024 MS Final - Christie vs Ginting",
        url: "https://www.youtube.com/watch?v=F3G6L6sK3F8",
        category: "Men's Singles Final",
        duration: "12:45",
        description: "All-Indonesia showdown in Birmingham. Perfect study for deceptive drops and net play.",
        thumbnail: "https://images.unsplash.com/photo-1560079007-a53273e1e21b?q=80&w=350&auto=format&fit=crop"
      },
      {
        title: "World Championships Final - Vitidsarn vs Naraoka",
        url: "https://www.youtube.com/watch?v=cM3L3U4QWz4",
        category: "Tactical Endurance",
        duration: "15:20",
        description: "A monumental 110-minute battle showing extreme defensive structure and recovery.",
        thumbnail: "https://images.unsplash.com/photo-1613918431208-6752c10d8a8b?q=80&w=350&auto=format&fit=crop"
      },
      {
        title: "Lee Chong Wei vs Viktor Axelsen - Classic Showdown",
        url: "https://www.youtube.com/watch?v=9WVwZSzixh0",
        category: "Epic Showdown",
        duration: "10:35",
        description: "Clash of generations. Analysing LCW's cross-court smashes and Axelsen's defensive reach.",
        thumbnail: "https://images.unsplash.com/photo-1554068865-24bc74e34b36?q=80&w=350&auto=format&fit=crop"
      },
      {
        title: "How 17-Year-Old An Se Young Beat Carolina Marin",
        url: "https://www.youtube.com/watch?v=1BuS2L_5Q5g",
        category: "Tactical Review",
        duration: "14:15",
        description: "Badminton Insight review of An Se Young's defensive stance, block control, and tactical movement.",
        thumbnail: "https://images.unsplash.com/photo-1521537634581-0dcc2fee2d2e?q=80&w=350&auto=format&fit=crop"
      },
      {
        title: "All England 2021 Final - Lee Zii Jia vs Axelsen Highlights",
        url: "https://www.youtube.com/watch?v=Vl03q5kM4aA",
        category: "Men's Singles",
        duration: "11:50",
        description: "Analyzing Lee Zii Jia's backhand smash deception and Axelsen's counter-attacks.",
        thumbnail: "https://images.unsplash.com/photo-1599447421416-3414500d18a5?q=80&w=350&auto=format&fit=crop"
      }
    ];

    if (page === 1) {
      return allFallback;
    }
  }

  private parseWikipediaDates(dateStr: string, year: number): { start: Date; end: Date } {
    const clean = dateStr.replace(/\s+/g, ' ').trim();
    const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    
    let startMonth = '';
    let endMonth = '';
    let startDay = 0;
    let endDay = 0;
    
    const crossMonthMatch = clean.match(/(\d+)\s+([a-zA-Z]+)\s*[\u2013\u2014-]\s*(\d+)\s+([a-zA-Z]+)/);
    if (crossMonthMatch) {
      startDay = parseInt(crossMonthMatch[1], 10);
      startMonth = crossMonthMatch[2].toLowerCase();
      endDay = parseInt(crossMonthMatch[3], 10);
      endMonth = crossMonthMatch[4].toLowerCase();
    } else {
      const sameMonthMatch = clean.match(/(\d+)\s*[\u2013\u2014-]\s*(\d+)\s+([a-zA-Z]+)/);
      if (sameMonthMatch) {
        startDay = parseInt(sameMonthMatch[1], 10);
        endDay = parseInt(sameMonthMatch[2], 10);
        startMonth = sameMonthMatch[3].toLowerCase();
        endMonth = startMonth;
      } else {
        const singleDayMatch = clean.match(/(\d+)\s+([a-zA-Z]+)/);
        if (singleDayMatch) {
          startDay = parseInt(singleDayMatch[1], 10);
          endDay = startDay;
          startMonth = singleDayMatch[2].toLowerCase();
          endMonth = startMonth;
        }
      }
    }
    
    const startMonthIdx = months.indexOf(startMonth);
    const endMonthIdx = months.indexOf(endMonth);
    
    const startDate = new Date(year, startMonthIdx >= 0 ? startMonthIdx : 5, startDay || 1);
    const endDate = new Date(year, endMonthIdx >= 0 ? endMonthIdx : 5, endDay || 2, 23, 59, 59);
    
    return { start: startDate, end: endDate };
  }

  private scrapedTournaments: any[] = [];
  private lastScrapeTime = 0;
  private scrapedRankings: any[] = [];
  private lastRankingsScrapeTime = 0;

  async fetchTournamentsFromWikipedia(): Promise<any[]> {
    const CACHE_DURATION = 24 * 60 * 60 * 1000;
    if (this.scrapedTournaments.length > 0 && (Date.now() - this.lastScrapeTime < CACHE_DURATION)) {
      this.logger.log('Returning cached Wikipedia tournaments calendar.');
      return this.scrapedTournaments;
    }

    this.logger.log('Fetching fresh BWF World Tour calendar from Wikipedia...');
    try {
      const url = 'https://en.wikipedia.org/api/rest_v1/page/html/2026_BWF_World_Tour';
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'RallyPlayerBadmintonStudio/1.0 (contact: wenfei@example.com)'
        },
        timeout: 10000
      });

      const $ = cheerio.load(response.data);
      const list: any[] = [];

      const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      const disciplines = ["Men's Singles", "Women's Singles", "Men's Doubles", "Women's Doubles", "Mixed Doubles"];
      const flagMap: Record<string, string> = {
        'malaysia': '🇲🇾', 'india': '🇮🇳', 'indonesia': '🇮🇩', 'thailand': '🇹🇭', 'german': '🇩🇪', 'france': '🇫🇷', 
        'all england': '🇬🇧', 'swiss': '🇨🇭', 'spain': '🇪🇸', 'orleans': '🇫🇷', 'asia': '🇨🇳', 'china': '🇨🇳', 
        'singapore': '🇸🇬', 'australia': '🇦🇺', 'us': '🇺🇸', 'canada': '🇨🇦', 'japan': '🇯🇵', 'korea': '🇰🇷', 
        'taipei': '🇹🇼', 'vietnam': '🇻🇳', 'hong kong': '🇭🇰', 'macau': '🇲🇴', 'finland': '🇫🇮', 'denmark': '🇩🇰', 
        'hylo': '🇩🇪', 'kumamoto': '🇯🇵', 'syed modi': '🇮🇳', 'finals': '🇨🇳'
      };

      const parseWikipediaPlayerCell = (cell: any) => {
        const cloned = cell.clone();
        cloned.find('br').replaceWith(' / ');
        return cloned.text().replace(/\s+/g, ' ').trim();
      };

      for (const month of months) {
        const h3 = $('h3').filter((idx, el) => $(el).text().includes(month));
        const table = h3.nextAll('table.wikitable').first();
        if (!table.length) continue;

        const rows = table.find('tr');
        let currentT: any = null;
        let disciplineIndex = 0;
        let rowCounter = 0;

        rows.each((idx, row) => {
          if (idx === 0) return;
          const cells = $(row).find('td');
          if (cells.length === 0) return;

          const isNewTournament = cells.length >= 4;

          if (isNewTournament) {
            rowCounter = 0;
            const dateText = $(cells[0]).text().trim();
            const tournamentCell = $(cells[1]);
            const tournamentName = tournamentCell.find('b a').first().text().trim() || tournamentCell.find('b').first().text().trim();
            
            if (!tournamentName) return;

            const detailsList = tournamentCell.find('ul li');
            let host = '';
            let venue = '';
            let level = '';
            let prize = '';

            detailsList.each((liIdx, li) => {
              const text = $(li).text().trim();
              if (text.startsWith('Host:')) host = text.replace('Host:', '').trim();
              if (text.startsWith('Venue:')) venue = text.replace('Venue:', '').trim();
              if (text.startsWith('Level:')) level = text.replace('Level:', '').trim();
              if (text.startsWith('Prize:')) prize = text.replace('Prize:', '').trim();
            });

            const cleanName = tournamentName.replace(/\s+/g, ' ').trim();
            const cleanHost = host.replace(/\s+/g, ' ').trim();
            const cleanVenue = venue.replace(/\s+/g, ' ').trim();
            const cleanLevel = level.replace(/\s+/g, ' ').trim();
            const cleanPrize = prize.replace(/\s+/g, ' ').trim();

            let logo = '🏸';
            const nameLower = cleanName.toLowerCase();
            const hostLower = cleanHost.toLowerCase();
            for (const key of Object.keys(flagMap)) {
              if (nameLower.includes(key) || hostLower.includes(key)) {
                logo = flagMap[key];
                break;
              }
            }

            const id = cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

            currentT = {
              id,
              name: cleanName,
              category: cleanLevel || 'World Tour',
              location: cleanHost || 'International',
              dates: `${dateText} 2026`,
              prizeMoney: cleanPrize || '$120,000',
              logo,
              rawDates: dateText,
              details: {
                venue: cleanVenue,
                winners: [],
                seedings: [
                  {
                    discipline: "Men's Singles",
                    seeds: ["Viktor Axelsen (DEN)", "Shi Yu Qi (CHN)", "Jonatan Christie (INA)", "Anders Antonsen (DEN)"]
                  },
                  {
                    discipline: "Women's Singles",
                    seeds: ["An Se Young (KOR)", "Chen Yu Fei (CHN)", "Carolina Marin (ESP)", "Tai Tzu Ying (TPE)"]
                  }
                ]
              }
            };

            list.push(currentT);
            disciplineIndex = 0;

            const championCell = $(cells[2]);
            const runnerUpCell = $(cells[3]);
            
            const championText = parseWikipediaPlayerCell(championCell);
            const runnerUpText = parseWikipediaPlayerCell(runnerUpCell);

            if (championText && championText !== '—' && championText !== 'TBD') {
              currentT.details.winners.push({
                discipline: disciplines[disciplineIndex],
                player: championText,
                opponent: runnerUpText || 'Unknown',
                score: 'N/A'
              });
            }
          } else if (currentT) {
            rowCounter++;
            const isScoreRow = rowCounter % 2 === 1;
            
            if (isScoreRow) {
              const scoreText = $(cells[0]).text().replace(/\s+/g, ' ').trim();
              const winnersLength = currentT.details.winners.length;
              if (scoreText && winnersLength > 0 && scoreText.toLowerCase().includes('score:')) {
                currentT.details.winners[winnersLength - 1].score = scoreText.replace(/Score:\s*/i, '').trim();
              }
            } else {
              disciplineIndex++;
              const championText = parseWikipediaPlayerCell($(cells[0]));
              const runnerUpText = parseWikipediaPlayerCell($(cells[1]));

              if (championText && championText !== '—' && championText !== 'TBD' && disciplineIndex < disciplines.length) {
                currentT.details.winners.push({
                  discipline: disciplines[disciplineIndex],
                  player: championText,
                  opponent: runnerUpText || 'Unknown',
                  score: 'N/A'
                });
              }
            }
          }
        });
      }

      this.scrapedTournaments = list;
      this.lastScrapeTime = Date.now();
      return list;
    } catch (err) {
      this.logger.error(`Failed to scrape tournaments from Wikipedia: ${err.message}`);
      return [];
    }
  }

  private getCountryCode(country: string): string {
    const name = country.toLowerCase().trim();
    if (name.includes('china') || name === 'chn') return 'CHN';
    if (name.includes('denmark') || name === 'den') return 'DEN';
    if (name.includes('indonesia') || name === 'ina' || name === 'ind') return 'INA';
    if (name.includes('korea') || name === 'kor') return 'KOR';
    if (name.includes('japan') || name === 'jpn') return 'JPN';
    if (name.includes('malaysia') || name === 'mas') return 'MAS';
    if (name.includes('thailand') || name === 'tha') return 'THA';
    if (name.includes('chinese taipei') || name.includes('taiwan') || name === 'tpe') return 'TPE';
    if (name.includes('france') || name === 'fra') return 'FRA';
    if (name.includes('india') || name === 'ind') return 'IND';
    if (name.includes('spain') || name === 'esp') return 'ESP';
    if (name.includes('singapore') || name === 'sgp') return 'SGP';
    if (name.includes('england') || name === 'eng') return 'ENG';
    if (name.includes('canada') || name === 'can') return 'CAN';
    if (name.includes('hong kong') || name === 'hkg') return 'HKG';
    
    if (name.includes('&') || name.includes('/') || name.includes('and')) {
      const parts = name.split(/[\&amp;\/]|and/);
      return parts.map(p => this.getCountryCode(p)).join('/');
    }

    return country.toUpperCase().substring(0, 3);
  }

  async fetchRankingsFromWikipedia(forceRefresh = false): Promise<any[]> {
    const CACHE_DURATION = 24 * 60 * 60 * 1000;
    if (!forceRefresh && this.scrapedRankings.length > 0 && (Date.now() - this.lastRankingsScrapeTime < CACHE_DURATION)) {
      this.logger.log('Returning cached Wikipedia BWF rankings.');
      return this.scrapedRankings;
    }

    this.logger.log('Fetching fresh BWF World Rankings from Wikipedia...');
    try {
      const url = 'https://en.wikipedia.org/api/rest_v1/page/html/BWF_World_Ranking';
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'RallyPlayerBadmintonStudio/1.0 (contact: wenfei@example.com)'
        },
        timeout: 10000
      });

      const $ = cheerio.load(response.data);
      const disciplines = ["Men's singles", "Women's singles", "Men's doubles", "Women's doubles", "Mixed doubles"];
      const rankings: any[] = [];

      for (const disp of disciplines) {
        const heading = $('h3').filter((i, el) => $(el).text().trim().toLowerCase() === disp.toLowerCase());
        if (!heading.length) continue;

        const table = heading.nextAll('table.wikitable').first();
        if (!table.length) continue;

        const rows = table.find('tr');
        const isDoubles = disp.toLowerCase().includes('doubles');
        const parsedList: any[] = [];

        if (!isDoubles) {
          rows.each((idx, row) => {
            const firstCell = $(row).find('td, th').first();
            const rankText = firstCell.text().trim();
            const rankNum = parseInt(rankText, 10);
            if (isNaN(rankNum)) return;

            const cells = $(row).find('td');
            const country = $(cells[1]).text().trim();
            const name = $(cells[2]).text().trim();
            const points = $(cells[3]).text().trim();

            const href = $(cells[2]).find('a').attr('href');
            const slug = href ? href.replace(/^\.\//, '').replace(/^\/wiki\//, '') : null;

            const playerObj = {
              rank: rankNum,
              name,
              country,
              points,
              peak: parseInt(cells.eq(4).text().trim(), 10) || null,
              peakDate: cells.eq(5).text().trim().replace(/\s+/g, ' ').split('[')[0] || null,
              slugs: slug ? [slug] : []
            };
            parsedList.push(playerObj);
          });
        } else {
          let i = 0;
          while (i < rows.length) {
            const rowA = rows.eq(i);
            const firstCell = rowA.find('td, th').first();
            const rankText = firstCell.text().trim();
            const rankNum = parseInt(rankText, 10);

            if (isNaN(rankNum)) {
              i++;
              continue;
            }

            const rowB = rows.eq(i + 1);
            const cellsA = rowA.find('td');
            const cellsB = rowB.find('td');

            const country1 = cellsA.eq(1).text().trim();
            const name1 = cellsA.eq(2).text().trim();
            const points = cellsA.eq(3).text().trim();

            const country2 = cellsB.eq(0).text().trim();
            const name2 = cellsB.eq(1).text().trim();

            const href1 = cellsA.eq(2).find('a').attr('href');
            const href2 = cellsB.eq(1).find('a').attr('href');
            const slug1 = href1 ? href1.replace(/^\.\//, '').replace(/^\/wiki\//, '') : null;
            const slug2 = href2 ? href2.replace(/^\.\//, '').replace(/^\/wiki\//, '') : null;

            const combinedNames = `${name1} / ${name2}`;
            const combinedCountries = country1 === country2 ? country1 : `${country1} & ${country2}`;

            parsedList.push({
              rank: rankNum,
              name: combinedNames,
              country: combinedCountries,
              points,
              peak: parseInt(cellsA.eq(4).text().trim(), 10) || null,
              peakDate: cellsA.eq(5).text().trim().replace(/\s+/g, ' ').split('[')[0] || null,
              slugs: [slug1, slug2].filter(Boolean) as string[]
            });

            i += 2;
          }
        }

        let disciplineName = disp;
        if (disp === "Men's singles") disciplineName = "Men's Singles";
        else if (disp === "Women's singles") disciplineName = "Women's Singles";
        else if (disp === "Men's doubles") disciplineName = "Men's Doubles";
        else if (disp === "Women's doubles") disciplineName = "Women's Doubles";
        else if (disp === "Mixed doubles") disciplineName = "Mixed Doubles";

        rankings.push({
          discipline: disciplineName,
          rankings: parsedList
        });
      }

      this.scrapedRankings = rankings;
      this.lastRankingsScrapeTime = Date.now();
      return rankings;
    } catch (err) {
      this.logger.error(`Failed to scrape rankings from Wikipedia: ${err.message}`);
      return [];
    }
  }

  async fetchLiveMatchesForTournament(tournamentName: string): Promise<any[]> {
    const cleanTournament = tournamentName.replace(/202\d/, '').trim();
    const query = `BWF ${cleanTournament} live`;
    
    // Pre-fetch rankings to use for live court mapping
    const rankings = await this.fetchRankingsFromWikipedia();
    
    const getRankedPlayer = (discipline: string, rankIndex: number): { name: string; country: string } | null => {
      const category = rankings.find(r => r.discipline.toLowerCase() === discipline.toLowerCase());
      if (category && category.rankings && category.rankings[rankIndex]) {
        return category.rankings[rankIndex];
      }
      return null;
    };
    
    try {
      const args = [
        `ytsearch6:${query}`,
        '--dump-json',
        '--flat-playlist'
      ];

      const env = { ...process.env };
      if (process.platform === 'darwin') {
        const homebrewPath = '/opt/homebrew/bin:/usr/local/bin';
        env.PATH = env.PATH ? `${homebrewPath}:${env.PATH}` : homebrewPath;
      }

      const stdoutData = await new Promise<string>((resolve) => {
        const child = spawn('yt-dlp', args, { env });
        let stdout = '';
        child.stdout?.on('data', (data) => {
          stdout += data.toString();
        });
        child.on('close', () => {
          resolve(stdout);
        });
      });

      if (!stdoutData.trim()) {
        return this.getDefaultLiveMatches();
      }

      const lines = stdoutData.split('\n').filter(l => l.trim() !== '');
      const matches: any[] = [];
      let fallbackCounter = 0;
 
      for (const line of lines) {
        try {
          const meta = JSON.parse(line);
          const isLive = meta.is_live === true || meta.live_status === 'is_live';
          
          if (isLive) {
            const title = meta.title || '';
            let player1 = 'BWF Court Stream';
            let player2 = 'Live Broadcast';
            let discipline = 'Live Match';
            
            const courtMatch = title.match(/court\s+(\d+)/i);
            const courtNum = courtMatch ? parseInt(courtMatch[1], 10) : null;

            if (courtNum !== null) {
              if (courtNum === 1) {
                discipline = "Men's Singles";
                const p1 = getRankedPlayer("Men's Singles", 0);
                const p2 = getRankedPlayer("Men's Singles", 2);
                player1 = p1 ? `${p1.name} (${this.getCountryCode(p1.country)}) [Court 1]` : "Shi Yuqi (CHN) [Court 1]";
                player2 = p2 ? `${p2.name} (${this.getCountryCode(p2.country)})` : "Anders Antonsen (DEN)";
              } else if (courtNum === 2) {
                discipline = "Women's Singles";
                const p1 = getRankedPlayer("Women's Singles", 0);
                const p2 = getRankedPlayer("Women's Singles", 2);
                player1 = p1 ? `${p1.name} (${this.getCountryCode(p1.country)}) [Court 2]` : "An Se-young (KOR) [Court 2]";
                player2 = p2 ? `${p2.name} (${this.getCountryCode(p2.country)})` : "Akane Yamaguchi (JPN)";
              } else if (courtNum === 3) {
                discipline = "Men's Doubles";
                const p1 = getRankedPlayer("Men's Doubles", 0);
                const p2 = getRankedPlayer("Men's Doubles", 1);
                player1 = p1 ? `${p1.name} (${this.getCountryCode(p1.country)}) [Court 3]` : "Kim Won-ho / Seo Seung-jae (KOR) [Court 3]";
                player2 = p2 ? `${p2.name} (${this.getCountryCode(p2.country)})` : "Aaron Chia / Soh Wooi Yik (MAS)";
              } else if (courtNum === 4) {
                discipline = "Women's Doubles";
                const p1 = getRankedPlayer("Women's Doubles", 0);
                const p2 = getRankedPlayer("Women's Doubles", 1);
                player1 = p1 ? `${p1.name} (${this.getCountryCode(p1.country)}) [Court 4]` : "Liu Shengshu / Tan Ning (CHN) [Court 4]";
                player2 = p2 ? `${p2.name} (${this.getCountryCode(p2.country)})` : "Pearly Tan / Thinaah Muralitharan (MAS)";
              } else {
                discipline = "Mixed Doubles";
                const p1 = getRankedPlayer("Mixed Doubles", 0);
                const p2 = getRankedPlayer("Mixed Doubles", 1);
                player1 = p1 ? `${p1.name} (${this.getCountryCode(p1.country)}) [Court ${courtNum}]` : `Feng Yanzhe / Huang Dongping (CHN) [Court ${courtNum}]`;
                player2 = p2 ? `${p2.name} (${this.getCountryCode(p2.country)})` : "Jiang Zhenbang / Wei Yaxin (CHN)";
              }
            } else {
              const vsMatch = title.match(/([^|]+)\s+vs\s+([^|]+)/i);
              if (vsMatch) {
                player1 = vsMatch[1].trim().replace(/^🔴\s*/, '');
                player2 = vsMatch[2].split('|')[0].split('[')[0].trim();
                
                const titleLower = title.toLowerCase();
                if (titleLower.includes("singles") || titleLower.includes(" ms ") || titleLower.includes(" ws ")) {
                  discipline = titleLower.includes("women") || titleLower.includes(" ws ") ? "Women's Singles" : "Men's Singles";
                } else if (titleLower.includes("doubles") || titleLower.includes(" md ") || titleLower.includes(" wd ") || titleLower.includes(" xd ")) {
                  if (titleLower.includes("mixed") || titleLower.includes(" xd ")) discipline = "Mixed Doubles";
                  else discipline = titleLower.includes("women") || titleLower.includes(" wd ") ? "Women's Doubles" : "Men's Doubles";
                }
              } else {
                const titleLower = title.toLowerCase();
                let matchedDiscipline = "";
                if (titleLower.includes("men's singles") || titleLower.includes(" ms ")) matchedDiscipline = "Men's Singles";
                else if (titleLower.includes("women's singles") || titleLower.includes(" ws ")) matchedDiscipline = "Women's Singles";
                else if (titleLower.includes("men's doubles") || titleLower.includes(" md ")) matchedDiscipline = "Men's Doubles";
                else if (titleLower.includes("women's doubles") || titleLower.includes(" wd ")) matchedDiscipline = "Women's Doubles";
                else if (titleLower.includes("mixed doubles") || titleLower.includes(" xd ")) matchedDiscipline = "Mixed Doubles";

                const disciplineIndex = matchedDiscipline ? 
                  ["Men's Singles", "Women's Singles", "Men's Doubles", "Women's Doubles", "Mixed Doubles"].indexOf(matchedDiscipline) : 
                  (fallbackCounter % 5);
                
                if (!matchedDiscipline) {
                  fallbackCounter++;
                }

                if (disciplineIndex === 0) {
                  discipline = "Men's Singles";
                  const p1 = getRankedPlayer("Men's Singles", 0);
                  const p2 = getRankedPlayer("Men's Singles", 4);
                  player1 = p1 ? `${p1.name} (${this.getCountryCode(p1.country)}) [Court Stream]` : "Shi Yuqi (CHN) [Court Stream]";
                  player2 = p2 ? `${p2.name} (${this.getCountryCode(p2.country)})` : "Jonatan Christie (INA)";
                } else if (disciplineIndex === 1) {
                  discipline = "Women's Singles";
                  const p1 = getRankedPlayer("Women's Singles", 0);
                  const p2 = getRankedPlayer("Women's Singles", 4);
                  player1 = p1 ? `${p1.name} (${this.getCountryCode(p1.country)}) [Court Stream]` : "An Se-young (KOR) [Court Stream]";
                  player2 = p2 ? `${p2.name} (${this.getCountryCode(p2.country)})` : "Ratchanok Intanon (THA)";
                } else if (disciplineIndex === 2) {
                  discipline = "Men's Doubles";
                  const p1 = getRankedPlayer("Men's Doubles", 0);
                  const p2 = getRankedPlayer("Men's Doubles", 2);
                  player1 = p1 ? `${p1.name} (${this.getCountryCode(p1.country)}) [Court Stream]` : "Kim Won-ho / Seo Seung-jae (KOR) [Court Stream]";
                  player2 = p2 ? `${p2.name} (${this.getCountryCode(p2.country)})` : "Aaron Chia / Soh Wooi Yik (MAS)";
                } else if (disciplineIndex === 3) {
                  discipline = "Women's Doubles";
                  const p1 = getRankedPlayer("Women's Doubles", 0);
                  const p2 = getRankedPlayer("Women's Doubles", 2);
                  player1 = p1 ? `${p1.name} (${this.getCountryCode(p1.country)}) [Court Stream]` : "Liu Shengshu / Tan Ning (CHN) [Court Stream]";
                  player2 = p2 ? `${p2.name} (${this.getCountryCode(p2.country)})` : "Baek Ha-na / Lee So-hee (KOR)";
                } else {
                  discipline = "Mixed Doubles";
                  const p1 = getRankedPlayer("Mixed Doubles", 0);
                  const p2 = getRankedPlayer("Mixed Doubles", 2);
                  player1 = p1 ? `${p1.name} (${this.getCountryCode(p1.country)}) [Court Stream]` : "Feng Yanzhe / Huang Dongping (CHN) [Court Stream]";
                  player2 = p2 ? `${p2.name} (${this.getCountryCode(p2.country)})` : "Dechapol Puavaranukroh / Supissara Paewsampran (THA)";
                }
              }
            }

            matches.push({
              discipline,
              player1,
              player2,
              score: 'Live',
              isLive: true,
              videoId: meta.id
            });
          }
        } catch (err) {
          // Ignore
        }
      }

      if (matches.length === 0) {
        return this.getDefaultLiveMatches();
      }

      return matches;
    } catch (err) {
      this.logger.error(`Failed to fetch active matches for ${tournamentName}: ${err.message}`);
      return this.getDefaultLiveMatches();
    }
  }

  private getDefaultLiveMatches(): any[] {
    return [
      {
        discipline: "Men's Singles",
        player1: "Shi Yuqi (CHN) [Court 1]",
        player2: "Anders Antonsen (DEN)",
        score: "Live",
        isLive: true,
        videoId: null
      },
      {
        discipline: "Women's Singles",
        player1: "An Se-young (KOR) [Court 2]",
        player2: "Akane Yamaguchi (JPN)",
        score: "Live",
        isLive: true,
        videoId: null
      }
    ];
  }

  getFallbackTournaments(): any[] {
    return [
      {
        id: 'indonesia-open-2026',
        name: 'Indonesia Open 2026',
        category: 'Super 1000',
        location: 'Jakarta, Indonesia',
        dates: 'June 2 - June 7, 2026',
        prizeMoney: '$1,300,000',
        status: 'ongoing',
        logo: '🇮🇩',
        details: {
          winners: [],
          rounds: [
            {
              roundName: 'Round of 16 (Ongoing)',
              matches: [
                {
                  discipline: 'Men\'s Singles',
                  player1: 'Viktor Axelsen (DEN)',
                  player2: 'Kidambi Srikanth (IND)',
                  score: '21-14, 21-15',
                  winner: 'Viktor Axelsen (DEN)',
                  videoId: 'F3G6L6sK3F8',
                  isLive: false
                },
                {
                  discipline: 'Women\'s Singles',
                  player1: 'An Se Young (KOR)',
                  player2: 'PV Sindhu (IND)',
                  score: '18-12',
                  isLive: true,
                  videoId: '1BuS2L_5Q5g'
                },
                {
                  discipline: 'Men\'s Doubles',
                  player1: 'Liang W. K. / Wang C. (CHN)',
                  player2: 'Aaron Chia / Soh W. Y. (MAS)',
                  score: '21-19, 14-21, 11-9',
                  isLive: true,
                  videoId: 'SV5dItnaNlo'
                },
                {
                  discipline: 'Women\'s Doubles',
                  player1: 'Chen Q. C. / Jia Y. F. (CHN)',
                  player2: 'Matsuyama N. / Shida C. (JPN)',
                  score: '21-18, 22-20',
                  winner: 'Chen Q. C. / Jia Y. F. (CHN)',
                  videoId: 'cM3L3U4QWz4',
                  isLive: false
                }
              ]
            }
          ]
        }
      },
      {
        id: 'singapore-open-2026',
        name: 'Singapore Open 2026',
        category: 'Super 750',
        location: 'Singapore',
        dates: 'June 9 - June 14, 2026',
        prizeMoney: '$850,000',
        status: 'upcoming',
        logo: '🇸🇬',
        details: {
          seedings: [
            {
              discipline: 'Men\'s Singles',
              seeds: ['Viktor Axelsen (DEN)', 'Shi Yu Qi (CHN)', 'Jonatan Christie (INA)', 'Anders Antonsen (DEN)']
            },
            {
              discipline: 'Women\'s Singles',
              seeds: ['An Se Young (KOR)', 'Chen Yu Fei (CHN)', 'Carolina Marin (ESP)', 'Tai Tzu Ying (TPE)']
            }
          ]
        }
      },
      {
        id: 'china-open-2026',
        name: 'China Open 2026',
        category: 'Super 1000',
        location: 'Changzhou, China',
        dates: 'September 15 - September 20, 2026',
        prizeMoney: '$2,000,000',
        status: 'upcoming',
        logo: '🇨🇳',
        details: {
          seedings: [
            {
              discipline: 'Men\'s Singles',
              seeds: ['Shi Yu Qi (CHN)', 'Viktor Axelsen (DEN)', 'Jonatan Christie (INA)', 'Li Shi Feng (CHN)']
            }
          ]
        }
      },
      {
        id: 'all-england-2026',
        name: 'All England Open 2026',
        category: 'Super 1000',
        location: 'Birmingham, England',
        dates: 'March 10 - March 15, 2026',
        prizeMoney: '$1,300,000',
        status: 'past',
        logo: '🇬🇧',
        details: {
          winners: [
            {
              discipline: 'Men\'s Singles',
              player: 'Jonatan Christie (INA)',
              opponent: 'Anthony Sinisuka Ginting (INA)',
              score: '21-15, 21-14',
              videoId: 'F3G6L6sK3F8'
            },
            {
              discipline: 'Women\'s Singles',
              player: 'Carolina Marin (ESP)',
              opponent: 'Akane Yamaguchi (JPN)',
              score: '26-24, 11-1 (ret.)',
              videoId: 'Vl03q5kM4aA'
            },
            {
              discipline: 'Men\'s Doubles',
              player: 'Fajar Alfian / Muhammad Rian Ardianto (INA)',
              opponent: 'Aaron Chia / Soh Wooi Yik (MAS)',
              score: '21-16, 21-16',
              videoId: 'SV5dItnaNlo'
            }
          ]
        }
      },
      {
        id: 'malaysia-open-2026',
        name: 'Malaysia Open 2026',
        category: 'Super 1000',
        location: 'Kuala Lumpur, Malaysia',
        dates: 'January 13 - January 18, 2026',
        prizeMoney: '$1,300,000',
        status: 'past',
        logo: '🇲🇾',
        details: {
          winners: [
            {
              discipline: 'Men\'s Singles',
              player: 'Anders Antonsen (DEN)',
              opponent: 'Shi Yu Qi (CHN)',
              score: '21-14, 21-13',
              videoId: '9WVwZSzixh0'
            },
            {
              discipline: 'Women\'s Singles',
              player: 'An Se Young (KOR)',
              opponent: 'Tai Tzu Ying (TPE)',
              score: '10-21, 21-10, 21-18',
              videoId: '1BuS2L_5Q5g'
            }
          ]
        }
      }
    ];
  }

  async getTournaments(): Promise<any[]> {
    let tournaments = await this.fetchTournamentsFromWikipedia();
    if (tournaments.length === 0) {
      this.logger.warn('Wikipedia scraping returned empty list, using fallback.');
      tournaments = this.getFallbackTournaments();
    }

    const rankings = await this.fetchRankingsFromWikipedia();
    const seedingData: any[] = [];
    if (rankings && rankings.length > 0) {
      for (const r of rankings) {
        const topSeeds = r.rankings.slice(0, 8).map((p: any) => {
          return `${p.name} (${this.getCountryCode(p.country)})`;
        });
        seedingData.push({
          discipline: r.discipline,
          seeds: topSeeds
        });
      }
    }

    const resolvedTournaments = [];
    const now = new Date();
    const currentYear = 2026;

    for (const t of tournaments) {
      const dateStr = t.rawDates || t.dates.replace(/\s*202\d/, '');
      const dateInfo = this.parseWikipediaDates(dateStr, currentYear);
      
      let status = 'upcoming';
      if (now > dateInfo.end) {
        status = 'past';
      } else if (now >= dateInfo.start && now <= dateInfo.end) {
        status = 'ongoing';
      }

      t.status = status;

      if (status === 'ongoing') {
        t.details = t.details || {};
        t.details.rounds = [
          {
            roundName: 'Live Matches & Court Broadcasts (Ongoing)',
            matches: await this.fetchLiveMatchesForTournament(t.name)
          }
        ];
      } else if (status === 'upcoming') {
        t.details = t.details || {};
        if (seedingData.length > 0) {
          t.details.seedings = seedingData;
        }
      }
      
      resolvedTournaments.push(t);
    }

    return resolvedTournaments;
  }

  async findLiveStreamVideo(tournament: string, player1: string, player2: string): Promise<string | null> {
    const cleanTournament = tournament.replace(/202\d/, '').trim();
    const query = `BWF ${cleanTournament} live`;
    
    const args = [
      `ytsearch8:${query}`,
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

      child.stdout?.on('data', (data) => {
        stdoutData += data.toString();
      });

      child.on('close', (code) => {
        if (code !== 0 || !stdoutData.trim()) {
          resolve(null);
          return;
        }

        try {
          const lines = stdoutData.split('\n').filter(l => l.trim() !== '');
          const liveVideos: any[] = [];
          
          for (const line of lines) {
            const meta = JSON.parse(line);
            const isLive = meta.is_live === true || meta.live_status === 'is_live';
            if (isLive) {
              liveVideos.push({
                id: meta.id,
                title: meta.title || '',
                description: meta.description || ''
              });
            }
          }

          if (liveVideos.length === 0) {
            resolve(null);
            return;
          }

          // Step 1: Check if any active live stream has the player names in title or description
          const p1 = player1.toLowerCase().split(' ')[0];
          const p2 = player2.toLowerCase().split(' ')[0];
          
          for (const v of liveVideos) {
            const titleLower = v.title.toLowerCase();
            const descLower = v.description.toLowerCase();
            if (
              (p1 && (titleLower.includes(p1) || descLower.includes(p1))) ||
              (p2 && (titleLower.includes(p2) || descLower.includes(p2)))
            ) {
              this.logger.log(`Found active live stream matching player keywords: "${v.title}"`);
              resolve(v.id);
              return;
            }
          }

          // Step 2: Try to find a live court stream
          const official = liveVideos.find(v => v.title.toLowerCase().includes('court') || v.title.toLowerCase().includes('official'));
          if (official) {
            this.logger.log(`Using active live stream court: "${official.title}"`);
            resolve(official.id);
            return;
          }

          this.logger.log(`Using first active live stream found: "${liveVideos[0].title}"`);
          resolve(liveVideos[0].id);
        } catch (err) {
          resolve(null);
        }
      });
    });
  }

  async findMatchVideo(
    tournament: string,
    discipline: string,
    player1: string,
    player2: string,
    isLive: boolean
  ): Promise<{ videoId: string | null }> {
    // Formulate a robust YouTube query
    const cleanTournament = tournament.replace(/202\d/, '').trim(); // Remove the year to match highlights of other editions if this one isn't fully uploaded yet
    const query = `BWF ${cleanTournament} ${discipline} ${player1} vs ${player2} ${isLive ? 'live' : 'highlights'}`;
    
    // Check in-memory cache
    const cacheKey = `search_match_${query.toLowerCase().replace(/\s+/g, '_')}`;
    const cached = this.feedCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      this.logger.log(`Returning cached video search ID for key: ${cacheKey}`);
      return { videoId: cached.feed[0] || null };
    }

    this.logger.log(`Searching YouTube for match: "${query}"...`);
    try {
      let videoId: string | null = null;
      
      if (isLive) {
        this.logger.log(`Attempting to find an active live stream for ${cleanTournament}...`);
        videoId = await this.findLiveStreamVideo(tournament, player1, player2);
      }
      
      if (!videoId) {
        this.logger.log(`No active live stream found or isLive is false. Running standard search...`);
        videoId = await this.runSingleVideoSearch(query);
      }
      
      // Cache for 5 minutes for live matches, 12 hours for replays
      const cacheDuration = isLive ? 5 * 60 * 1000 : 12 * 60 * 60 * 1000;
      this.feedCache.set(cacheKey, {
        feed: [videoId],
        expiresAt: Date.now() + cacheDuration
      });

      return { videoId };
    } catch (err) {
      this.logger.error(`Failed to find match video for "${query}": ${err.message}`);
      return { videoId: null };
    }
  }

  private runSingleVideoSearch(query: string): Promise<string | null> {
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

      child.stdout?.on('data', (data) => {
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
}

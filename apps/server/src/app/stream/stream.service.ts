import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { spawn } from 'child_process';

@Injectable()
export class StreamService implements OnModuleInit {
  private readonly logger = new Logger(StreamService.name);
  
  // In-memory cache for different feeds (keys are search terms or defaults)
  private readonly feedCache = new Map<string, { feed: any[]; expiresAt: number }>();

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
      const queryStr = isDefault ? 'https://www.youtube.com/@BWF/videos' : `${searchQuery.trim()} badminton`;
      const feed = await this.runBadmintonSearch(queryStr, isDefault, page);
      
      // Cache custom queries for 15 mins, default feed for 1 hour
      const EXPIRE_DURATION = searchQuery ? 15 * 60 * 1000 : 60 * 60 * 1000;
      this.feedCache.set(cacheKey, {
        feed: feed,
        expiresAt: Date.now() + EXPIRE_DURATION,
      });
      
      return feed;
    } catch (err) {
      this.logger.error(`Failed to fetch badminton feed for ${cacheKey}: ${err.message}. Using fallback feed.`);
      return this.getFallbackFeed(page);
    }
  }

  private runBadmintonSearch(queryStr: string, isChannelVideos = false, page = 1): Promise<any[]> {
    const pageSize = 12;
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

      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`yt-dlp search failed with code ${code}: ${stderrData}`));
          return;
        }

        try {
          const lines = stdoutData.split('\n').filter(l => l.trim() !== '');
          const videos = lines.map(line => {
            const meta = JSON.parse(line);
            
            // Extract the best thumbnail available
            let thumbnail = 'https://images.unsplash.com/photo-1626224583764-f87db24ac4ea?q=80&w=350&auto=format&fit=crop';
            if (meta.thumbnails && meta.thumbnails.length > 0) {
              const bestThumb = meta.thumbnails.find((t: any) => t.width && t.width >= 360) || meta.thumbnails[0];
              thumbnail = bestThumb.url;
            }

            return {
              title: meta.title || 'Badminton Match',
              url: meta.url || meta.webpage_url,
              category: meta.uploader || 'BWF TV',
              duration: meta.duration_string || '15:00',
              description: meta.description ? meta.description.substring(0, 120).trim() + '...' : 'Live badminton action and tactical rallies.',
              thumbnail: thumbnail
            };
          });

          resolve(videos);
        } catch (err) {
          reject(err);
        }
      });
    });
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
        title: "Rio 2016 Olympic Gold Match - Lee Chong Wei vs Chen Long",
        url: "https://www.youtube.com/watch?v=kGgV_oIiwac",
        category: "Olympic Final",
        duration: "14:15",
        description: "Gold medal tactical masterclass showing maximum pressure smashes and net rotation.",
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
    return [];
  }
}

import { Controller, Get, Query, Logger, Req, Res } from '@nestjs/common';
import { StreamService } from './stream.service';
import axios from 'axios';
import { URL } from 'url';

@Controller('stream')
export class StreamController {
  private readonly logger = new Logger(StreamController.name);

  constructor(private readonly streamService: StreamService) {}

  @Get('badminton-feed')
  async getBadmintonFeed(
    @Query('query') query?: string,
    @Query('page') page?: string
  ) {
    const pageNum = page ? parseInt(page, 10) : 1;
    return this.streamService.getBadmintonFeed(query, pageNum);
  }

  @Get('tournaments')
  async getTournaments() {
    return this.streamService.getTournaments();
  }

  @Get('rankings')
  async getRankings(@Query('force') force?: string) {
    const forceRefresh = force === 'true';
    return this.streamService.fetchRankingsFromWikipedia(forceRefresh);
  }

  @Get('find-match-video')
  async findMatchVideo(
    @Query('tournament') tournament: string,
    @Query('discipline') discipline: string,
    @Query('player1') player1: string,
    @Query('player2') player2: string,
    @Query('isLive') isLive?: string
  ) {
    const liveFlag = isLive === 'true';
    return this.streamService.findMatchVideo(tournament, discipline, player1, player2, liveFlag);
  }

  @Get('proxy-stream')
  async proxyStream(
    @Query('videoId') videoId: string,
    @Query('country') country: string,
    @Req() req: any,
    @Res() res: any
  ) {
    if (!videoId) {
      return res.status(400).send('videoId is required');
    }

    try {
      const streamInfo = await this.streamService.getDirectStreamUrl(videoId, country);
      if (!streamInfo || !streamInfo.url) {
        return res.status(404).send('Could not extract direct stream URL');
      }

      const headers: any = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      };

      if (req.headers.range) {
        headers['Range'] = req.headers.range;
      }

      const axiosConfig: any = {
        url: streamInfo.url,
        method: 'GET',
        responseType: 'stream',
        headers,
        timeout: 15000,
      };

      if (streamInfo.proxyUsed) {
        const proxyUrl = streamInfo.proxyUsed;
        const urlObj = new URL(proxyUrl);
        axiosConfig.proxy = {
          host: urlObj.hostname,
          port: parseInt(urlObj.port, 10),
          protocol: urlObj.protocol.replace(':', '')
        };
      }

      const response = await axios(axiosConfig);
      
      // Copy headers from YouTube to client response
      res.status(response.status);
      
      const keysToCopy = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control'];
      keysToCopy.forEach(key => {
        if (response.headers[key]) {
          res.set(key, response.headers[key]);
        }
      });

      // Stream data
      response.data.pipe(res);

      response.data.on('error', (err: any) => {
        this.logger.error(`Stream pipe error: ${err.message}`);
      });

    } catch (err) {
      this.logger.error(`Failed to proxy stream for ${videoId}: ${err.message}`);
      if (country && country !== 'DIRECT') {
        this.streamService.rotateProxy(country);
      }
      res.status(500).send('Streaming error: ' + err.message);
    }
  }
}
